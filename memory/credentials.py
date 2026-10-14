"""Named API authority with OS vault storage and explicit project grants."""
import json
import os
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .paths import atomic_json
from .privacy import clean, digest

PROVIDERS = {
    "github": {"origin":"https://api.github.com", "env_var":"GH_TOKEN", "header":"Authorization", "prefix":"Bearer "},
    "google": {"origin":"https://www.googleapis.com", "env_var":"GOOGLE_ACCESS_TOKEN", "header":"Authorization", "prefix":"Bearer "},
    "gemini": {"origin":"https://generativelanguage.googleapis.com", "env_var":"GEMINI_API_KEY", "header":"x-goog-api-key", "prefix":""},
    "openai": {"origin":"https://api.openai.com", "env_var":"OPENAI_API_KEY", "header":"Authorization", "prefix":"Bearer "},
    "anthropic": {"origin":"https://api.anthropic.com", "env_var":"ANTHROPIC_API_KEY", "header":"x-api-key", "prefix":""},
    "typesafe": {"origin":"https://api.typesafe.ai", "env_var":"JEV_API_KEY", "header":"Authorization", "prefix":"Bearer "},
}
NAME = re.compile(r"[a-z][a-z0-9._-]{0,63}\Z")
ENV = re.compile(r"[A-Z][A-Z0-9_]*\Z")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        raise ValueError("API redirects are disabled to keep credentials on the configured origin")


def request_json(url, body=None, headers=None, method=None, timeout=30):
    req = Request(url, data=json.dumps(body).encode() if body is not None else None,
                  headers={"Accept":"application/json", "Content-Type":"application/json", **(headers or {})}, method=method)
    try:
        response = build_opener(NoRedirect).open(req, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(1024*1024+1)
        if len(raw) > 1024*1024:
            raise ValueError("API response exceeds 1MiB; request a smaller page")
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            data = {"message":"Non-JSON response omitted", "bytes":len(raw)}
        return {"status":response.status,"data":data}


def vault():
    try:
        import keyring
    except ImportError:
        raise RuntimeError("Install ASIP's credentials extra to use the OS credential vault") from None
    backend = keyring.get_keyring()
    # Never silently accept a plaintext fallback or a third-party chaining backend.
    supported = ("keyring.backends.SecretService", "keyring.backends.libsecret", "keyring.backends.macOS", "keyring.backends.Windows")
    if type(backend).__module__=="keyring.backends.chainer":
        native = [candidate for candidate in backend.backends if type(candidate).__module__ in supported]
        if native:
            backend = native[0]
    if type(backend).__module__ not in supported:
        raise RuntimeError("A native OS vault is required (Secret Service, Keychain or Windows Credential Manager)")
    return backend


class Authorities:
    def __init__(self, store):
        self.store = store
        self.path = store.home/"connections.json"

    def profiles(self):
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def configure(self, name, provider, value, label="", env_var=None, oauth=None):
        if not isinstance(name,str) or not NAME.fullmatch(name) or provider not in PROVIDERS:
            raise ValueError("choose a valid authority name and supported provider")
        if not isinstance(value,str) or not value.strip():
            raise ValueError("credential is empty")
        env_var = env_var or PROVIDERS[provider]["env_var"]
        if not ENV.fullmatch(env_var):
            raise ValueError("invalid environment variable")
        backend = vault()
        backend.set_password("ASIP", name, json.dumps({"value":value.strip(), **(oauth or {})}))
        # Configuration writes are serialized across browser/CLI processes.
        from .paths import FileLock
        with FileLock(self.store.home/"connections.lock"):
            profiles = self.profiles()
            profiles[name] = {"name":name,"provider":provider,"label":clean(label or name),"env_var":env_var,
                              "grants":profiles.get(name,{}).get("grants",[]),"state":"available","storage":"os-vault"}
            atomic_json(self.path,profiles)
        self.store.record("operator","connections","access.configured","Configured "+name,{"provider":provider})
        return profiles[name]

    def grant(self, name, project_id, allow=True):
        self.store.project(project_id)
        from .paths import FileLock
        with FileLock(self.store.home/"connections.lock"):
            profiles = self.profiles()
            if name not in profiles:
                raise ValueError("configure this connection first")
            grants = set(profiles[name].get("grants",[]))
            if allow:
                grants.add(project_id)
            else:
                grants.discard(project_id)
            profiles[name]["grants"] = sorted(grants)
            atomic_json(self.path,profiles)
        self.store.record("operator","connections","access.granted" if allow else "access.revoked",name,
                          {"authority":name}, project_id=project_id)
        return profiles[name]

    def remove(self, name):
        from .paths import FileLock
        with FileLock(self.store.home/"connections.lock"):
            profiles = self.profiles()
            if name not in profiles:
                raise ValueError("unknown authority")
            vault().delete_password("ASIP",name)
            profiles.pop(name)
            atomic_json(self.path,profiles)
        self.store.record("operator","connections","access.removed",name)
        return {"removed":name}

    def list(self):
        local = list(self.profiles().values())
        legacy = system_read("access", action="list")
        for p in legacy.get("authorities", legacy.get("access",[])):
            local.append({k:p.get(k) for k in ("name","label","env_var","state")} | {"storage":"linux-system"})
        return {"connections":local, "providers":list(PROVIDERS),
                "system_access":legacy.get("error") if "error" in legacy else "connected"}

    def resolve(self, name, intent_id):
        intent = self.store.intent(intent_id)
        if intent["status"] != "open":
            raise ValueError("API use requires an open intent")
        profiles = self.profiles()
        profile = profiles.get(name)
        if not profile or intent["project_id"] not in profile.get("grants",[]):
            raise PermissionError("The operator must grant this named connection to the intent's project")
        raw = vault().get_password("ASIP", name)
        if not raw:
            raise RuntimeError("Credential is missing from the OS vault; reconnect locally")
        credential = json.loads(raw)
        if credential.get("refresh_token") and credential.get("expires_at",0) < time.time()+60:
            result = oauth_post("https://oauth2.googleapis.com/token",{
                "client_id":credential["client_id"],"client_secret":credential.get("client_secret",""),
                "refresh_token":credential["refresh_token"],"grant_type":"refresh_token"})
            if not result.get("access_token"):
                raise RuntimeError("Google authorization needs reconnecting")
            credential.update(value=result["access_token"],expires_at=time.time()+result.get("expires_in",3600))
            vault().set_password("ASIP",name,json.dumps(credential))
        return profile, credential["value"], intent

    def audit(self,intent,kind,summary,data):
        # Attribute API use to the native agent/session that owns the intention.
        with self.store.connect(True) as db:
            item=self.store._append(db,kind,summary,data,intent["session_id"],intent["project_id"],intent["id"])
        return self.store.decode(item)

    def call(self, name, intent_id, path, method="GET", body=None):
        profile, value, intent = self.resolve(name,intent_id)
        provider = PROVIDERS[profile["provider"]]
        if method not in ("GET","POST","PUT","PATCH","DELETE"):
            raise ValueError("unsupported HTTP method")
        if not isinstance(path,str) or not path.startswith("/") or path.startswith("//") or urlsplit(path).netloc or "\\" in path:
            raise ValueError("API path must be relative to the provider origin")
        headers = {provider["header"]:provider["prefix"]+value}
        if profile["provider"] == "anthropic":
            headers["anthropic-version"] = "2023-06-01"
        data = {"authority":name,"method":method,"path":clean(path),"request_sha256":digest(body)}
        started = self.audit(intent,"api.started",method+" "+clean(path),data)
        try:
            result = request_json(provider["origin"]+path,body,headers,method)
            # Mask the exact credential even if a provider echoes it unexpectedly.
            result = json.loads(json.dumps(clean(result)).replace(value,"[redacted]"))
            self.audit(intent,"api.finished" if result["status"]<400 else "api.failed",str(result["status"]),
                       {**data,"status":result["status"],"operation":started["id"]})
            return result
        except Exception:
            self.audit(intent,"api.failed","API request failed",{**data,"operation":started["id"]})
            raise RuntimeError("API request failed; inspect connection and provider availability") from None

    def use(self, name, intent_id, argv, cwd=None, timeout=300):
        profile, value, intent = self.resolve(name,intent_id)
        if not isinstance(argv,list) or not argv or not all(isinstance(v,str) and "\0" not in v for v in argv):
            raise ValueError("argv must be a nonempty list of strings")
        timeout = max(1,min(int(timeout),300))
        data = {"authority":name,"argv_sha256":digest(argv),"cwd":cwd,"intent":intent_id}
        started = self.audit(intent,"access.started","Named credential child",data)
        try:
            from .process import execute
            result = execute(argv,cwd=cwd,env={**os.environ,profile["env_var"]:value},timeout=timeout)
            # No raw argv/output is persisted; values never return in tool results.
            response = {"exit":result["exit"],"stdout":result.get("stdout",{}).get("text","").replace(value,"[redacted]"),
                        "stderr":result.get("stderr",{}).get("text","").replace(value,"[redacted]"),
                        "timed_out":result["timed_out"],"output_limited":result["output_limited"],
                        "capture_incomplete":result["capture_incomplete"],
                        "truncated":any(result.get(s,{}).get("truncated") for s in ("stdout","stderr"))}
            self.audit(intent,"access.finished" if result["exit"]==0 and not result["capture_incomplete"] else "access.failed",str(result["exit"]),
                              {**data,"exit":result["exit"],"operation":started["id"],"stdout_sha256":result.get("stdout",{}).get("sha256"),
                               "timed_out":result["timed_out"],"output_limited":result["output_limited"]})
            return clean(response)
        except Exception:
            self.audit(intent,"access.failed","Credential child failed or timed out",{**data,"operation":started["id"]})
            raise RuntimeError("Credential child failed or timed out; effects may be partial") from None


def system_read(op, **fields):
    if not sys.platform.startswith("linux"):
        return {"error":"Linux administration adapter is unavailable on this OS"}
    try:
        from core.protocol import UnixClient, READ_ONLY_SOCKET
        reply = UnixClient(READ_ONLY_SOCKET,timeout=5).call({"op":op, **fields}).response
        if reply.get("exit"):
            return {"error":"ASIP system inspection is unavailable"}
        return reply.get("data",{})
    except (OSError,ValueError,ImportError,ConnectionError):
        return {"error":"ASIP Linux system service is not connected"}


def oauth_post(url, fields):
    req = Request(url,data=urlencode(fields).encode(),headers={"Accept":"application/json"})
    try:
        with build_opener(NoRedirect).open(req,timeout=30) as response:
            return json.loads(response.read(65536))
    except HTTPError as error:
        with error:
            return json.loads(error.read(65536))


def github_login(authorities, name, client_id, scopes="read:user"):
    import webbrowser
    # A registered OAuth app with Device Flow enabled is required; no client secret.
    vault()
    response = oauth_post("https://github.com/login/device/code",{"client_id":client_id,"scope":scopes})
    if not response.get("device_code"):
        raise RuntimeError("GitHub device flow unavailable; check the OAuth app's Device Flow setting")
    print("Open "+response["verification_uri"]+" and enter "+response["user_code"], file=sys.stderr)
    webbrowser.open(response["verification_uri"])
    interval = max(5,response.get("interval",5))
    deadline = time.monotonic()+min(response.get("expires_in",900),900)
    while time.monotonic()<deadline:
        time.sleep(interval)
        result = oauth_post("https://github.com/login/oauth/access_token",{
            "client_id":client_id,"device_code":response["device_code"],
            "grant_type":"urn:ietf:params:oauth:grant-type:device_code"})
        if result.get("access_token"):
            return authorities.configure(name,"github",result["access_token"],"GitHub OAuth",oauth={"scopes":result.get("scope",scopes)})
        if result.get("error") == "slow_down":
            interval += 5
        elif result.get("error") != "authorization_pending":
            raise RuntimeError("GitHub sign-in declined or expired")
    raise RuntimeError("GitHub sign-in expired")


def google_login(authorities, name, client_id, scopes, client_secret=""):
    import base64
    import hashlib
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import secrets
    import webbrowser
    vault()
    nonce, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    outcome = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            from urllib.parse import parse_qs
            args = parse_qs(urlsplit(self.path).query)
            if urlsplit(self.path).path != "/callback" or args.get("state") != [nonce]:
                self.send_error(400,"Invalid sign-in state"); return
            outcome.update(code=(args.get("code") or [None])[0],error=(args.get("error") or [None])[0])
            self.send_response(200); self.send_header("Content-Type","text/plain"); self.end_headers()
            self.wfile.write(b"ASIP received the sign-in response. You may close this tab.")
        def log_message(self,*_):
            pass

    with HTTPServer(("127.0.0.1",0),Callback) as server:
        server.timeout = 1
        redirect = "http://127.0.0.1:"+str(server.server_port)+"/callback"
        url = "https://accounts.google.com/o/oauth2/v2/auth?"+urlencode({
            "client_id":client_id,"redirect_uri":redirect,"response_type":"code","scope":scopes,
            "state":nonce,"code_challenge":challenge,"code_challenge_method":"S256",
            "access_type":"offline","prompt":"consent"})
        print("Opening Google sign-in in your browser",file=sys.stderr)
        webbrowser.open(url)
        deadline = time.monotonic()+300
        while not outcome and time.monotonic()<deadline:
            server.handle_request()
        if not outcome.get("code"):
            raise RuntimeError("Google sign-in declined or expired")
        result = oauth_post("https://oauth2.googleapis.com/token",{
            "client_id":client_id,"client_secret":client_secret,"code":outcome["code"],
            "code_verifier":verifier,"redirect_uri":redirect,"grant_type":"authorization_code"})
        if not result.get("access_token"):
            raise RuntimeError("Google token exchange failed; check the Desktop OAuth client")
        return authorities.configure(name,"google",result["access_token"],"Google OAuth",oauth={
            "client_id":client_id,"client_secret":client_secret,"refresh_token":result.get("refresh_token"),
            "expires_at":time.time()+result.get("expires_in",3600),"scopes":scopes})
