"""Local browser workspace and optional native tray. No privileged web endpoint."""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.resources
import json
import os
import secrets
import threading
import time
from urllib.parse import urlsplit, parse_qs
import webbrowser

from . import __version__
from .credentials import Authorities, system_read
from .paths import FileLock, atomic_json
from .recovery import Recovery
from .store import Store


class Beacon:
    def __init__(self, store=None, port=0):
        self.store = store or Store()
        self.authorities = Authorities(self.store)
        self.recovery = Recovery(self.store)
        self.token = secrets.token_urlsafe(32)
        self.cookie_name = "asip_"+secrets.token_hex(6)
        self.stopping = threading.Event()
        self.tray = None
        beacon = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "ASIP"
            def log_message(self,*_):
                pass

            def send(self,status,data,content_type="application/json",extra=None):
                raw = json.dumps(data,ensure_ascii=False).encode() if content_type=="application/json" else data
                self.send_response(status)
                self.send_header("Content-Type",content_type)
                self.send_header("Content-Length",str(len(raw)))
                self.send_header("Cache-Control","no-store")
                self.send_header("X-Content-Type-Options","nosniff")
                self.send_header("Referrer-Policy","no-referrer")
                self.send_header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
                for key,value in (extra or {}).items():
                    self.send_header(key,value)
                self.end_headers()
                self.wfile.write(raw)

            def local(self):
                # Exact Host protects against DNS rebinding. Reject browser cross-site requests.
                if self.headers.get("Host") not in (beacon.authority,beacon.localhost_authority):
                    self.send(403,{"error":"Invalid local host"}); return False
                origin = self.headers.get("Origin")
                if origin and origin not in (beacon.origin,beacon.localhost_origin):
                    self.send(403,{"error":"Cross-origin request rejected"}); return False
                if self.headers.get("Sec-Fetch-Site") in ("cross-site","same-site"):
                    self.send(403,{"error":"Cross-site request rejected"}); return False
                return True

            def authenticated(self):
                cookies = SimpleCookie()
                try:
                    cookies.load(self.headers.get("Cookie",""))
                    supplied = cookies.get(beacon.cookie_name)
                    return supplied is not None and secrets.compare_digest(supplied.value,beacon.token)
                except (ValueError,TypeError):
                    return False

            def do_GET(self):
                if not self.local():
                    return
                parsed = urlsplit(self.path)
                if parsed.path in ("/","/app.js","/app.css"):
                    file = {"/":"index.html","/app.js":"app.js","/app.css":"app.css"}[parsed.path]
                    kind = {"/":"text/html; charset=utf-8","/app.js":"text/javascript; charset=utf-8","/app.css":"text/css; charset=utf-8"}[parsed.path]
                    self.send(200,importlib.resources.files("memory").joinpath("assets",file).read_bytes(),kind)
                    return
                if not self.authenticated():
                    self.send(401,{"error":"Open ASIP from Beacon to connect this browser"}); return
                try:
                    query = {k:v[0] for k,v in parse_qs(parsed.query).items()}
                    if parsed.path=="/api/overview":
                        data = beacon.store.overview() | {"version":__version__,"health":"ready"}
                    elif parsed.path=="/api/project":
                        data = beacon.store.project(query["id"])
                    elif parsed.path=="/api/events":
                        data = beacon.store.events(**query)
                    elif parsed.path=="/api/connections":
                        data = beacon.authorities.list()
                    elif parsed.path=="/api/recovery":
                        data = {"records":beacon.recovery.list(),"limit":10,"linux":system_read("recovery")}
                    elif parsed.path=="/api/system":
                        data = {"brief":system_read("brief"),"changes":system_read("change",action="list",limit=20)}
                    elif parsed.path=="/api/integrations":
                        from .integrations import plan, AGENTS
                        data = {"agents":[plan(a) for a in AGENTS]}
                    elif parsed.path=="/api/doctor":
                        data = beacon.store.integrity()
                    else:
                        self.send(404,{"error":"Not found"}); return
                    self.send(200,data)
                except (ValueError,KeyError) as error:
                    from .privacy import clean
                    self.send(400,{"error":clean(str(error))})
                except Exception:
                    self.send(503,{"error":"ASIP could not read this view; run asip-memory doctor"})

            def do_POST(self):
                if not self.local():
                    return
                # JSON plus exact Origin are required even for the bootstrap exchange.
                if self.headers.get("Origin") not in (beacon.origin,beacon.localhost_origin) or self.headers.get("Content-Type","").split(";")[0]!="application/json":
                    self.send(403,{"error":"A same-origin JSON request is required"}); return
                try:
                    length = int(self.headers.get("Content-Length","0"))
                    if not 0<length<=65536:
                        self.send(413,{"error":"Request size is invalid"}); return
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body,dict):
                        raise ValueError("expected a JSON object")
                    if self.path=="/api/connect":
                        if not isinstance(body.get("token"),str) or not secrets.compare_digest(body["token"],beacon.token):
                            self.send(401,{"error":"Invalid local connection"}); return
                        self.send(200,{"connected":True},extra={"Set-Cookie":beacon.cookie_name+"="+beacon.token+"; HttpOnly; SameSite=Strict; Path=/"})
                        return
                    if not self.authenticated():
                        self.send(401,{"error":"Open ASIP from Beacon first"}); return
                    if self.path=="/api/project/register":
                        data = beacon.store.register(**body)
                    elif self.path=="/api/project/link":
                        data = beacon.store.link(**body)
                    elif self.path=="/api/intent/close":
                        data = beacon.store.close_intent(**body)
                    elif self.path=="/api/connections/configure":
                        data = beacon.authorities.configure(**body)
                    elif self.path=="/api/connections/grant":
                        data = beacon.authorities.grant(**body)
                    elif self.path=="/api/connections/remove":
                        data = beacon.authorities.remove(**body)
                    elif self.path=="/api/recovery/create":
                        data = beacon.recovery.checkpoint(body["reason"])
                    elif self.path=="/api/integrations/install":
                        from .integrations import install
                        data = install(body["agent"])
                    else:
                        self.send(404,{"error":"Not found"}); return
                    self.send(200,data)
                except (ValueError,KeyError,TypeError,RuntimeError,PermissionError) as error:
                    from .privacy import clean
                    self.send(400,{"error":clean(str(error))[:512]})
                except Exception:
                    self.send(503,{"error":"ASIP could not complete the local operation"})

        self.server = ThreadingHTTPServer(("127.0.0.1",port),Handler)
        self.server.daemon_threads = True
        self.authority = "127.0.0.1:"+str(self.server.server_port)
        self.origin = "http://"+self.authority
        self.localhost_authority = "localhost:"+str(self.server.server_port)
        self.localhost_origin = "http://"+self.localhost_authority

    @property
    def url(self):
        # Fragment never enters HTTP requests/access logs; the browser exchanges it then clears it.
        return self.origin+"/#"+self.token

    def status(self):
        overview = self.store.overview()
        recent = [s for s in overview["sessions"] if s["recent"] and s["agent"] in ("codex","claude-code","antigravity")]
        return {"pid":os.getpid(),"at":time.time(),"origin":self.origin,"url":self.url,
                "health":"ready","recent_agents":sorted({s["agent"] for s in recent}),
                "recent_sessions":len(recent),"unresolved":len(overview["unresolved"]),"version":__version__}

    def open(self,*_):
        webbrowser.open(self.url)

    def pulse(self):
        while not self.stopping.is_set():
            try:
                status = self.status()
                atomic_json(self.store.home/"beacon.json",status)
                if self.tray:
                    self.tray.title = "ASIP · Ready · "+str(status["recent_sessions"])+" recent sessions · "+str(status["unresolved"])+" unresolved"
                    self.tray.icon = tray_image(bool(status["recent_sessions"]))
            except Exception:
                # Do not claim service health when state cannot be read.
                atomic_json(self.store.home/"beacon.json",{"health":"unavailable","at":time.time(),"origin":self.origin,"url":self.url})
            self.stopping.wait(5)

    def stop(self,*_):
        self.stopping.set()
        self.server.shutdown()
        if self.tray:
            self.tray.stop()

    def serve(self,open_browser=False,tray=False):
        with FileLock(self.store.home/"beacon.lock"):
            threading.Thread(target=self.server.serve_forever,daemon=True).start()
            threading.Thread(target=self.pulse,daemon=True).start()
            if open_browser:
                self.open()
            print(json.dumps({"origin":self.origin,"health":"ready","state":str(self.store.home)}),flush=True)
            previous_signal=None
            if threading.current_thread() is threading.main_thread():
                import signal
                previous_signal=signal.signal(signal.SIGTERM,self.stop)
            try:
                if tray:
                    try:
                        import pystray
                        self.tray = pystray.Icon("ASIP",tray_image(False),"ASIP · Ready",menu=pystray.Menu(
                            pystray.MenuItem("Open ASIP",self.open,default=True),
                            pystray.MenuItem("Quit Beacon",self.stop)))
                        self.tray.run()
                    except Exception as error:
                        print("Native tray unavailable ("+type(error).__name__+"). Browser workspace remains available.",flush=True)
                        self.stopping.wait()
                else:
                    self.stopping.wait()
            except KeyboardInterrupt:
                pass
            finally:
                self.stopping.set()
                self.server.shutdown()
                self.server.server_close()
                (self.store.home/"beacon.json").unlink(missing_ok=True)
                if previous_signal is not None:
                    signal.signal(signal.SIGTERM,previous_signal)


def tray_image(active):
    from PIL import Image, ImageDraw
    image = Image.new("RGBA",(64,64),(0,0,0,0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4,4,60,60),radius=16,fill="#121c24")
    draw.line((17,45,30,17,44,45),fill="#c5e6df",width=6)
    draw.line((23,34,38,34),fill="#c5e6df",width=5)
    draw.ellipse((44,44,61,61),fill="#59d5b1" if active else "#78a5bf",outline="#121c24",width=2)
    return image


def existing(store,open_browser=False):
    path = store.home/"beacon.json"
    try:
        status = json.loads(path.read_text())
        if time.time()-status["at"]>15:
            return None
        from urllib.request import Request,urlopen
        req = Request(status["origin"]+"/",headers={"Host":urlsplit(status["origin"]).netloc})
        with urlopen(req,timeout=2) as response:
            if response.status!=200:
                return None
        if open_browser:
            webbrowser.open(status["url"])
        # Bootstrap token must stay in the private file, never status command output.
        return {k:v for k,v in status.items() if k!="url"}
    except (OSError,ValueError,KeyError):
        return None
