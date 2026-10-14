import concurrent.futures
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request,urlopen

from memory.beacon import Beacon
from memory.classifier import decide
from memory.credentials import Authorities
from memory.hooks import ingest, advisory
from memory.integrations import install, plan
from memory.mcp import Server
from memory.paths import FileLock
from memory.process import execute
from memory.projects import remote_identity
from memory.recovery import Recovery
from memory.store import Store


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.store=Store(self.root/"state")
        self.repo=self.root/"repo"; self.repo.mkdir()
        self.git(self.repo,"init","-q")
        self.git(self.repo,"remote","add","origin","git@github.com:owner/project.git")

    def tearDown(self):
        self.temp.cleanup()

    def git(self,root,*args):
        return subprocess.run(["git","-C",str(root),*args],check=True,capture_output=True,text=True)

    def record(self,**kwargs):
        return self.store.record("codex","test","test.event","Useful evidence",cwd=str(self.repo),**kwargs)

    def test_repository_identity_unifies_checkouts_and_keeps_nested_repositories_separate(self):
        first=self.record()
        second=self.root/"another";second.mkdir();self.git(second,"init","-q")
        self.git(second,"remote","add","origin","https://username:private@github.com/owner/project.git?token=never-retain")
        same=self.store.record("claude-code","other","test","second",cwd=str(second))
        nested=self.repo/"vendor";nested.mkdir();self.git(nested,"init","-q")
        self.git(nested,"remote","add","origin","https://github.com/owner/vendor.git")
        different=self.store.record("antigravity","third","test","nested",cwd=str(nested))
        self.assertEqual(first["project_id"],same["project_id"])
        self.assertNotEqual(first["project_id"],different["project_id"])
        projects=self.store.projects()
        self.assertEqual(len(projects),2)
        self.assertEqual(len(next(p for p in projects if p["id"]==first["project_id"])["roots"]),2)
        # macOS canonical temporary roots legitimately begin with /private/var.
        self.assertEqual({p["repository"] for p in projects},{"github.com/owner/project","github.com/owner/vendor"})
        self.assertNotIn("username:private@",json.dumps(projects))
        self.assertNotIn("never-retain",json.dumps(projects))

    def test_unknown_path_remains_unresolved_and_explicit_registration_resolves_it(self):
        event=self.store.record("codex","test","observation","outside",cwd=str(self.root))
        self.assertIsNone(event["project_id"])
        project=self.store.register("research",str(self.root))
        next_event=self.store.record("codex","test","observation","associated",cwd=str(self.root/"state"))
        self.assertEqual(next_event["project_id"],project["id"])
        self.assertEqual(next_event["data"]["association"]["method"],"registered-root")

    def test_transactional_concurrent_writers_have_one_valid_integrity_chain(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            events=list(pool.map(lambda n:self.record(data={"number":n}),range(40)))
        self.assertEqual(len({e["id"] for e in events}),40)
        self.assertEqual(self.store.integrity()["events"],40)
        self.assertTrue(self.store.integrity()["ok"])
        reopened=Store(self.store.home)
        self.assertEqual(reopened.overview()["counts"]["events"],40)

    def test_retry_is_idempotent_and_conflicting_key_is_rejected(self):
        first=self.record(source_key="same",data={"result":"pass"})
        retry=self.record(source_key="same",data={"result":"pass"})
        self.assertEqual(first["id"],retry["id"])
        with self.assertRaisesRegex(ValueError,"different event"):
            self.record(source_key="same",data={"result":"fail"})
        self.assertEqual(self.store.overview()["counts"]["events"],1)

    def test_intent_outcome_evidence_hold_and_terminal_rules(self):
        intent=self.store.start_intent("codex","test","Repair import",str(self.repo))
        self.store.close_intent(intent["id"],"held","Need fixture",{"path":"fixture.json"})
        self.assertEqual(len(self.store.overview()["unresolved"]),1)
        done=self.store.close_intent(intent["id"],"finished","Importer passes",{"test":"roundtrip","result":"pass"})
        self.assertEqual(done["status"],"finished")
        self.assertEqual(len(self.store.overview()["unresolved"]),0)
        with self.assertRaises(ValueError):
            self.store.close_intent(intent["id"],"failed","closed")
        result=self.store.events(query="roundtrip")
        self.assertEqual(result["events"][0]["intent_id"],intent["id"])

    def test_integrity_detects_mutated_evidence(self):
        event=self.record()
        with closing(sqlite3.connect(self.store.path)) as db, db:
            db.execute("UPDATE events SET summary='changed' WHERE id=?",(event["id"],))
        self.assertFalse(self.store.integrity()["ok"])

    def test_search_pagination_has_no_duplicates_and_treats_wildcards_literally(self):
        for n in range(7):
            self.store.record("codex","test","note","100% done" if n==3 else "Evidence "+str(n),cwd=str(self.repo))
        page=self.store.events(limit=3); older=self.store.events(before=page["before"],limit=3)
        self.assertFalse({e["id"] for e in page["events"]}&{e["id"] for e in older["events"]})
        self.assertEqual(len(self.store.events(query="% done")["events"]),1)

    def test_hooks_keep_identity_metadata_and_hashes_without_prompt_or_tool_secrets(self):
        secret="extremely-private-and-not-a-known-key-pattern"
        payload={"hook_event_name":"PostToolUse","session_id":"platform-session","cwd":str(self.repo),
                 "tool_name":"Bash","tool_use_id":"tool-1","tool_input":{"command":"echo "+secret},
                 "tool_response":{"stdout":secret,"exit_code":1},"transcript_path":"/private/transcript.jsonl"}
        event=ingest(self.store,"claude-code",payload)
        self.assertEqual(event["kind"],"tool.failed")
        self.assertEqual(ingest(self.store,"claude-code",payload)["id"],event["id"])
        ingest(self.store,"codex",{"hook_event_name":"UserPromptSubmit","session_id":"s","cwd":str(self.repo),"prompt":secret})
        self.assertNotIn(secret,json.dumps(self.store.events()))
        self.assertIn("platform-session",[s["external_id"] for s in self.store.project(event["project_id"])["sessions"]])

    def test_antigravity_native_payload_and_ambiguous_workspaces(self):
        payload={"conversationId":"google-conversation","workspacePaths":[str(self.repo)],
                 "toolCall":{"name":"run_command","args":{"CommandLine":"npm test","Cwd":str(self.repo)}},
                 "stepIdx":5,"error":"exit status 1"}
        event=ingest(self.store,"antigravity",payload,"PostToolUse")
        self.assertEqual(event["kind"],"tool.failed")
        self.assertEqual(event["data"]["tool"],"run_command")
        self.assertEqual(advisory("antigravity","PreToolUse"),{"decision":"allow"})
        ambiguous=ingest(self.store,"antigravity",{"conversationId":"ambiguous","workspacePaths":[str(self.repo),str(self.root)]},"SessionStart")
        self.assertIsNone(ambiguous["project_id"])

    def test_checkpoint_retention_restore_and_pre_restore_recovery(self):
        recovery=Recovery(self.store)
        self.record(data={"value":"original"})
        oldest=recovery.checkpoint("Original")
        for n in range(9):
            self.record(data={"value":n});recovery.checkpoint("Checkpoint "+str(n))
        self.assertEqual(len(recovery.list()),10)
        self.assertEqual(len(list(recovery.directory.glob("*.sqlite3"))),10)
        recovery.restore(oldest["id"])
        self.assertEqual(self.store.overview()["counts"]["events"],2) # original plus restore record
        self.assertTrue(self.store.integrity()["ok"])
        self.assertEqual(len(recovery.list()),10)
        self.assertTrue(any(r["reason"].startswith("Before restoring") for r in recovery.list()))

    def test_restore_refuses_running_beacon_and_corrupt_checkpoint(self):
        recovery=Recovery(self.store);record=recovery.checkpoint("Safe")
        with FileLock(self.store.home/"beacon.lock"):
            with self.assertRaises(RuntimeError):recovery.restore(record["id"])
        (recovery.directory/(record["id"]+".sqlite3")).write_bytes(b"broken")
        with self.assertRaisesRegex(RuntimeError,"hash mismatch"):recovery.restore(record["id"])

    def test_native_configuration_preserves_unrelated_hooks_servers_and_is_repeatable(self):
        for agent in ("codex","claude-code","antigravity"):
            home=self.root/agent;home.mkdir()
            p=plan(agent,home)
            hook=Path(p["hook_path"]);hook.parent.mkdir(parents=True,exist_ok=True)
            unrelated={"other":{"Stop":[{"command":"keep-me"}]}} if agent=="antigravity" else {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}
            hook.write_text(json.dumps(unrelated))
            if agent=="codex":
                Path(p["mcp_path"]).write_text('[mcp_servers.other]\ncommand = "keep-me"\n')
            else:
                path=Path(p["mcp_path"]);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps({"mcpServers":{"other":{"command":"keep-me"}}}))
            install(agent,home); first=json.loads(hook.read_text());install(agent,home)
            self.assertEqual(first,json.loads(hook.read_text()))
            self.assertIn("keep-me",hook.read_text())
            self.assertIn("keep-me",Path(p["mcp_path"]).read_text())
            self.assertTrue(Path(p["skill_path"]).exists())

    def test_mcp_transport_initialize_discovery_and_record_recall(self):
        environment={**os.environ,"ASIP_HOME":str(self.store.home)}
        requests=[{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","clientInfo":{"name":"qualification","version":"1"}}},
                  {"jsonrpc":"2.0","method":"notifications/initialized"},
                  {"jsonrpc":"2.0","id":2,"method":"tools/list"},
                  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"intent_start","arguments":{"summary":"Transport qualification","cwd":str(self.repo),"session_id":"native-session"}}},
                  {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Transport qualification"}}}]
        result=subprocess.run([sys.executable,"-m","memory","mcp","--agent","codex"],input="".join(json.dumps(r)+"\n" for r in requests),capture_output=True,text=True,env=environment,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        replies=[json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(replies),4)
        self.assertEqual(replies[0]["result"]["protocolVersion"],"2025-11-25")
        self.assertEqual(len(replies[1]["result"]["tools"]),10)
        record=json.loads(replies[-1]["result"]["content"][0]["text"])["events"][0]
        self.assertEqual(record["kind"],"intent.started")

    def test_local_http_origin_authentication_api_and_security_headers(self):
        beacon=Beacon(self.store)
        thread=threading.Thread(target=beacon.server.serve_forever,daemon=True);thread.start()
        def request(path,body=None,headers=None):
            req=Request(beacon.origin+path,data=json.dumps(body).encode() if body is not None else None,
                        headers={"Content-Type":"application/json",**(headers or {})})
            return urlopen(req,timeout=5)
        try:
            with self.assertRaises(HTTPError) as unauth:request("/api/overview")
            self.assertEqual(unauth.exception.code,401)
            unauth.exception.close()
            with self.assertRaises(HTTPError) as forged:request("/",headers={"Host":"evil.example"})
            self.assertEqual(forged.exception.code,403)
            forged.exception.close()
            with self.assertRaises(HTTPError) as csrf:request("/api/connect",{"token":beacon.token},headers={"Origin":"https://evil.example"})
            self.assertEqual(csrf.exception.code,403)
            csrf.exception.close()
            with request("/api/connect",{"token":beacon.token},headers={"Origin":beacon.origin}) as response:
                cookie=response.headers["Set-Cookie"].split(";",1)[0]
                self.assertIn("HttpOnly",response.headers["Set-Cookie"])
                self.assertIn("frame-ancestors 'none'",response.headers["Content-Security-Policy"])
            with request("/api/project/register",{"name":"Test","root":str(self.repo)},headers={"Origin":beacon.origin,"Cookie":cookie}) as response:
                self.assertEqual(json.load(response)["name"],"Test")
            with request("/api/overview",headers={"Cookie":cookie}) as response:
                self.assertEqual(json.load(response)["counts"]["projects"],1)
        finally:
            beacon.server.shutdown();beacon.server.server_close();thread.join(timeout=5)

    def test_credential_grants_scope_output_redaction_and_fixed_origin(self):
        class Vault:
            values={}
            def set_password(self,service,name,value):self.values[name]=value
            def get_password(self,service,name):return self.values.get(name)
        secret="test-credential-not-for-logs"
        authorities=Authorities(self.store)
        intent=self.store.start_intent("codex","session","Use GitHub",str(self.repo))
        with patch("memory.credentials.vault",return_value=Vault()):
            authorities.configure("github.test","github",secret)
            with self.assertRaises(PermissionError):authorities.resolve("github.test",intent["id"])
            authorities.grant("github.test",intent["project_id"])
            result=authorities.use("github.test",intent["id"],[sys.executable,"-c","import os; print(os.environ['GH_TOKEN'])"])
            self.assertNotIn(secret,json.dumps(result))
            self.assertEqual(result["exit"],0)
            audit=self.store.events(query="access.finished")["events"][0]
            self.assertEqual(audit["session_id"],intent["session_id"])
            self.assertEqual(audit["intent_id"],intent["id"])
            with self.assertRaises(ValueError):authorities.call("github.test",intent["id"],"//evil.example")
            with patch("memory.credentials.request_json",return_value={"status":200,"data":{"message":secret}}) as request:
                result=authorities.call("github.test",intent["id"],"/user")
                self.assertEqual(request.call_args.args[0],"https://api.github.com/user")
                self.assertNotIn(secret,json.dumps(result))
            self.assertNotIn(secret,self.store.path.read_bytes().decode(errors="ignore"))
            self.assertNotIn(secret,json.dumps(self.store.events()))
            authorities.grant("github.test",intent["project_id"],False)
            with self.assertRaises(PermissionError):authorities.resolve("github.test",intent["id"])

    def test_finite_process_timeout_and_bounded_output(self):
        output=execute([sys.executable,"-c","print('x'*30000)"],os.environ,timeout=5)
        self.assertTrue(output["stdout"]["truncated"])
        self.assertEqual(len(output["stdout"]["text"]),8192)
        expired=execute([sys.executable,"-c","import time;time.sleep(10)"],os.environ,timeout=.15)
        self.assertTrue(expired["timed_out"])

    def test_jev_distribution_is_validated_and_uncertain_suggestions_abstain(self):
        response={"model":"jev-test","answers":{"project":{"type":"choice","choice":"a","confidence":.95,"probabilities":{"a":.93,"b":.04,"unresolved":.03}}}}
        self.assertEqual(decide(response,{"a","b"})["suggested_project"],"a")
        response["answers"]["project"].update(confidence=.6,probabilities={"a":.55,"b":.4,"unresolved":.05})
        self.assertIsNone(decide(response,{"a","b"})["suggested_project"])
        response["answers"]["project"]["probabilities"]["a"]=float("nan")
        with self.assertRaises(ValueError):decide(response,{"a","b"})


if __name__=="__main__":unittest.main()
