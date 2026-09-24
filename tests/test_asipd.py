import json
import os
import pathlib
import pwd
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from core import daemon as asipd
from core.protocol import is_read_only


class DaemonTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.state = self.root / "state"
        self.machine = self.root / "etc" / "MACHINE.md"
        self.patches = [
            mock.patch.object(asipd, "STATE", self.state),
            mock.patch.object(asipd, "JOURNAL", self.state / "journal.jsonl"),
            mock.patch.object(asipd, "BLOBS", self.state / "blobs"),
            mock.patch.object(asipd, "MACHINE", self.machine),
            mock.patch.object(asipd, "PROJECTS", self.root / "etc" / "projects.md"),
            mock.patch.object(asipd, "DRIFT_DECISIONS", self.root / "etc" / "drift.md"),
            mock.patch.object(asipd, "ACCESS_DIR", self.state / "access"),
            mock.patch.object(
                asipd, "set_group_access", lambda path, mode: os.chmod(path, mode)
            ),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def request(self, op, *, argv=None, uid=1000, **fields):
        explicit_intent = fields.pop("explicit_intent", True)
        request = {
            "schema_version": 1,
            "op": op,
            "argv": argv or [],
            "cwd": str(self.root),
            "reason": fields.pop("reason", ""),
            "_peer_uid": uid,
        }
        request.update(fields)
        if (explicit_intent and not is_read_only(request) and op != "change"
                and not request.get("change_id")):
            request["standalone_reason"] = "isolated test operation"
        return request

    def start_change(self, intent="Make the desktop coherent", uid=1000):
        response = asipd.handle(
            self.request("change", argv=[intent], uid=uid, action="start")
        )
        self.assertEqual(response["exit"], 0)
        return response["stdout"].strip()

    def records(self):
        return asipd.journal_records()

    def test_change_start_note_finish_and_fail(self):
        change_id = self.start_change("Make Solitaire the centre of Jane's desktop")
        note = asipd.handle(
            self.request(
                "note",
                argv=["/home/jane/.local/share/applications/solitaire.desktop"],
                reason="Large launcher used by Jane's desktop session",
                change_id=change_id,
            )
        )
        self.assertEqual(note["exit"], 0)
        finished = asipd.handle(
            self.request(
                "change",
                argv=[change_id, "Added the launcher and kept the normal desktop"],
                action="finish",
            )
        )
        self.assertEqual(finished["exit"], 0)
        show = asipd.handle(
            self.request("change", argv=[change_id], action="show")
        )
        self.assertIn("Status: finished", show["stdout"])
        self.assertIn("solitaire.desktop", show["stdout"])

        failed_id = self.start_change("Try an alternate layout")
        failed = asipd.handle(
            self.request(
                "change",
                argv=[failed_id, "Theme API was unavailable; existing state retained"],
                action="fail",
            )
        )
        self.assertEqual(failed["exit"], 0)
        self.assertEqual(asipd.change_status(failed_id), "failed")
        self.assertEqual(asipd.handle(self.request(
            "change", argv=["Structured start"], action="start"
        ))["data"]["status"], "open")

    def test_access_missing_provision_use_replace_and_remove_without_secret_exposure(self):
        local_uid = os.getuid()
        def local_request(op, **fields):
            return self.request(op, uid=local_uid, **fields)

        change_id = self.start_change("Use a named external authority", uid=local_uid)
        missing = asipd.handle(local_request(
            "access", action="request", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], label="Cloudflare API token",
            env_var="CLOUDFLARE_API_TOKEN", change_id=change_id,
        ))
        self.assertEqual(missing["error"]["code"], "operator_action_required")
        self.assertTrue(missing["error"]["retryable"])
        self.assertIn("ASIP", missing["error"]["remediation"])
        self.assertIn("Connected services", missing["error"]["remediation"])
        self.assertNotIn("value", json.dumps(missing))
        brief = asipd.handle_read_only(local_request("brief", explicit_intent=False))["data"]
        access_attention = next(item for item in brief["attention"]
                                if item["kind"] == "access_provisioning")
        self.assertEqual(access_attention["refs"]["authorities"], ["cloudflare.api_token"])

        secret = "-".join(("test", "secret", "92c6"))
        provisioned = asipd.handle(local_request(
            "access", action="provision", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], label="Cloudflare API token",
            env_var="CLOUDFLARE_API_TOKEN", value=secret, explicit_intent=False,
        ))
        self.assertTrue(provisioned["data"]["available"])
        profile_path = asipd.ACCESS_DIR / "cloudflare.api_token.json"
        self.assertEqual(stat.S_IMODE(profile_path.stat().st_mode), 0o600)

        used = asipd.handle(local_request(
            "access", action="use", name="cloudflare.api_token", change_id=change_id,
            argv=[sys.executable, "-c",
                  "import os,sys,time; value=os.environ['CLOUDFLARE_API_TOKEN']; "
                  "print('ok' if value else 'missing'); "
                  "sys.stdout.write(value[:5]); sys.stdout.flush(); time.sleep(.03); "
                  "sys.stdout.write(value[5:] + '\\n')"],
        ))
        self.assertEqual(used["exit"], 0)
        self.assertIn("ok", used["stdout"])
        self.assertIn("[ASIP ACCESS VALUE REDACTED]", used["stdout"])
        self.assertNotIn(secret, used["stdout"])
        serialized_journal = json.dumps(self.records())
        serialized_blobs = "".join(path.read_text(encoding="utf-8")
                                   for path in asipd.BLOBS.iterdir())
        self.assertNotIn(secret, serialized_journal)
        self.assertNotIn(secret, serialized_blobs)

        detached = mock.Mock(pid=4242)
        with mock.patch.object(asipd.subprocess, "Popen", return_value=detached) as popen:
            started = asipd.handle(local_request(
                "access", action="start", name="cloudflare.api_token",
                change_id=change_id, argv=["long-lived-server"],
            ))
        self.assertEqual(started["data"]["state"], "detached")
        self.assertEqual(started["data"]["pid"], 4242)
        self.assertIs(popen.call_args.kwargs["stdout"], subprocess.DEVNULL)
        self.assertIs(popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(popen.call_args.kwargs["env"]["CLOUDFLARE_API_TOKEN"], secret)
        self.assertNotIn(secret, json.dumps(self.records()))

        replacement = "-".join(("replacement", "secret", "31aa"))
        replaced = asipd.handle(local_request(
            "access", action="provision", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], label="Cloudflare API token",
            env_var="CLOUDFLARE_API_TOKEN", value=replacement, explicit_intent=False,
        ))
        self.assertEqual(replaced["data"]["last_event"], "replace")
        self.assertNotEqual(replaced["data"]["revision"], provisioned["data"]["revision"])
        refused_dismiss = asipd.handle(local_request(
            "access", action="dismiss", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], change_id=change_id,
        ))
        self.assertNotEqual(refused_dismiss["exit"], 0)
        self.assertIn("remove it explicitly", refused_dismiss["stderr"])
        removed = asipd.handle(local_request(
            "access", action="remove", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], explicit_intent=False,
        ))
        self.assertTrue(removed["data"]["removed"])
        self.assertFalse(removed["data"]["available"])
        self.assertEqual(removed["data"]["state"], "removed")
        self.assertNotIn("cloudflare.api_token", asipd.access_catalog()["operator_action_required"])
        self.assertFalse(profile_path.exists())

        requested_again = asipd.handle(local_request(
            "access", action="request", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], label="Cloudflare API token",
            env_var="CLOUDFLARE_API_TOKEN", change_id=change_id,
        ))
        self.assertEqual(requested_again["data"]["state"], "operator_action_required")
        self.assertTrue(requested_again["data"]["requested"])
        dismissed = asipd.handle(local_request(
            "access", action="dismiss", name="cloudflare.api_token",
            argv=["cloudflare.api_token"], change_id=change_id,
        ))
        self.assertTrue(dismissed["data"]["dismissed"])
        self.assertEqual(dismissed["data"]["state"], "not_requested")
        self.assertNotIn("cloudflare.api_token", asipd.access_catalog()["operator_action_required"])

    def test_access_execution_rejects_unknown_local_uid(self):
        unknown_uid = max((account.pw_uid for account in pwd.getpwall()), default=0) + 100000
        while True:
            try:
                pwd.getpwuid(unknown_uid)
            except KeyError:
                break
            unknown_uid += 1

        provisioned = asipd.handle(self.request(
            "access", action="provision", name="test.unknown_uid",
            argv=["test.unknown_uid"], label="Unknown UID test authority",
            env_var="ASIP_UNKNOWN_UID_TEST", value="not-a-real-secret",
            explicit_intent=False,
        ))
        self.assertEqual(provisioned["exit"], 0)

        with mock.patch.object(asipd.subprocess, "Popen") as popen:
            for action in ("use", "start"):
                with self.subTest(action=action):
                    response = asipd.handle(self.request(
                        "access", action=action, name="test.unknown_uid",
                        uid=unknown_uid, argv=[sys.executable, "-c", "pass"],
                    ))
                    self.assertEqual(response["exit"], 64)
                    self.assertEqual(response["error"]["code"], "invalid_request")
                    self.assertIn("local calling user", response["stderr"])
        popen.assert_not_called()

    def test_change_hold_is_blocked_work_not_a_planner(self):
        change_id = self.start_change("Apply kernel after a reboot window")
        held = asipd.handle(self.request(
            "change", argv=[change_id, "NVIDIA/Mesa need a coordinated reboot"],
            action="hold", kind="reboot_window",
            unblock="operator opens an explicit reboot window",
        ))
        self.assertEqual(held["exit"], 0)
        self.assertEqual(held["data"]["status"], "held")
        self.assertEqual(held["data"]["hold"]["kind"], "reboot_window")
        self.assertEqual(asipd.change_status(change_id), "held")
        blocked = asipd.handle(self.request(
            "do", argv=["true"], change_id=change_id, explicit_intent=False
        ))
        self.assertNotEqual(blocked["exit"], 0)
        self.assertIn("held", blocked["stderr"])
        finish = asipd.handle(self.request(
            "change", argv=[change_id, "done"], action="finish"
        ))
        self.assertNotEqual(finish["exit"], 0)
        released = asipd.handle(self.request(
            "change", argv=[change_id, "reboot window granted"], action="release"
        ))
        self.assertEqual(released["exit"], 0)
        self.assertEqual(asipd.change_status(change_id), "open")

    def test_change_open_is_literal_status_open(self):
        open_a = self.start_change("Continue now A")
        open_b = self.start_change("Continue now B")
        held_a = self.start_change("Blocked A")
        held_b = self.start_change("Blocked B")
        finished = self.start_change("Completed work")
        failed = self.start_change("Abandoned work")
        asipd.handle(self.request(
            "change", argv=[held_a, "wait"], action="hold",
            kind="deferred", unblock="later",
        ))
        asipd.handle(self.request(
            "change", argv=[held_b, "wait"], action="hold",
            kind="operator", unblock="operator says proceed",
        ))
        asipd.handle(self.request(
            "change", argv=[finished, "done"], action="finish",
        ))
        asipd.handle(self.request(
            "change", argv=[failed, "abandoned"], action="fail",
        ))

        opened = asipd.handle_read_only(
            self.request("change", action="open", explicit_intent=False)
        )
        listed = asipd.handle_read_only(
            self.request("change", action="list", explicit_intent=False)
        )
        brief = asipd.handle_read_only(
            self.request("brief", explicit_intent=False)
        )

        open_ids = [item["change_id"] for item in opened["data"]["changes"]]
        self.assertEqual(set(open_ids), {open_a, open_b})
        self.assertTrue(all(item["status"] == "open" for item in opened["data"]["changes"]))
        self.assertNotIn(held_a, open_ids)
        self.assertNotIn(held_b, open_ids)
        self.assertNotIn(finished, open_ids)
        self.assertNotIn(failed, open_ids)
        history = {item["change_id"]: item for item in listed["data"]["changes"]}
        self.assertEqual(history[finished]["outcome"], "done")
        self.assertIsNotNone(history[finished]["finished_at"])
        self.assertEqual(history[failed]["outcome"], "abandoned")
        self.assertIsNone(history[open_a]["outcome"])

        by_id = {item["change_id"]: item["status"] for item in listed["data"]["changes"]}
        self.assertEqual(by_id[open_a], "open")
        self.assertEqual(by_id[open_b], "open")
        self.assertEqual(by_id[held_a], "held")
        self.assertEqual(by_id[held_b], "held")
        self.assertEqual(by_id[finished], "finished")
        self.assertEqual(by_id[failed], "failed")

        blocking = brief["data"]["blocking"]
        self.assertEqual(blocking["open"], 2)
        self.assertEqual(blocking["held"], 2)
        statuses = {item["change_id"]: item["status"] for item in blocking["items"]}
        self.assertEqual(statuses[open_a], "open")
        self.assertEqual(statuses[held_a], "held")
        self.assertNotIn(finished, statuses)
        self.assertNotIn(failed, statuses)

    def test_facts_are_read_only_and_do_not_release_holds(self):
        change_id = self.start_change("Wait for predecessor")
        pred = self.start_change("Prerequisite")
        asipd.handle(self.request("change", argv=[pred, "done"], action="finish"))
        asipd.handle(self.request(
            "change", argv=[change_id, "wait"], action="hold",
            kind="predecessor", unblock=pred,
            observations=["disk:/", "pkg:bash"],
        ))
        catalog = asipd.handle_read_only(self.request("facts", action="catalog", explicit_intent=False))
        self.assertEqual(catalog["exit"], 0)
        self.assertIn("kernel", catalog["data"]["facts"])
        self.assertIn("used_percent", catalog["data"]["facts"]["disk"])
        pkg = asipd.handle_read_only(self.request(
            "facts", action="get", argv=["pkg", "bash"], explicit_intent=False
        ))
        self.assertTrue(pkg["data"]["value"]["installed"])
        missing = pathlib.Path("/tmp/asip-missing-fact-path")
        path = asipd.handle_read_only(self.request(
            "facts", action="get", argv=["path:%s" % missing], explicit_intent=False
        ))
        self.assertFalse(path["data"]["value"]["exists"])
        shown = asipd.handle_read_only(self.request(
            "change", action="show", argv=[change_id], explicit_intent=False
        ))
        hold = shown["data"]["hold"]
        self.assertEqual(hold["predecessor"], pred)
        self.assertEqual(hold["predecessor_status"], "finished")
        self.assertNotIn("unblocked", hold)
        self.assertNotIn("unblocked", shown["data"])
        self.assertTrue(any(item["spec"] == "disk:/" and item.get("ok")
                            for item in hold["observation_values"]))
        self.assertTrue(any(item["spec"] == "pkg:bash" and item.get("ok")
                            for item in hold["observation_values"]))
        removed = asipd.handle_read_only(self.request(
            "facts", action="check-hold", argv=[change_id], explicit_intent=False
        ))
        self.assertNotEqual(removed["exit"], 0)
        self.assertIn("change show", removed["stderr"])
        self.assertEqual(asipd.change_status(change_id), "held")

    def test_ask_pose_dedupes_and_answer_does_not_release_hold(self):
        change_id = self.start_change("Apply kernel after a reboot window")
        asipd.handle(self.request(
            "change", argv=[change_id, "needs a window"], action="hold",
            kind="reboot_window", unblock="operator opens a reboot window",
        ))
        first = asipd.handle(self.request(
            "ask", action="pose", change_id=change_id, gate="reboot_window",
            cannot="LUKS after reboot is not a file",
            choices=["yes", "not-now"],
            argv=["Is a reboot window open now?"],
        ))
        self.assertEqual(first["exit"], 0)
        self.assertTrue(first["data"]["created"])
        qid = first["data"]["question_id"]
        second = asipd.handle(self.request(
            "ask", action="pose", change_id=change_id, gate="reboot_window",
            cannot="still cannot know",
            choices=["yes", "not-now"],
            argv=["Can we reboot now?"],
        ))
        self.assertFalse(second["data"]["created"])
        self.assertEqual(second["data"]["question_id"], qid)
        listing = asipd.handle_read_only(self.request("ask", action="list", explicit_intent=False))
        self.assertEqual(listing["data"]["pending"], 1)
        self.assertEqual(
            listing["data"]["human_surface"], asipd.OPERATOR_QUESTIONS_SURFACE
        )
        answered = asipd.handle(self.request(
            "ask", action="answer", argv=[qid], choice="not-now", note="after dinner",
            standalone_reason="operator answered locally",
        ))
        self.assertEqual(answered["data"]["status"], "answered")
        self.assertFalse(answered["data"]["released_hold"])
        self.assertFalse(answered["data"]["rebooted"])
        self.assertEqual(asipd.change_status(change_id), "held")
        brief = asipd.handle_read_only(
            self.request("brief", explicit_intent=False)
        )
        self.assertEqual(brief["data"]["operator_questions"]["pending"], 0)

    def test_brief_attention_is_deterministic(self):
        change_id = self.start_change("Apply kernel after a reboot window")
        asipd.handle(self.request(
            "change", argv=[change_id, "needs a window"], action="hold",
            kind="reboot_window", unblock="operator opens a reboot window",
        ))
        with mock.patch.object(asipd, "fact_kernel", return_value={
            "running": "7.1.5", "newest_installed": "7.1.6", "reboot_pending": True,
            "installed": [], "default_boot": None,
        }), mock.patch.object(asipd, "fact_disk", return_value={
            "mount": "/", "used_percent": 84,
        }):
            quiet = asipd.handle_read_only(
                self.request("brief", explicit_intent=False)
            )
        self.assertEqual(quiet["exit"], 0)
        data = quiet["data"]
        self.assertEqual(data["document"], "brief")
        self.assertEqual(data["attention"], [])
        self.assertEqual(data["blocking"]["held"], 1)
        self.assertEqual(data["blocking"]["items"][0]["change_id"], change_id)
        self.assertEqual(data["facts"]["kernel"]["reboot_pending"], True)
        self.assertNotIn("disk", data["facts"])

        posed = asipd.handle(self.request(
            "ask", action="pose", change_id=change_id, gate="reboot_window",
            cannot="LUKS after reboot is not a file",
            choices=["yes", "not-now"],
            argv=["Is a reboot window open now?"],
        ))
        qid = posed["data"]["question_id"]
        pending = asipd.handle_read_only(self.request("brief", explicit_intent=False))
        attn = pending["data"]["attention"]
        self.assertEqual(len(attn), 1)
        self.assertEqual(attn[0]["audience"], "operator")
        self.assertEqual(attn[0]["kind"], "operator_question")
        self.assertEqual(attn[0]["count"], 1)
        self.assertEqual(attn[0]["human_surface"], asipd.OPERATOR_QUESTIONS_SURFACE)
        self.assertEqual(pending["data"]["operator_questions"]["pending"], 1)

        asipd.append_record({
            "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
            "op": "do", "state": "started", "argv": ["dnf", "upgrade"],
            "at": "2026-08-17T00:00:00+00:00",
        })
        both = asipd.handle_read_only(self.request("brief", explicit_intent=False))
        kinds = [item["kind"] for item in both["data"]["attention"]]
        self.assertEqual(kinds, ["operator_question", "incomplete_operation"])
        self.assertEqual(both["data"]["attention"][1]["audience"], "agent")

        shown = asipd.handle_read_only(
            self.request("log", argv=[qid], explicit_intent=False)
        )
        self.assertEqual(shown["data"]["question_id"], qid)
        asipd.handle(self.request(
            "ask", action="answer", argv=[qid], choice="not-now", note="not now",
            standalone_reason="operator answered locally",
        ))
        answered = asipd.handle_read_only(
            self.request("log", argv=[qid], explicit_intent=False)
        )
        self.assertEqual(answered["data"]["status"], "answered")
        self.assertEqual(answered["data"]["answer"]["choice"], "not-now")
        after = asipd.handle_read_only(self.request("brief", explicit_intent=False))
        kinds = [item["kind"] for item in after["data"]["attention"]]
        self.assertEqual(kinds, ["incomplete_operation"])
        self.assertEqual(asipd.change_status(change_id), "held")

    def test_rollback_rejects_snapper_backend_id(self):
        asipd.append_record({
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "op": "snap", "state": "finished", "exit": 0,
            "snapshotter": "snapper", "backend_id": "741",
            "stdout_blob": None,
        })
        with self.assertRaisesRegex(ValueError, "recovery_handle"):
            asipd.rollback_command("741")

    def test_duplicate_intent_warns_and_can_be_superseded(self):
        first = self.start_change("Reconcile operator preferences")
        duplicate = asipd.handle(
            self.request("change", argv=["reconcile operator preferences"], action="start")
        )
        second = duplicate["stdout"].strip()
        self.assertIn(first, duplicate["stderr"])
        finished = asipd.handle(
            self.request(
                "change", argv=[second, "Completed through the replacement session"],
                action="finish",
            )
        )
        self.assertEqual(finished["exit"], 0)
        superseded = asipd.handle(
            self.request(
                "change", argv=[first, second, "Continued through the newer session"],
                action="supersede",
            )
        )
        self.assertEqual(superseded["exit"], 0)
        self.assertEqual(asipd.change_status(first), "superseded")
        shown = asipd.handle(self.request("change", argv=[first], action="show"))
        self.assertIn("Superseded by: %s" % second, shown["stdout"])

    def test_explicit_association_keeps_same_uid_changes_separate(self):
        first = self.start_change("First concurrent intent")
        second = self.start_change("Second concurrent intent")
        for change_id, marker in ((second, "second"), (first, "first"), (second, "second-again")):
            response = asipd.handle(
                self.request(
                    "do",
                    argv=[sys.executable, "-c", "print(%r)" % marker],
                    reason=marker,
                    change_id=change_id,
                )
            )
            self.assertEqual(response["exit"], 0)
        terminal = [record for record in self.records() if record.get("state") == "finished"]
        self.assertEqual(
            [record["change_id"] for record in terminal], [second, first, second]
        )
        self.assertFalse(any(record.get("uid") != 1000 for record in terminal))

    def test_operation_start_is_durable_when_command_fails(self):
        response = asipd.handle(
            self.request("do", argv=["/bin/sh", "-c", "exit 7"], reason="expected failure")
        )
        self.assertEqual(response["exit"], 7)
        records = [record for record in self.records() if record["id"] == response["id"]]
        self.assertEqual([record["state"] for record in records], ["started", "failed"])
        self.assertNotIn("exit", records[0])
        self.assertEqual(records[1]["exit"], 7)

    def test_journal_repairs_a_torn_final_line_before_next_append(self):
        real_write = os.write

        def write_partial_then_fail(descriptor, payload):
            real_write(descriptor, payload[:7])
            raise OSError("simulated full disk")

        with mock.patch.object(asipd.os, "write", side_effect=write_partial_then_fail):
            with self.assertRaisesRegex(OSError, "full disk"):
                asipd.append_record({"id": "torn", "op": "do", "state": "started"})

        asipd.append_record({"id": "next", "op": "do", "state": "finished"})
        self.assertEqual(self.records(), [{"id": "next", "op": "do", "state": "finished"}])

    def test_client_provenance_is_preserved_in_operation_evidence(self):
        response = asipd.handle(self.request(
            "do", argv=["/bin/true"], transport="mcp",
            protocol_version="2026-07-28",
            client={"name": "fixture-agent", "version": "9.4"},
        ))
        self.assertEqual(response["exit"], 0)
        records = [record for record in self.records() if record.get("id") == response["id"]]
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertEqual(record["transport"], "mcp")
            self.assertEqual(
                record["client"], {"name": "fixture-agent", "version": "9.4"}
            )

    def test_operation_start_survives_daemon_interruption(self):
        request = self.request("do", argv=["interrupted-root-command"], request_key="crashed-request")
        with mock.patch.object(asipd, "execute", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                asipd.handle(request)
        records = self.records()
        self.assertEqual([record["state"] for record in records], ["started", "started"])
        self.assertEqual(records[-1]["argv"], ["interrupted-root-command"])

        asipd.prepare_state(read_only=False)
        records = self.records()
        interrupted = next(record for record in records
                           if record.get("op") == "do" and record.get("state") == "interrupted")
        claim = next(record for record in reversed(records)
                     if record.get("op") == "request" and record.get("state") == "finished")
        self.assertTrue(interrupted["outcome_unknown"])
        self.assertEqual(claim["response"]["error"]["code"], "operation_interrupted")

        operation = asipd.operation_request(
            {"argv": [interrupted["id"]]}, "inspect-operation", time.monotonic()
        )
        self.assertEqual(operation["data"]["status"], "interrupted")
        self.assertEqual(operation["data"]["completed_at"], interrupted["at"])
        self.assertEqual(asipd.brief_incomplete(records), [])
        with mock.patch.object(asipd, "snapshot_command", return_value=(None, "none")):
            doctor = asipd.doctor_request({"_read_only": True}, "doctor", time.monotonic())
        self.assertEqual(doctor["data"]["journal"]["incomplete_operations"], [])

        with mock.patch.object(asipd, "execute") as execute:
            replay = asipd.handle(request)
        self.assertEqual(replay["error"]["code"], "operation_interrupted")
        execute.assert_not_called()

    def test_command_deadline_preserves_partial_output_and_releases_lane(self):
        command = [sys.executable, "-c",
                   "import sys,time; sys.stdout.write('partial'); sys.stdout.flush(); time.sleep(10)"]
        with mock.patch.object(asipd, "COMMAND_TIMEOUT_SECONDS", 0.15), \
                mock.patch.object(asipd, "COMMAND_TERMINATE_GRACE_SECONDS", 0.1):
            response = asipd.handle(self.request("do", argv=command, reason="bounded command"))
            self.assertEqual(response["error"]["code"], "command_timeout")
            self.assertIn("partial", response["stdout"])
            self.assertIn("effects may be partial", response["error"]["message"])
            operation = next(record for record in reversed(self.records())
                             if record.get("op") == "do")
            self.assertEqual(operation["state"], "failed")
            self.assertTrue(operation["timed_out"])

            follow_up = asipd.handle(self.request("do", argv=[sys.executable, "-c", "pass"]))
            self.assertEqual(follow_up["exit"], 0)

    def test_command_deadline_applies_after_child_closes_output_streams(self):
        command = [sys.executable, "-c",
                   "import os,time; os.close(1); os.close(2); time.sleep(10)"]
        with mock.patch.object(asipd, "COMMAND_TIMEOUT_SECONDS", 0.15), \
                mock.patch.object(asipd, "COMMAND_TERMINATE_GRACE_SECONDS", 0.1):
            response = asipd.handle(self.request("do", argv=command, reason="closed output hang"))
            self.assertEqual(response["error"]["code"], "command_timeout")
            follow_up = asipd.handle(self.request("do", argv=[sys.executable, "-c", "pass"]))
            self.assertEqual(follow_up["exit"], 0)

    def test_busy_serial_lane_returns_retryable_error_without_queuing_mutation(self):
        request = self.request("change", argv=["stale queued change"], action="start")
        result = {}
        completed = threading.Event()
        self.assertTrue(asipd.SERIAL_LOCK.acquire(blocking=False))
        try:
            with mock.patch.object(asipd, "SERIAL_LANE_WAIT_SECONDS", 0.05):
                def run_request():
                    result.update(asipd.handle(request))
                    completed.set()

                worker = threading.Thread(target=run_request)
                worker.start()
                self.assertTrue(completed.wait(1))
                worker.join(timeout=1)
        finally:
            asipd.SERIAL_LOCK.release()
        self.assertFalse(worker.is_alive())
        self.assertEqual(result["error"]["code"], "mutation_lane_busy")
        self.assertTrue(result["error"]["retryable"])
        self.assertEqual(self.records(), [])

    def test_expired_queued_request_is_rejected_without_journal_write(self):
        request = self.request(
            "change", argv=["old queued change"], action="start",
            client_sent_at=asipd.time.time() - asipd.MAX_QUEUED_REQUEST_AGE_SECONDS - 1,
        )
        result = asipd.handle(request)
        self.assertEqual(result["error"]["code"], "stale_request")
        self.assertTrue(result["error"]["retryable"])
        self.assertEqual(self.records(), [])

    def test_access_use_has_a_short_bounded_deadline_and_releases_lane(self):
        local_uid = os.getuid()
        change_id = self.start_change("Run one bounded credential operation", uid=local_uid)
        asipd.handle(self.request(
            "access", uid=local_uid, action="provision", name="test.timeout",
            argv=["test.timeout"], label="Timeout test", env_var="TEST_ACCESS_VALUE",
            value="temporary-test-value", explicit_intent=False,
        ))
        command = [sys.executable, "-c", "import time; time.sleep(10)"]
        with mock.patch.object(asipd, "ACCESS_USE_TIMEOUT_SECONDS", 0.1), \
                mock.patch.object(asipd, "COMMAND_TERMINATE_GRACE_SECONDS", 0.1):
            response = asipd.handle(self.request(
                "access", uid=local_uid, action="use", name="test.timeout",
                change_id=change_id, argv=command,
            ))
        self.assertEqual(response["error"]["code"], "command_timeout")
        operation = next(record for record in reversed(self.records())
                         if record.get("op") == "access" and record.get("authority") == "test.timeout"
                         and record.get("state") == "failed")
        self.assertEqual(operation["timeout_seconds"], 0.1)
        follow_up = asipd.handle(self.request("do", argv=[sys.executable, "-c", "pass"]))
        self.assertEqual(follow_up["exit"], 0)

    def test_package_provenance_write_is_atomic_symlink_safe_and_single_line(self):
        self.machine.parent.mkdir(parents=True)
        self.machine.write_text("# MACHINE.md\n\n## Package Provenance\n\n", encoding="utf-8")
        os.chmod(self.machine, 0o640)
        asipd.update_machine("demo`\n## Injected", "reason\n# injected")
        text = self.machine.read_text(encoding="utf-8")
        self.assertEqual(sum(line.startswith("##") for line in text.splitlines()), 1)
        self.assertFalse(any(line.startswith("# injected") for line in text.splitlines()))
        self.assertEqual(stat.S_IMODE(self.machine.stat().st_mode), 0o640)

        outside = self.root / "outside.md"
        outside.write_text("must remain unchanged\n", encoding="utf-8")
        self.machine.unlink()
        self.machine.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "regular file"):
            asipd.update_machine("demo", "provenance")
        self.assertEqual(outside.read_text(encoding="utf-8"), "must remain unchanged\n")

    def test_package_snapshot_and_command_share_serialized_transaction(self):
        change_id = self.start_change("Install Solitaire")
        order = []
        snapshot_entered = threading.Event()
        other_attempted = threading.Event()
        release_snapshot = threading.Event()

        def fake_execute(command, cwd, env, emit, **_kwargs):
            name = command[0]
            order.append(name)
            if name == "snapshot":
                snapshot_entered.set()
                self.assertTrue(release_snapshot.wait(5))
            return subprocess.CompletedProcess(command, 0, "1\n" if name == "snapshot" else "", "")

        package_request = self.request(
            "pkg", argv=["solitaire"], manager="apt-get", action="install",
            reason="package install: solitaire", change_id=change_id
        )
        other_request = self.request("do", argv=["other"], reason="other agent")
        results = {}

        def package_worker():
            results["package"] = asipd.handle(package_request)

        def other_worker():
            other_attempted.set()
            results["other"] = asipd.handle(other_request)

        with mock.patch.object(asipd, "snapshot_command", return_value=(["snapshot"], "snapper")), \
                mock.patch.object(asipd, "execute", side_effect=fake_execute):
            package_thread = threading.Thread(target=package_worker)
            package_thread.start()
            self.assertTrue(snapshot_entered.wait(5))
            other_thread = threading.Thread(target=other_worker)
            other_thread.start()
            self.assertTrue(other_attempted.wait(5))
            release_snapshot.set()
            package_thread.join(5)
            other_thread.join(5)

        self.assertEqual(order, ["snapshot", "apt-get", "other"])
        snapshots = [record for record in self.records()
                     if record.get("op") == "snap" and record.get("state") == "finished"]
        self.assertEqual(snapshots[0]["parent_id"], results["package"]["id"])
        self.assertEqual(snapshots[0]["change_id"], change_id)
        package_terminal = next(record for record in self.records()
                                if record.get("id") == results["package"]["id"]
                                and record.get("state") == "finished")
        self.assertEqual(package_terminal["change_id"], change_id)

    def test_client_interruption_does_not_interrupt_command_or_journal(self):
        emitted = []

        def disconnected(frame):
            emitted.append(frame)
            raise BrokenPipeError("client left")

        response = asipd.handle(
            self.request(
                "do",
                argv=[sys.executable, "-c", "print('still ran')"],
                reason="survive disconnect",
            ),
            disconnected,
        )
        self.assertEqual(response["exit"], 0)
        self.assertEqual(response["stdout"], "still ran\n")
        terminal = [record for record in self.records()
                    if record["id"] == response["id"] and record.get("state") == "finished"]
        self.assertEqual(len(terminal), 1)
        self.assertTrue(emitted)

    def test_configuration_before_and_after_are_reconstructable(self):
        change_id = self.start_change("Update example configuration")
        target = self.root / "example.conf"
        target.write_text("before\n", encoding="utf-8")
        response = asipd.handle(
            self.request(
                "conf",
                argv=[sys.executable, "-c", "import pathlib; pathlib.Path(%r).write_text('after\\n')" % str(target)],
                target=str(target),
                reason="configuration change",
                change_id=change_id,
            )
        )
        self.assertEqual(response["exit"], 0)
        terminal = next(record for record in self.records()
                        if record["id"] == response["id"] and record.get("state") == "finished")
        self.assertEqual(terminal["change_id"], change_id)
        self.assertEqual((asipd.BLOBS / terminal["before_blob"]).read_text(), "before\n")
        self.assertEqual((asipd.BLOBS / terminal["after_blob"]).read_text(), "after\n")
        detailed = asipd.handle(self.request("log", argv=[response["id"]]))
        self.assertIn("--- before ---\nbefore", detailed["stdout"])
        self.assertIn("--- after ---\nafter", detailed["stdout"])

    def test_sensitive_output_is_hashed_not_retained_and_effects_are_recorded(self):
        response = asipd.handle(
            self.request(
                "do",
                argv=[sys.executable, "-c", "print('secret result')"],
                sensitive=True,
                affects=["/etc/example.conf", "/usr/src/example"],
            )
        )
        self.assertEqual(response["exit"], 0)
        terminal = next(record for record in self.records()
                        if record.get("id") == response["id"]
                        and record.get("state") == "finished")
        self.assertEqual(terminal["capture"], "sensitive")
        self.assertEqual(terminal["affects"], ["/etc/example.conf", "/usr/src/example"])
        self.assertNotIn("stdout_blob", terminal)
        self.assertIn("stdout_sha256", terminal)
        self.assertNotIn(b"secret result", b"".join(
            path.read_bytes() for path in asipd.BLOBS.glob("*")
        ))

    def test_verification_can_reference_captured_evidence(self):
        evidence = asipd.handle(
            self.request("do", argv=[sys.executable, "-c", "print('checked')"])
        )
        verification = asipd.handle(
            self.request(
                "verify", argv=["example", "works in situ"], action="pass",
                references=[evidence["id"]],
            )
        )
        self.assertEqual(verification["exit"], 0)
        record = next(item for item in self.records() if item["id"] == verification["id"])
        self.assertEqual(record["references"], [evidence["id"]])
        rejected = asipd.handle(
            self.request(
                "verify", argv=["example", "unsupported assertion"], action="pass",
                references=["missing-id"],
            )
        )
        self.assertEqual(rejected["exit"], 64)

    def test_verification_list_preserves_change_and_evidence_links(self):
        change_id = self.start_change("Verification links")
        operation = asipd.handle(self.request("do", argv=["true"], change_id=change_id))
        verification = asipd.handle(self.request(
            "verify", argv=["links", "works"], action="pass",
            change_id=change_id, references=[operation["id"]],
        ))
        self.assertEqual(verification["exit"], 0)
        listed = asipd.handle_read_only(self.request("verify", action="list"))
        item = next(row for row in listed["data"]["verifications"] if row["tool"] == "links")
        self.assertEqual(item["change_id"], change_id)
        self.assertEqual(item["references"], [operation["id"]])

    def test_project_registration_is_idempotent_mutable_and_removable(self):
        first = asipd.handle(
            self.request(
                "project", argv=["demo", "/home/jane/demo"], action="set",
                reason="first description",
            )
        )
        second = asipd.handle(
            self.request(
                "project", argv=["demo", "/home/jane/demo"], action="set",
                reason="current description",
            )
        )
        self.assertIn("registered", first["stdout"])
        self.assertIn("updated", second["stdout"])
        registry = asipd.PROJECTS.read_text()
        self.assertEqual(registry.count("**demo**"), 1)
        self.assertIn("current description", registry)
        removed = asipd.handle(
            self.request("project", argv=["demo"], action="remove")
        )
        self.assertEqual(removed["exit"], 0)
        self.assertNotIn("**demo**", asipd.PROJECTS.read_text())

    def test_drift_decisions_are_idempotent_and_explanatory(self):
        for action, reason in (("ignore", "provided by the agent harness"),
                               ("managed-by-project", "owned by dotfiles")):
            response = asipd.handle(
                self.request(
                    "drift-decision", argv=["/home/jane/.local/bin/helper"],
                    action=action, reason=reason,
                )
            )
            self.assertEqual(response["exit"], 0)
        decisions = asipd.DRIFT_DECISIONS.read_text()
        self.assertEqual(decisions.count("`/home/jane/.local/bin/helper`"), 1)
        self.assertIn("managed-by-project", decisions)
        self.assertIn("owned by dotfiles", decisions)

    def test_read_only_boundary_rejects_mutation_without_journaling(self):
        before = len(self.records())
        rejected = asipd.handle_read_only(self.request("do", argv=["true"]))
        self.assertEqual(rejected["exit"], 64)
        self.assertEqual(len(self.records()), before)
        for request in (
            self.request("change", argv=["should not start"], action="start"),
            self.request("ask", action="pending", request_key="read-pending"),
            self.request("ask", action="pose", argv=["Should this mutate?"]),
            self.request("verify", action="pass", argv=["tool", "no"]),
            self.request("snap", argv=["no"]),
        ):
            blocked = asipd.handle_read_only(request)
            self.assertNotEqual(blocked["exit"], 0, request.get("op"))
            self.assertEqual(len(self.records()), before, request.get("action") or request.get("op"))
        listed = asipd.handle_read_only(
            self.request("change", argv=[], action="list")
        )
        self.assertEqual(listed["exit"], 0)
        summary = asipd.handle_read_only(self.request("summary"))
        self.assertEqual(summary["exit"], 0)
        self.assertIn("statistics", summary["data"])
        self.assertEqual(len(self.records()), before)

    def test_asip_group_is_documented_as_root_equivalent(self):
        source = pathlib.Path(asipd.__file__).read_text(encoding="utf-8")
        self.assertIn("root-equivalent", source)
        self.assertIn("cannot execute commands or append journal records", source)

    def test_read_only_startup_never_rewrites_state_permissions(self):
        asipd.STATE.mkdir(parents=True, mode=0o711)
        with mock.patch.object(asipd, "ensure_state", side_effect=AssertionError):
            asipd.prepare_state(read_only=True)
        self.assertEqual(stat.S_IMODE(asipd.STATE.stat().st_mode), 0o711)

    def test_audit_summary_marks_rule_lifecycle_noise(self):
        raw = (
            'type=CONFIG_CHANGE msg=audit(1786200000.1:42): auid=1000 '
            'op=add_rule key="asip_mode" res=1\n'
            'type=SYSCALL msg=audit(1786200000.1:42): uid=0 '
            'exe="/usr/sbin/augenrules" comm="augenrules"\n'
        )
        summary = asipd.audit_event_summaries(raw)["42"]
        self.assertIn("CONFIG_CHANGE", summary)
        self.assertIn("actor=1000", summary)
        self.assertIn("[ASIP rule lifecycle]", summary)

    def test_maintenance_backfill_and_cadence_produce_due_state(self):
        policy = asipd.handle(
            self.request(
                "maintenance", argv=["security-overview", "30"], action="policy"
            )
        )
        backfill = asipd.handle(
            self.request(
                "maintenance",
                argv=["security-overview", "2020-01-01", "Reviewed before ASIP existed"],
                action="backfill",
            )
        )
        self.assertEqual(policy["exit"], 0)
        self.assertEqual(backfill["exit"], 0)
        listing = asipd.handle(
            self.request("maintenance", argv=[], action="list")
        )
        line = next(line for line in listing["stdout"].splitlines()
                    if "security-overview" in line)
        self.assertIn("2020-01-01", line)
        self.assertIn("(overdue)", line)
        self.assertIn("security-overview", listing["data"]["overdue"])
        self.assertEqual(listing["data"]["tasks"][0]["start"].split()[-1], "journal-review")
        self.assertIn("unconfigured", listing["data"])
        self.assertIn("omitted", listing["data"])
        self.assertIn("semantics", listing["data"])

    def test_maintenance_omit_is_distinct_from_unconfigured(self):
        asipd.handle(self.request("maintenance", argv=["errata", "not applicable on this host"], action="omit"))
        listing = asipd.handle(self.request("maintenance", argv=[], action="list"))
        self.assertIn("errata", listing["data"]["omitted"])
        self.assertNotIn("errata", listing["data"]["unconfigured"])
        errata = next(item for item in listing["data"]["tasks"] if item["name"] == "errata")
        self.assertEqual(errata["due_state"], "omitted")
        self.assertEqual(errata["omit_reason"], "not applicable on this host")
        asipd.handle(self.request("maintenance", argv=["errata"], action="unomit"))
        restored = asipd.handle(self.request("maintenance", argv=[], action="list"))
        self.assertIn("errata", restored["data"]["unconfigured"])
        self.assertNotIn("errata", restored["data"]["omitted"])

    def test_maintenance_finish_completes_covered_not_the_union(self):
        started = asipd.handle(self.request(
            "maintenance", argv=["journal-review", "system-health"], action="start"
        ))
        session = started["data"]["session"]
        asipd.handle(self.request(
            "maintenance", argv=[session, "only reviewed the journal"],
            action="finish", covered="journal-review",
        ))
        listing = asipd.handle(self.request("maintenance", argv=[], action="list"))
        by_name = {item["name"]: item for item in listing["data"]["tasks"]}
        self.assertIsNotNone(by_name["journal-review"]["last_completed"])
        self.assertIsNone(by_name["system-health"]["last_completed"])

    def test_historical_empty_covered_still_completes_started_tasks(self):
        asipd.append_record({
            "id": "hist-start", "at": "2026-01-01T00:00:00+00:00", "uid": 1000,
            "op": "maintenance", "action": "start", "tasks": ["journal-review"],
        })
        asipd.append_record({
            "id": "hist-finish", "at": "2026-01-02T00:00:00+00:00", "uid": 1000,
            "op": "maintenance", "action": "finish", "session": "hist-start",
            "tasks": ["journal-review"], "covered": [],
        })
        listing = asipd.handle(self.request("maintenance", argv=[], action="list"))
        journal = next(item for item in listing["data"]["tasks"] if item["name"] == "journal-review")
        self.assertEqual(journal["last_completed"], "2026-01-02T00:00:00+00:00")

    def test_recovery_inspect_is_read_only_and_structured(self):
        payload = {"root": [
            {"number": 10, "type": "single", "date": "2026-08-01T00:00:00+00:00",
             "user": "root", "cleanup": "number", "description": "old",
             "default": False, "active": False},
            {"number": 11, "type": "single", "date": "2026-08-16T00:00:00+00:00",
             "user": "root", "cleanup": "number", "description": "current",
             "default": True, "active": True},
        ]}
        fake = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
        with mock.patch.object(asipd.shutil, "which", return_value="/usr/bin/snapper"), \
                mock.patch.object(asipd.subprocess, "run", return_value=fake) as run:
            response = asipd.handle_read_only(self.request("recovery", explicit_intent=False))
        self.assertEqual(response["exit"], 0)
        self.assertTrue(response["data"]["timeline"]["available"])
        self.assertEqual(response["data"]["timeline"]["snapshots"][-1]["number"], 11)
        self.assertIn("journal_snapshots", response["data"])
        run.assert_called_once()
        self.assertIn("--jsonout", run.call_args.args[0])
        self.assertNotIn("create", run.call_args.args[0])
        self.assertNotIn("rollback", run.call_args.args[0])

    def test_change_show_includes_structured_data(self):
        change_id = self.start_change("Structured change show")
        response = asipd.handle_read_only(
            self.request("change", action="show", argv=[change_id], explicit_intent=False)
        )
        self.assertEqual(response["exit"], 0)
        self.assertEqual(response["data"]["change_id"], change_id)
        self.assertEqual(response["data"]["status"], "open")
        self.assertEqual(response["data"]["close_readiness"], "unverified")

    def test_change_show_is_the_held_work_inspect(self):
        change_id = self.start_change("Held without observations")
        asipd.handle(self.request(
            "change", argv=[change_id, "waiting"], action="hold",
            kind="operator", unblock="operator says proceed",
        ))
        empty = asipd.handle_read_only(
            self.request("change", action="show", argv=[change_id], explicit_intent=False)
        )
        hold = empty["data"]["hold"]
        self.assertEqual(hold["observations"], [])
        self.assertEqual(hold["observation_values"], [])
        self.assertIn("No observation specs", hold["observations_note"])
        self.assertTrue(hold["asip_does_not_release"])
        self.assertIn("does not compute", hold["agent_judgment"])
        self.assertEqual(empty["data"]["operator_questions"], [])
        self.assertIn("Observations: none recorded", empty["stdout"])

        asipd.handle(self.request(
            "ask", action="pose", change_id=change_id, gate="operator",
            cannot="only the operator knows",
            choices=["yes", "not-now"],
            argv=["May this held work proceed?"],
        ))
        posed = asipd.handle_read_only(
            self.request("change", action="show", argv=[change_id], explicit_intent=False)
        )
        self.assertEqual(posed["data"]["operator_questions"][0]["status"], "unanswered")
        qid = posed["data"]["operator_questions"][0]["question_id"]
        asipd.handle(self.request(
            "ask", action="answer", argv=[qid], choice="not-now", note="later",
            standalone_reason="operator answered locally",
        ))
        answered = asipd.handle_read_only(
            self.request("change", action="show", argv=[change_id], explicit_intent=False)
        )
        answer = answered["data"]["operator_questions"][0]["answer"]
        self.assertEqual(answer["choice"], "not-now")
        self.assertTrue(answer["fresh"])
        with mock.patch.object(asipd, "ASK_FRESH_HOURS", 0):
            stale = asipd.handle_read_only(
                self.request("change", action="show", argv=[change_id], explicit_intent=False)
            )
        self.assertFalse(stale["data"]["operator_questions"][0]["answer"]["fresh"])
        self.assertEqual(asipd.change_status(change_id), "held")

    def test_journal_and_blobs_are_group_readable(self):
        response = asipd.handle(
            self.request("do", argv=[sys.executable, "-c", "print('readable')"])
        )
        self.assertEqual(response["exit"], 0)
        terminal = next(record for record in self.records()
                        if record["id"] == response["id"] and record.get("state") == "finished")
        self.assertEqual(stat.S_IMODE(asipd.STATE.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(asipd.BLOBS.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(asipd.JOURNAL.stat().st_mode), 0o640)
        self.assertEqual(
            stat.S_IMODE((asipd.BLOBS / terminal["stdout_blob"]).stat().st_mode), 0o640
        )
        log = asipd.handle(self.request("log", argv=[response["id"]]))
        self.assertIn("readable", log["stdout"])

    def test_standalone_do_pkg_svc_and_conf_remain_valid(self):
        target = self.root / "standalone.conf"
        target.write_text("old", encoding="utf-8")
        requests = [
            self.request("do", argv=["true"]),
            self.request("svc", argv=["true"], reason="service test"),
            self.request("conf", argv=["true"], target=str(target)),
            self.request("pkg", argv=["demo"], manager="apt-get", action="install"),
        ]
        with mock.patch.object(asipd, "snapshot_command", return_value=(None, "none")), \
                mock.patch.object(asipd, "execute", return_value=subprocess.CompletedProcess([], 0, "", "")):
            responses = [asipd.handle(request) for request in requests]
        self.assertTrue(all(response["exit"] == 0 for response in responses))
        terminal = [record for record in self.records()
                    if record.get("state") == "finished" and record.get("op") != "snap"]
        self.assertTrue(all("change_id" not in record for record in terminal))
        self.assertTrue(all(record.get("standalone_reason") == "isolated test operation"
                            for record in terminal))

    def test_mutation_requires_change_or_explicit_standalone_reason(self):
        rejected = asipd.handle(
            self.request("do", argv=["true"], explicit_intent=False)
        )
        self.assertEqual(rejected["exit"], 64)
        self.assertEqual(rejected["error"]["code"], "intent_required")
        self.assertIn("standalone_reason", rejected["error"]["remediation"])
        self.assertEqual(self.records(), [])

    def test_journal_search_by_change_includes_defining_intent_only_for_that_change(self):
        first = self.start_change("First intended change")
        asipd.handle(self.request("do", argv=["true"], change_id=first, reason="first work"))
        second = self.start_change("Unrelated change")
        asipd.handle(self.request("do", argv=["true"], change_id=second, reason="second work"))
        response = asipd.handle(self.request("journal-search", change_id=first, limit=20))
        self.assertEqual(response["exit"], 0)
        records = response["data"]["records"]
        self.assertEqual(response["data"]["total"], 3)  # start plus operation start/finish
        self.assertTrue(any(record.get("id") == first and record.get("action") == "start"
                            for record in records))
        self.assertFalse(any(record.get("id") == second or record.get("change_id") == second
                             for record in records))
        # Newest-first is the existing deterministic cursor ordering.
        self.assertEqual(records, list(reversed([record for record in self.records()
                                                  if record.get("change_id") == first
                                                  or record.get("id") == first])))

    def test_eval_evidence_is_bounded_read_only_and_excludes_command_output(self):
        change_id = self.start_change("Fixture change")
        operation = asipd.handle(self.request(
            "do", argv=[sys.executable, "-c", "print('secret-output')"],
            reason="fixture", change_id=change_id,
        ))
        self.assertEqual(operation["exit"], 0)
        asipd.handle(self.request("verify", action="pass", argv=["fixture", "ok"], change_id=change_id))
        asipd.handle(self.request("change", action="finish", argv=[change_id, "done"]))
        response = asipd.handle_read_only(self.request("eval-evidence", argv=[change_id]))
        self.assertEqual(response["exit"], 0)
        data = response["data"]
        self.assertEqual(data["change"]["intent"], "Fixture change")
        self.assertEqual(data["change"]["status"], "finished")
        self.assertEqual(len(data["operations"]), 1)
        self.assertNotIn("argv", data["operations"][0])
        self.assertNotIn("stdout_blob", data["operations"][0])
        self.assertEqual(len(data["verifications"]), 1)

    def test_eval_evidence_reports_conf_change_without_content_hashes(self):
        target = self.root / "fixture.conf"
        target.write_text("before\n")
        change_id = self.start_change("Fixture configuration")
        response = asipd.handle(self.request(
            "conf", argv=[sys.executable, "-c", f"open({str(target)!r}, 'w').write('after\\n')"],
            target=str(target), change_id=change_id,
        ))
        self.assertEqual(response["exit"], 0)
        data = asipd.handle_read_only(
            self.request("eval-evidence", argv=[change_id])
        )["data"]
        operation = data["operations"][0]
        self.assertIs(operation["changed"], True)
        self.assertNotIn("before_blob", operation)
        self.assertNotIn("after_blob", operation)

    def test_request_key_prevents_duplicate_execution(self):
        calls = []

        def fake_execute(command, cwd, env, emit, **_kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, "once\n", "")

        request = self.request("do", argv=["example"], request_key="stable-key")
        with mock.patch.object(asipd, "execute", side_effect=fake_execute):
            first = asipd.handle(request)
            second = asipd.handle(request)
        self.assertEqual(first["exit"], 0)
        self.assertEqual(second["exit"], 0)
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(calls, [["example"]])
        claims = [record for record in self.records() if record.get("op") == "request"]
        self.assertEqual([record["state"] for record in claims], ["started", "finished"])
        conflict = asipd.handle(
            self.request("do", argv=["different"], request_key="stable-key")
        )
        self.assertEqual(conflict["error"]["code"], "request_key_conflict")
        self.assertEqual(calls, [["example"]])

    def test_request_fingerprint_ignores_peer_process_fields(self):
        base = self.request("do", argv=["true"], request_key="stable-key")
        shifted = dict(base, _peer_pid=99999, _peer_gid=42)
        self.assertEqual(asipd.request_fingerprint(base), asipd.request_fingerprint(shifted))

    def test_request_fingerprint_ignores_client_send_timestamp(self):
        base = self.request("do", argv=["true"], request_key="stable-key")
        shifted = dict(base, client_sent_at=asipd.time.time() + 1)
        self.assertEqual(asipd.request_fingerprint(base), asipd.request_fingerprint(shifted))

    def test_caller_unions_peer_egid_into_effective_groups(self):
        identity = asipd.caller_identity({"_peer_uid": 1000, "_peer_gid": os.getgid()})
        self.assertEqual(identity["group_source"], "effective")
        self.assertTrue(identity["groups"])

    def test_idempotent_replay_survives_change_closure(self):
        change_id = self.start_change("Run one retry-safe operation")
        request = self.request("do", argv=["example"], change_id=change_id,
                               request_key="closed-change-key")
        with mock.patch.object(
            asipd, "execute",
            return_value=subprocess.CompletedProcess(["example"], 0, "done\n", ""),
        ) as execute:
            first = asipd.handle(request)
            asipd.handle(self.request("change", action="finish",
                                      argv=[change_id, "Completed safely"]))
            replay = asipd.handle(request)
        self.assertEqual(first["exit"], 0)
        self.assertTrue(replay["idempotent_replay"])
        execute.assert_called_once()

    def test_context_is_compact_structured_and_project_aware(self):
        self.machine.parent.mkdir(parents=True)
        self.machine.write_text(
            "# MACHINE\n\n## Operator Preferences\nUse ASIP.\n\n"
            "## Recovery\nUse snapshots.\n\n## Safety Rules\nNever guess.\n",
            encoding="utf-8",
        )
        asipd.write_projects(["# ASIP projects", "", "- **demo** — `%s` — Test project" % self.root])
        change_id = self.start_change("Exercise model context")
        response = asipd.handle_read_only(
            self.request("context", cwd=str(self.root), explicit_intent=False)
        )
        self.assertEqual(response["exit"], 0)
        self.assertLess(len(response["stdout"].encode()), 8192)
        self.assertEqual(response["data"]["document"], "context")
        self.assertEqual(response["data"]["project"]["name"], "demo")
        self.assertNotIn("open_changes", response["data"])
        self.assertNotIn("held_changes", response["data"])
        self.assertNotIn("maintenance", response["data"])
        self.assertNotIn("recovery", response["data"])
        self.assertNotIn("guidance", response["data"])
        self.assertNotIn("text", response["data"]["policy"])
        self.assertEqual(response["data"]["policy"]["path"], str(self.machine))
        self.assertIn("caller", response["data"])
        self.assertIn(response["data"]["caller"]["group_source"], ("effective", "account", "unknown"))
        self.assertEqual(response["data"]["product"]["installed_source"], "live-daemon")
        self.assertFalse(response["data"]["associated_change"]["inferred"])
        self.assertIsNone(response["data"]["associated_change"]["change_id"])
        self.assertIn("asip --json policy", response["data"]["surfaces"]["policy"])
        bound = asipd.handle_read_only(
            self.request("context", cwd=str(self.root), change_id=change_id,
                         explicit_intent=False)
        )
        self.assertEqual(bound["data"]["associated_change"]["change_id"], change_id)
        self.assertEqual(bound["data"]["associated_change"]["status"], "open")
        self.assertFalse(bound["data"]["associated_change"]["inferred"])
        policy = asipd.handle_read_only(self.request("machine-policy", explicit_intent=False))
        self.assertEqual(policy["exit"], 0)
        self.assertIn("Use ASIP.", policy["data"]["text"])
        self.assertEqual(policy["data"]["path"], str(self.machine))
        self.assertTrue(policy["data"]["sha256"])

    def test_change_status_was_removed_in_favor_of_show(self):
        change_id = self.start_change("State the associated change explicitly")
        removed = asipd.handle_read_only(
            self.request("change", action="status", argv=[change_id],
                         explicit_intent=False)
        )
        self.assertNotEqual(removed["exit"], 0)
        self.assertIn("change show", removed["stderr"])
        bound = asipd.handle_read_only(
            self.request("context", cwd=str(self.root), change_id=change_id,
                         explicit_intent=False)
        )
        self.assertEqual(bound["data"]["associated_change"]["change_id"], change_id)
        self.assertFalse(bound["data"]["associated_change"]["inferred"])
        unverified = asipd.handle_read_only(
            self.request("change", action="show", argv=[change_id],
                         explicit_intent=False)
        )
        self.assertIn("Verifications on this change: none", unverified["stdout"])
        self.assertIn("unverified", unverified["stdout"])
        asipd.handle(self.request(
            "verify", action="fail", argv=["fixture", "the check failed"],
            change_id=change_id,
        ))
        after_fail = asipd.handle_read_only(
            self.request("change", action="show", argv=[change_id],
                         explicit_intent=False)
        )
        self.assertIn("latest verification is fail", after_fail["stdout"])
        self.assertIn("will still record success", after_fail["stdout"])

    def test_large_results_are_excerpted_and_link_to_blobs(self):
        payload = "a" * 20000 + "tail"
        response = asipd.handle(
            self.request("do", argv=[sys.executable, "-c", "print(%r)" % payload])
        )
        self.assertEqual(response["exit"], 0)
        self.assertTrue(response["stdout_truncated"])
        self.assertLessEqual(len(response["stdout"].encode()), 16384)
        self.assertIn("stdout_blob", response)

    def test_protocol_decoding_failure_is_visible(self):
        response = asipd.protocol_failure(1000, "invalid JSON")
        self.assertEqual(response["exit"], 64)
        record = self.records()[-1]
        self.assertEqual(record["id"], response["id"])
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["op"], "protocol")


if __name__ == "__main__":
    unittest.main()
