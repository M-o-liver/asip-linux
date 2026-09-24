import contextlib
import io
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

from cli import eval as asip_eval


class EvalTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.patch = mock.patch.object(asip_eval, "ROOT", self.root)
        self.patch.start()

    def tearDown(self):
        for fixture in self.root.glob("runs/*/workspace/fixture.json"):
            try:
                __import__("os").kill(json.loads(fixture.read_text())["pid"], 15)
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                pass
        self.patch.stop()
        self.temp.cleanup()

    def invoke(self, *argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            old = __import__("sys").argv
            __import__("sys").argv = ["asip_eval.py", *argv]
            try:
                code = asip_eval.main()
            finally:
                __import__("sys").argv = old
        return code, output.getvalue()

    def qualification_result(self, case, *, run_id, metadata=None, gates=None,
                             eligible=True, status="pass"):
        metadata = metadata or {
            "model": "fixture", "harness": "harness",
            "book_mode": "open_book_local", "formal": True,
        }
        return {
            "schema_version": asip_eval.RUN_SCHEMA_VERSION,
            "result_schema_version": asip_eval.RESULT_SCHEMA_VERSION,
            "run_id": run_id,
            "case": {"id": case, "version": 1, "sha256": "a" * 64},
            "status": status,
            "qualification_eligible": eligible,
            "hard_gates": gates or [],
            "metadata": metadata,
            "configuration_fingerprint": asip_eval.configuration_fingerprint(metadata),
        }

    def test_case_loading_rejects_traversal_and_lists_runnable_cases(self):
        code, output = self.invoke("list")
        self.assertEqual(code, 0)
        self.assertIn("deleted-running-executable", output)
        self.assertIn("failed-service-recovery", output)
        self.assertIn("sole-management-network-change", output)
        code, _ = self.invoke("show", "../deleted-running-executable")
        self.assertEqual(code, 64)

    def test_run_freezes_case_and_prompt_does_not_leak_grader_terms(self):
        code, output = self.invoke("start", "asip-discipline-baseline", "--metadata", '{"model":"fixture"}')
        self.assertEqual(code, 0)
        run_id = json.loads(output)["run_id"]
        code, prompt = self.invoke("prompt", run_id)
        self.assertEqual(code, 0)
        self.assertIn("Complete this small Linux administration task", prompt)
        self.assertIn("desired-value.txt", prompt)
        self.assertNotIn("unsafe_final_state", prompt)
        self.assertNotIn("sha256", prompt)

    @unittest.skipUnless(shutil.which("cc"), "fixture compiler unavailable")
    def test_grader_reports_incomplete_fail_and_pass_deterministically(self):
        code, output = self.invoke("start", "deleted-running-executable")
        self.assertEqual(code, 0)
        run_id = json.loads(output)["run_id"]
        workspace = self.root / "runs" / run_id / "workspace"
        code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(result)["status"], "incomplete")
        fixture = json.loads((workspace / "fixture.json").read_text())
        target = workspace / "recovered-executable"
        target.write_bytes(b"wrong")
        target.chmod(0o755)
        code, result = self.invoke("grade", run_id)
        failed = json.loads(result)
        self.assertEqual(code, 2)
        self.assertEqual(failed["status"], "fail")
        self.assertIn("unsafe_final_state", failed["hard_gates"])
        target.write_bytes((pathlib.Path("/proc") / str(fixture["pid"]) / "exe").read_bytes())
        target.chmod(0o755)
        change = "11111111-1111-4111-8111-111111111111"
        self.assertEqual(self.invoke("bind", run_id, change)[0], 0)
        evidence = {
            "schema_version": 1,
            "change": {"id": change, "intent": fixture["required_intent"], "status": "finished"},
            "operations": [],
            "verifications": [{"op": "verify", "result": "pass", "change_id": change}],
            "incomplete_operations": [],
        }
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(result)["status"], "pass")
        # Fixture process is deliberately ended by the test, never by grading.
        __import__("os").kill(fixture["pid"], 15)

    def test_malformed_run_is_invalid_input_not_a_model_failure(self):
        run_id = "11111111-1111-4111-8111-111111111111"
        directory = self.root / "runs" / run_id
        directory.mkdir(parents=True)
        (directory / "run.json").write_text("not json")
        code, _ = self.invoke("status", run_id)
        self.assertEqual(code, 64)

    def test_exploratory_pass_cannot_create_a_qualification_claim(self):
        result = self.root / "exploratory.json"
        metadata = {"model": "fixture", "harness": "harness",
                    "book_mode": "open_book_local", "formal": False}
        result.write_text(json.dumps(self.qualification_result(
            "deleted-running-executable",
            run_id="11111111-1111-4111-8111-111111111111",
            metadata=metadata, eligible=False,
        )))
        code, output = self.invoke("qualify", "--suite", "authority-v1", str(result))
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output)["status"], "not_qualified")

    def test_draft_suite_never_qualifies_even_when_every_case_passes(self):
        paths = []
        for index, case in enumerate(("asip-discipline-baseline", "deleted-running-executable",
                                      "sole-management-network-change"), 1):
            path = self.root / (case + ".json")
            path.write_text(json.dumps(self.qualification_result(
                case, run_id=f"{index:08d}-1111-4111-8111-111111111111",
            )))
            paths.append(str(path))
        code, output = self.invoke("qualify", "--suite", "authority-v1", *paths)
        self.assertEqual(code, 2)
        result = json.loads(output)
        self.assertEqual(result["suite"]["status"], "draft")
        self.assertEqual(result["status"], "not_qualified")

    def test_active_suite_requires_every_case_same_fingerprint_and_no_hard_gate(self):
        suites = self.root / "suites"
        suites.mkdir()
        (suites / "fixture-v1.json").write_text(json.dumps({
            "schema_version": 1, "id": "fixture-v1", "version": 1, "status": "active",
            "qualification_enabled": True, "required_cases": ["one", "two"],
        }))
        run_ids = iter((
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
        ))
        def write(name, case, metadata, gates=None, fingerprint=None):
            path = self.root / name
            result = self.qualification_result(
                case, run_id=next(run_ids), metadata=metadata, gates=gates,
            )
            if fingerprint is not None:
                result["configuration_fingerprint"] = fingerprint
            path.write_text(json.dumps(result))
            return str(path)
        common = {"model": "fixture", "harness": "harness",
                  "book_mode": "open_book_local", "formal": True}
        one = write("one.json", "one", common)
        two = write("two.json", "two", common)
        with mock.patch.object(asip_eval, "SUITES", suites):
            code, output = self.invoke("qualify", "--suite", "fixture-v1", one, two)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output)["status"], "qualified")
            mismatched = write("mismatch.json", "two", {**common, "harness": "other"})
            self.assertEqual(self.invoke("qualify", "--suite", "fixture-v1", one, mismatched)[0], 2)
            failed = write("failed.json", "two", common, ["required_verification_missing"])
            self.assertEqual(self.invoke("qualify", "--suite", "fixture-v1", one, failed)[0], 2)
            forged = write("forged.json", "two", common, fingerprint="f" * 64)
            self.assertEqual(self.invoke("qualify", "--suite", "fixture-v1", one, forged)[0], 2)

    def test_discipline_case_requires_bound_verified_closed_asip_change(self):
        code, output = self.invoke("start", "asip-discipline-baseline", "--model", "fixture", "--harness", "test")
        self.assertEqual(code, 0)
        run_id = json.loads(output)["run_id"]
        workspace = self.root / "runs" / run_id / "workspace"
        fixture = json.loads((workspace / "fixture.json").read_text())
        (workspace / fixture["requested"]).write_text(fixture["desired"])
        change = "11111111-1111-4111-8111-111111111111"
        self.assertEqual(self.invoke("bind", run_id, change)[0], 0)
        evidence = {
            "schema_version": 1,
            "change": {"id": change, "intent": fixture["required_intent"], "status": "finished"},
            "operations": [{"op": "conf", "state": "finished", "exit": 0, "change_id": change,
                            "target": str(workspace / fixture["requested"]), "changed": True}],
            "verifications": [{"op": "verify", "result": "pass", "change_id": change}],
            "incomplete_operations": [],
        }
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(result)["status"], "pass")
        code, human = self.invoke("status", run_id, "--human")
        self.assertEqual(code, 0)
        self.assertIn("requested mutation observed through ASIP: PASS", human)
        evidence["verifications"] = []
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 2)
        self.assertIn("required_verification_missing", json.loads(result)["hard_gates"])
        evidence["verifications"] = [{"op": "verify", "result": "fail", "change_id": change}]
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 2)
        self.assertIn("required_verification_missing", json.loads(result)["hard_gates"])
        evidence["verifications"] = [{"op": "verify", "result": "pass", "change_id": change}]
        evidence["change"]["status"] = "failed"
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 2)
        self.assertIn("wrong_or_closed_change_used", json.loads(result)["hard_gates"])
        evidence["change"]["status"] = "finished"
        (workspace / fixture["protected"]).unlink()
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            code, result = self.invoke("grade", run_id)
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(result)["status"], "invalid")

    @unittest.skipUnless(shutil.which("cc"), "fixture compiler unavailable")
    def test_export_is_stable_private_and_excludes_extension_metadata(self):
        code, output = self.invoke("start", "deleted-running-executable", "--model", "fixture",
                                   "--harness", "test", "--metadata", '{"hostname":"private","path":"/home/private"}')
        self.assertEqual(code, 0)
        run_id = json.loads(output)["run_id"]
        workspace = self.root / "runs" / run_id / "workspace"
        fixture = json.loads((workspace / "fixture.json").read_text())
        target = workspace / fixture["destination"]
        target.write_bytes((pathlib.Path("/proc") / str(fixture["pid"]) / "exe").read_bytes())
        target.chmod(0o755)
        change = "11111111-1111-4111-8111-111111111111"
        self.assertEqual(self.invoke("bind", run_id, change)[0], 0)
        evidence = {
            "schema_version": 1,
            "change": {"id": change, "intent": fixture["required_intent"], "status": "finished"},
            "operations": [],
            "verifications": [{"op": "verify", "result": "pass", "change_id": change}],
            "incomplete_operations": [],
        }
        with mock.patch.object(asip_eval, "read_eval_evidence", return_value=evidence):
            self.assertEqual(self.invoke("grade", run_id)[0], 0)
        code, preview = self.invoke("export", run_id, "--preview")
        self.assertEqual(code, 0)
        self.assertNotIn("private", preview)
        trajectory = json.loads(preview)
        self.assertIn("Recover an exact", trajectory["task"])
        self.assertEqual(trajectory["agent"]["model"], "fixture")
        self.assertRegex(trajectory["environment_fingerprint"], r"^[0-9a-f]{64}$")
        output_path = self.root / "trajectory.json"
        self.assertEqual(self.invoke("export", run_id, "--output", str(output_path))[0], 0)
        self.assertEqual(output_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(preview), json.loads(output_path.read_text()))

    def test_invalid_run_is_excluded_from_export_by_default(self):
        code, output = self.invoke("start", "asip-discipline-baseline")
        self.assertEqual(code, 0)
        run_id = json.loads(output)["run_id"]
        directory, run = asip_eval.read_run(run_id)
        run["status"] = "invalid"
        run["findings"] = [{"code": "fixture_failure", "message": "/home/private"}]
        asip_eval.write_run(directory, run)
        self.assertEqual(self.invoke("export", run_id, "--preview")[0], 64)
        code, output = self.invoke("export", run_id, "--preview", "--include-invalid")
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)["debug_only"])

    def test_new_case_prompts_do_not_name_hidden_mechanisms(self):
        rollback = (pathlib.Path(asip_eval.CASES) / "snapshot-config-rollback" / "prompt.txt").read_text()
        intake = (pathlib.Path(asip_eval.CASES) / "private-tmp-intake" / "prompt.txt").read_text()
        self.assertIn("asip-eval-tuner", rollback)
        self.assertNotIn("worker_count", rollback)
        self.assertNotIn("proposed.conf", rollback)
        self.assertIn("asip-eval-intake", intake)
        self.assertNotIn("PrivateTmp", intake)
        self.assertNotIn("private tmp", intake.lower())

    def test_failed_service_prompt_does_not_name_the_broken_setting(self):
        prompt = (pathlib.Path(asip_eval.CASES) / "failed-service-recovery" / "prompt.txt").read_text()
        self.assertIn("asip-eval-widget", prompt)
        self.assertNotIn("bind_address", prompt)
        self.assertNotIn("widget.conf", prompt)
        self.assertNotIn("unsafe_final_state", prompt)

    def test_failed_service_setup_without_lab_unit_is_invalid_not_agent_fail(self):
        code, output = self.invoke("start", "failed-service-recovery")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output)["status"], "invalid")


if __name__ == "__main__":
    unittest.main()
