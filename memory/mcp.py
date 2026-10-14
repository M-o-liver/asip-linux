"""Small standard MCP stdio server; shared memory does not grant OS elevation."""
import json
import os
import sys
import uuid

from . import __version__
from .credentials import Authorities
from .store import Store

PROTOCOLS = ("2025-11-25","2025-06-18","2025-03-26","2024-11-05")


def schema(properties=None, required=()):
    return {"type":"object","properties":properties or {},"required":list(required),"additionalProperties":False}


STRING = {"type":"string"}
TOOLS = [
    ("memory_context","Recall project activity, unresolved intents and recent evidence for a working directory.",
     schema({"cwd":STRING,"project_id":STRING,"session_id":STRING}),False),
    ("project_list","Known projects and their repository identities.",schema(),True),
    ("project_register","Register a durable authored project root.",schema({"name":STRING,"root":STRING,"description":STRING},("name","root")),False),
    ("intent_start","Record intended work before action; returns an explicit intent ID.",schema({"summary":STRING,"cwd":STRING,"session_id":STRING,"project_id":STRING},("summary",)),False),
    ("intent_close","Record an outcome and supporting evidence; held means unresolved.",schema({"intent_id":STRING,"status":{"type":"string","enum":["finished","failed","held"]},"outcome":STRING,"evidence":{"type":"object"}},("intent_id","status","outcome")),False),
    ("memory_record","Record a meaningful action, result, evidence or unresolved observation.",schema({"session_id":STRING,"cwd":STRING,"project_id":STRING,"intent_id":STRING,"kind":STRING,"summary":STRING,"data":{"type":"object"},"source_key":STRING},("kind","summary")),False),
    ("memory_search","Search durable records; before pages older events.",schema({"query":STRING,"project_id":STRING,"session_id":STRING,"before":{"type":"integer"},"limit":{"type":"integer","minimum":1,"maximum":100}}),True),
    ("access_list","Named API connections and grant metadata; never credential values.",schema(),True),
    ("access_call","Use a named API on its fixed provider origin; requires an open intent and project grant.",schema({"name":STRING,"intent_id":STRING,"path":STRING,"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"]},"body":{}},("name","intent_id","path")),False),
    ("access_use","Run finite user argv with named credentials; requires an open intent and project grant.",schema({"name":STRING,"intent_id":STRING,"argv":{"type":"array","items":STRING,"minItems":1},"cwd":STRING,"timeout":{"type":"integer","minimum":1,"maximum":300}},("name","intent_id","argv")),False),
]


class Server:
    def __init__(self,store,agent):
        self.store,self.agent = store,agent
        self.session = "mcp-"+uuid.uuid4().hex
        self.authorities = Authorities(store)
        self.client_info = {}

    def call(self,name,args):
        if name=="memory_context":
            if args.get("session_id"):
                self.session = args["session_id"]
            with self.store.connect(True) as db:
                pid,method = self.store._project(db,args.get("cwd",os.getcwd()),args.get("project_id"))
            return {"project":self.store.project(pid) if pid else None,"association":method,
                    "session_id":self.session,"agent":self.agent,
                    "identity":"Agent/client labels are self-reported; OS account owns the records.",
                    "unresolved":self.store.overview()["unresolved"] if not pid else None}
        if name=="project_list":
            return {"projects":self.store.projects()}
        if name=="project_register":
            return self.store.register(**args)
        if name=="intent_start":
            return self.store.start_intent(self.agent,args.pop("session_id",self.session),**args)
        if name=="intent_close":
            return self.store.close_intent(**args)
        if name=="memory_record":
            return self.store.record(self.agent,args.pop("session_id",self.session),**args)
        if name=="memory_search":
            return self.store.events(**args)
        if name=="access_list":
            return self.authorities.list()
        if name=="access_call":
            return self.authorities.call(**args)
        if name=="access_use":
            return self.authorities.use(**args)
        raise ValueError("unknown tool")

    def handle(self,message):
        if not isinstance(message,dict) or message.get("jsonrpc")!="2.0" or not isinstance(message.get("method"),str):
            return {"jsonrpc":"2.0","id":message.get("id") if isinstance(message,dict) else None,
                    "error":{"code":-32600,"message":"Invalid Request"}}
        request_id = message.get("id")
        method, params = message["method"], message.get("params",{})
        if "id" not in message or method.startswith("notifications/"):
            return None
        try:
            if method=="initialize":
                self.client_info = params.get("clientInfo",{})
                self.store.record(self.agent,self.session,"integration.connected","MCP client connected",{"client":self.client_info},os.getcwd())
                version = params.get("protocolVersion")
                result = {"protocolVersion":version if version in PROTOCOLS else PROTOCOLS[0],
                          "capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"asip-memory","version":__version__},
                          "instructions":"Recall memory_context for the project. Start an intent for coherent work; record outcomes with evidence. Local ASIP memory grants no root authority."}
            elif method=="ping":
                result = {}
            elif method=="tools/list":
                result = {"tools":[{"name":n,"description":d,"inputSchema":s,"annotations":{
                    "readOnlyHint":ro,"destructiveHint":n in ("access_use","access_call"),
                    "openWorldHint":n.startswith("access_") and n!="access_list"}} for n,d,s,ro in TOOLS]}
            elif method=="tools/call":
                name,args = params.get("name"),dict(params.get("arguments",{}))
                spec = next((t[2] for t in TOOLS if t[0]==name),None)
                if not spec or set(args)-set(spec["properties"]) or any(k not in args for k in spec["required"]):
                    raise ValueError("unknown tool or invalid arguments")
                for key,value in args.items():
                    field = spec["properties"][key]
                    expected = field.get("type")
                    valid = {"string":isinstance(value,str),"integer":isinstance(value,int) and not isinstance(value,bool),
                             "object":isinstance(value,dict),"array":isinstance(value,list)}
                    if expected and not valid.get(expected,False):
                        raise ValueError("invalid argument type: "+key)
                    if "enum" in field and value not in field["enum"]:
                        raise ValueError("invalid argument value: "+key)
                    if expected=="integer" and (value<field.get("minimum",value) or value>field.get("maximum",value)):
                        raise ValueError("argument outside supported range: "+key)
                data = self.call(name,args)
                result = {"content":[{"type":"text","text":json.dumps(data,ensure_ascii=False)}],"isError":False}
            elif method=="resources/list":
                result = {"resources":[{"uri":"asip://memory/overview","name":"Agent memory overview","mimeType":"application/json"}]}
            elif method=="resources/read" and params.get("uri")=="asip://memory/overview":
                result = {"contents":[{"uri":"asip://memory/overview","mimeType":"application/json","text":json.dumps(self.store.overview())}]}
            else:
                return {"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Method not found"}}
            return {"jsonrpc":"2.0","id":request_id,"result":result}
        except Exception as error:
            # Validation errors are safe after sanitization; operational errors omit remote/secret context.
            from .privacy import clean
            explanation = clean(str(error))[:512] if isinstance(error,(ValueError,PermissionError,RuntimeError)) else type(error).__name__
            if method=="tools/call":
                return {"jsonrpc":"2.0","id":request_id,"result":{"content":[{"type":"text","text":explanation}],"isError":True}}
            return {"jsonrpc":"2.0","id":request_id,"error":{"code":-32602,"message":explanation}}


def main(store=None,agent="unknown"):
    server = Server(store or Store(),agent)
    while True:
        raw = sys.stdin.buffer.readline(1024*1024+1)
        if not raw:
            break
        try:
            if len(raw)>1024*1024:
                while raw and not raw.endswith(b"\n"):
                    raw=sys.stdin.buffer.readline(1024*1024+1)
                raise ValueError("message too large")
            reply = server.handle(json.loads(raw))
        except (ValueError,UnicodeDecodeError):
            reply = {"jsonrpc":"2.0","id":None,"error":{"code":-32700,"message":"Invalid JSON or oversized message"}}
        if reply is not None:
            sys.stdout.write(json.dumps(reply,ensure_ascii=False)+"\n")
            sys.stdout.flush()
    return 0
