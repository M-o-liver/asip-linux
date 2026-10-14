"""Portable ASIP entry points."""
import argparse
import getpass
import json
import os
import subprocess
import sys
import uuid

from .credentials import Authorities
from .store import Store


def main(argv=None):
    parser = argparse.ArgumentParser(prog="asip-memory",description="ASIP — the memory of your agents")
    parser.add_argument("--home",help="Private state directory (also ASIP_HOME)")
    commands = parser.add_subparsers(dest="command",required=True)
    mcp = commands.add_parser("mcp"); mcp.add_argument("--agent",default="unknown")
    hook = commands.add_parser("hook"); hook.add_argument("--agent",required=True); hook.add_argument("--event")
    beacon = commands.add_parser("beacon"); beacon.add_argument("--port",type=int,default=0)
    beacon.add_argument("--open",action="store_true"); beacon.add_argument("--tray",action="store_true")
    commands.add_parser("status"); commands.add_parser("doctor")
    commands.add_parser("startup")
    sync = commands.add_parser("sync-system"); sync.add_argument("--limit",type=int,default=200)
    project = commands.add_parser("project"); project.add_argument("name",nargs="?"); project.add_argument("root",nargs="?"); project.add_argument("--description",default="")
    recall = commands.add_parser("recall"); recall.add_argument("query",nargs="?",default=""); recall.add_argument("--project-id"); recall.add_argument("--before",type=int); recall.add_argument("--limit",type=int,default=30)
    integrate = commands.add_parser("integrate"); integrate.add_argument("agent",choices=("codex","claude-code","antigravity","all")); integrate.add_argument("--apply",action="store_true")
    checkpoint = commands.add_parser("checkpoint"); checkpoint.add_argument("reason",nargs="?")
    restore = commands.add_parser("restore"); restore.add_argument("id"); restore.add_argument("--agents-stopped",action="store_true",help="Confirm all agents are stopped; restore replaces memory")
    access = commands.add_parser("access"); sub = access.add_subparsers(dest="action",required=True)
    sub.add_parser("list")
    configure = sub.add_parser("configure"); configure.add_argument("name"); configure.add_argument("provider",choices=("github","google","gemini","openai","anthropic","typesafe")); configure.add_argument("--label",default="")
    grant = sub.add_parser("grant"); grant.add_argument("name"); grant.add_argument("project_id"); grant.add_argument("--revoke",action="store_true")
    remove = sub.add_parser("remove"); remove.add_argument("name")
    github = sub.add_parser("github-login"); github.add_argument("name"); github.add_argument("--client-id",required=True); github.add_argument("--scopes",default="read:user")
    google = sub.add_parser("google-login"); google.add_argument("name"); google.add_argument("--client-id",required=True); google.add_argument("--scopes",default="openid email profile"); google.add_argument("--client-secret",action="store_true",help="Prompt locally for a Desktop client secret if needed")
    use = sub.add_parser("use"); use.add_argument("name"); use.add_argument("--intent-id",required=True); use.add_argument("argv",nargs=argparse.REMAINDER)
    classify = commands.add_parser("classify"); classify.add_argument("summary"); classify.add_argument("--intent-id",required=True); classify.add_argument("--authority",default="typesafe.jev"); classify.add_argument("--model",default="jev-latest")
    run = commands.add_parser("run"); run.add_argument("--agent",default="terminal"); run.add_argument("--intent",required=True); run.add_argument("argv",nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.home:
        os.environ["ASIP_HOME"] = args.home
    store = Store()
    try:
        if args.command=="mcp":
            from .mcp import main as serve
            return serve(store,args.agent)
        if args.command=="hook":
            from .hooks import hook_main
            return hook_main(store,args.agent,args.event)
        if args.command=="beacon":
            from .beacon import Beacon,existing
            active = existing(store,args.open)
            if active:
                result = active
            else:
                Beacon(store,args.port).serve(args.open,args.tray)
                return 0
        elif args.command=="status":
            from .beacon import existing
            result = existing(store) or {"health":"stopped"}
        elif args.command=="doctor":
            result = store.integrity()
        elif args.command=="startup":
            from .startup import install
            result = install()
        elif args.command=="sync-system":
            from .system import sync
            result = sync(store,max(1,min(args.limit,10000)))
        elif args.command=="project":
            if args.name and args.root:
                project=store.register(args.name,args.root,args.description)
                result={k:project[k] for k in ("id","name","repository","roots")}
            else:
                result=store.projects()
        elif args.command=="recall":
            result = store.events(project_id=args.project_id,query=args.query,before=args.before,limit=args.limit)
        elif args.command=="integrate":
            from .integrations import AGENTS,install,plan
            result = [(install if args.apply else plan)(agent) for agent in (AGENTS if args.agent=="all" else [args.agent])]
            if args.apply:
                store.record("operator","integrations","integration.configured","Native agent setup",{"agents":result})
        elif args.command in ("checkpoint","restore"):
            from .recovery import Recovery
            recovery = Recovery(store)
            if args.command=="restore":
                if not args.agents_stopped:
                    raise ValueError("Stop all agents and Beacon, then use --agents-stopped to restore memory")
                result = recovery.restore(args.id)
            else:
                result = recovery.checkpoint(args.reason) if args.reason else {"records":recovery.list(),"limit":10}
        elif args.command=="access":
            authorities = Authorities(store)
            if args.action=="list":
                result = authorities.list()
            elif args.action=="configure":
                result = authorities.configure(args.name,args.provider,getpass.getpass("Credential (stored only in the OS vault): "),args.label)
            elif args.action=="grant":
                result = authorities.grant(args.name,args.project_id,not args.revoke)
            elif args.action=="remove":
                result = authorities.remove(args.name)
            elif args.action=="github-login":
                from .credentials import github_login
                result = github_login(authorities,args.name,args.client_id,args.scopes)
            elif args.action=="google-login":
                from .credentials import google_login
                result = google_login(authorities,args.name,args.client_id,args.scopes,getpass.getpass("Desktop OAuth client secret: ") if args.client_secret else "")
            elif args.action=="use":
                result = authorities.use(args.name,args.intent_id,args.argv[1:] if args.argv[:1]==["--"] else args.argv)
        elif args.command=="classify":
            from .classifier import suggest
            result = suggest(store,Authorities(store),args.intent_id,args.summary,args.authority,args.model)
        elif args.command=="run":
            from .privacy import digest
            from .projects import evidence
            command = args.argv[1:] if args.argv[:1]==["--"] else args.argv
            if not command:
                raise ValueError("run requires argv after --")
            session = "run-"+uuid.uuid4().hex
            cwd = os.getcwd()
            intent = store.start_intent(args.agent,session,args.intent,cwd)
            store.record(args.agent,session,"tool.started","Command started",{"argv_sha256":digest(command),"before":evidence(cwd)},cwd,intent_id=intent["id"])
            try:
                exit_code = subprocess.run(command).returncode
                store.close_intent(intent["id"],"finished" if exit_code==0 else "failed","Command exited "+str(exit_code),{"exit":exit_code,"repository":evidence(cwd)})
                print(json.dumps({"intent_id":intent["id"],"exit":exit_code}),file=sys.stderr)
                return exit_code
            except BaseException:
                store.close_intent(intent["id"],"held","Command interrupted; inspect partial effects",{"repository":evidence(cwd)})
                raise
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0 if args.command!="doctor" or result.get("ok") else 1
    except (ValueError,RuntimeError,PermissionError,OSError) as error:
        from .privacy import clean
        print("ASIP: "+clean(str(error)),file=sys.stderr)
        return 1


def beacon_main():
    return main(["beacon",*sys.argv[1:]])
