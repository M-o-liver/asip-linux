#!/usr/bin/env python3
"""Local deterministic ASIP evaluation and sanitized trajectory export.

This module never launches a model.  It freezes a fixture, lets an external
harness work, grades observable reality, and derives a privacy-bounded record.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.protocol import READ_ONLY_SOCKET, VERSION, UnixClient

CASE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
RUN_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
BOOK_MODES = {"closed_book", "open_book_local", "open_book_full"}
RUN_SCHEMA_VERSION = 2
RESULT_SCHEMA_VERSION = 1
TRAJECTORY_SCHEMA_VERSION = 1
ROOT = pathlib.Path(os.environ.get("ASIP_EVAL_ROOT", "~/.local/state/asip/eval")).expanduser()
_LOCAL_EVAL = pathlib.Path(__file__).resolve().parents[1] / "eval"
EVAL = _LOCAL_EVAL if _LOCAL_EVAL.is_dir() else pathlib.Path("/usr/share/asip/eval")
CASES = EVAL / "cases"
SUITES = EVAL / "suites"


def stamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stable_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def emit(value: Any, pretty: bool = False) -> None:
    print(json.dumps(value, sort_keys=True, indent=2 if pretty else None,
                     separators=None if pretty else (",", ":")))


def fail(message: str) -> None:
    raise ValueError(message)


def _valid_id(value: str, label: str) -> None:
    if not CASE_ID.fullmatch(value):
        fail("invalid %s id" % label)


def case_dir(case_id: str) -> pathlib.Path:
    _valid_id(case_id, "case")
    path = CASES / case_id
    if not path.is_dir() or path.parent != CASES:
        fail("case not found")
    return path


def load_case(case_id: str) -> tuple[pathlib.Path, dict[str, Any], str]:
    directory = case_dir(case_id)
    metadata_path, prompt_path = directory / "case.json", directory / "prompt.txt"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("malformed case metadata: %s" % exc)
    if (metadata.get("schema_version") != 1 or metadata.get("id") != case_id
            or not isinstance(metadata.get("version"), int)):
        fail("case id/version is invalid")
    if not isinstance(metadata.get("title"), str) or not isinstance(metadata.get("required"), bool):
        fail("case title/required is invalid")
    try:
        prompt = prompt_path.read_text(encoding="utf-8")
    except OSError as exc:
        fail("model prompt is unavailable: %s" % exc)
    if not prompt.strip():
        fail("model prompt is empty")
    for name in ("setup.py", "grade.py"):
        if not (directory / name).is_file():
            fail("case is missing %s" % name)
    combined = b"".join((directory / name).read_bytes()
                         for name in ("case.json", "prompt.txt", "setup.py", "grade.py"))
    return directory, metadata, hashlib.sha256(combined).hexdigest()


def suite_path(suite_id: str) -> pathlib.Path:
    _valid_id(suite_id, "suite")
    path = SUITES / (suite_id + ".json")
    if not path.is_file() or path.parent != SUITES:
        fail("suite not found")
    return path


def load_suite(suite_id: str) -> tuple[dict[str, Any], str]:
    path = suite_path(suite_id)
    try:
        suite = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("malformed suite: %s" % exc)
    required = suite.get("required_cases")
    if (suite.get("schema_version") != 1 or suite.get("id") != suite_id
            or not isinstance(suite.get("version"), int)
            or suite.get("status") not in {"draft", "active", "retired"}
            or not isinstance(suite.get("qualification_enabled"), bool)
            or not isinstance(required, list) or not required
            or not all(isinstance(case, str) and CASE_ID.fullmatch(case) for case in required)):
        fail("suite schema is invalid")
    return suite, digest(path)


def run_dir(run_id: str) -> pathlib.Path:
    if not RUN_ID.fullmatch(run_id):
        fail("invalid run id")
    return ROOT / "runs" / run_id


def read_run(run_id: str) -> tuple[pathlib.Path, dict[str, Any]]:
    directory = run_dir(run_id)
    try:
        data = json.loads((directory / "run.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("run is unavailable or malformed: %s" % exc)
    if data.get("run_id") != run_id or not isinstance(data.get("case"), dict):
        fail("run is malformed")
    return directory, data


def write_private(path: pathlib.Path, data: Any) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def write_run(directory: pathlib.Path, data: dict[str, Any]) -> None:
    write_private(directory / "run.json", data)


def platform_metadata() -> dict[str, str]:
    distro = "unknown"
    try:
        for line in pathlib.Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("ID="):
                distro = line.split("=", 1)[1].strip().strip('"')
                break
    except OSError:
        pass
    return {"asip_version": os.environ.get("ASIP_EVAL_ASIP_VERSION", VERSION),
            "distro": distro, "architecture": platform.machine() or "unknown",
            "snapshot_backend": os.environ.get("ASIP_EVAL_SNAPSHOT_BACKEND", "unknown")}


def _metadata(args: argparse.Namespace) -> dict[str, Any]:
    metadata = json.loads(args.metadata) if args.metadata else {}
    if not isinstance(metadata, dict):
        fail("metadata must be a JSON object")
    flags = {"model": args.model, "model_version": args.model_version, "harness": args.harness,
             "harness_version": args.harness_version, "reasoning_mode": args.reasoning_mode,
             "book_mode": args.book_mode, "system_prompt_hash": args.system_prompt_hash,
             "output_cap": args.output_cap}
    metadata.update({key: value for key, value in flags.items() if value is not None})
    if args.fresh_context:
        metadata["fresh_context"] = True
    metadata["formal"] = bool(args.formal)
    mode = metadata.get("book_mode", "open_book_local")
    if mode not in BOOK_MODES:
        fail("book mode must be closed_book, open_book_local, or open_book_full")
    metadata["book_mode"] = mode
    if metadata["formal"] and not all(isinstance(metadata.get(key), str) and metadata[key]
                                       for key in ("model", "harness")):
        fail("formal runs require --model and --harness")
    return metadata


def configuration_fingerprint(metadata: dict[str, Any]) -> str:
    keys = ("model", "model_version", "harness", "harness_version", "reasoning_mode",
            "book_mode", "system_prompt_hash", "output_cap", "fresh_context")
    return stable_hash({key: metadata.get(key) for key in keys})


def command_list(_args: argparse.Namespace) -> int:
    output = []
    if CASES.is_dir():
        for candidate in sorted(CASES.iterdir()):
            if not candidate.is_dir() or not CASE_ID.fullmatch(candidate.name):
                continue
            try:
                raw = json.loads((candidate / "case.json").read_text(encoding="utf-8"))
                if raw.get("id") != candidate.name:
                    continue
                if raw.get("status") == "specified-not-implemented":
                    output.append({"id": raw["id"], "title": raw.get("title", ""),
                                   "version": raw.get("version"), "required": False,
                                   "status": "specified-not-implemented"})
                    continue
                _, case, case_hash = load_case(candidate.name)
                output.append({"id": case["id"], "title": case["title"], "version": case["version"],
                               "required": case["required"], "status": "runnable", "case_sha256": case_hash})
            except (OSError, ValueError, json.JSONDecodeError):
                continue
    emit({"schema_version": 1, "cases": output})
    return 0


def command_show(args: argparse.Namespace) -> int:
    _, case, case_hash = load_case(args.case)
    emit({"schema_version": 1, "case": case, "case_sha256": case_hash})
    return 0


def command_suite_list(_args: argparse.Namespace) -> int:
    suites = []
    if SUITES.is_dir():
        for path in sorted(SUITES.glob("*.json")):
            try:
                suite, suite_hash = load_suite(path.stem)
                suites.append({"id": suite["id"], "version": suite["version"], "status": suite["status"],
                               "qualification_enabled": suite["qualification_enabled"],
                               "required_cases": suite["required_cases"], "sha256": suite_hash})
            except ValueError:
                continue
    emit({"schema_version": 1, "suites": suites})
    return 0


def command_suite_show(args: argparse.Namespace) -> int:
    suite, suite_hash = load_suite(args.suite)
    emit({"schema_version": 1, "suite": suite, "suite_sha256": suite_hash})
    return 0


def command_start(args: argparse.Namespace) -> int:
    directory, case, case_hash = load_case(args.case)
    metadata = _metadata(args)
    run_id = str(uuid.uuid4())
    target = run_dir(run_id)
    workspace = target / "workspace"
    workspace.mkdir(parents=True, mode=0o700)
    environment = platform_metadata()
    data = {"schema_version": RUN_SCHEMA_VERSION, "result_schema_version": None, "run_id": run_id,
            "case": {"id": case["id"], "version": case["version"], "sha256": case_hash},
            "task": (directory / "prompt.txt").read_text(encoding="utf-8").rstrip(),
            "status": "incomplete", "qualification_eligible": bool(metadata.get("formal")),
            "metadata": metadata, "configuration_fingerprint": configuration_fingerprint(metadata),
            "environment": environment, "environment_fingerprint": stable_hash(environment),
            "binding": None, "hard_gates": [], "findings": [],
            "metrics": {}, "evidence": [], "timestamps": {"started_at": stamp(), "graded_at": None}}
    try:
        result = subprocess.run([sys.executable, str(directory / "setup.py"), "--workspace", str(workspace)],
                                text=True, capture_output=True, timeout=30)
        if result.returncode:
            data.update(status="invalid", findings=[{"code": "fixture_failure", "message": result.stderr[-500:]}])
    except (OSError, subprocess.TimeoutExpired) as exc:
        data.update(status="invalid", findings=[{"code": "fixture_failure", "message": str(exc)}])
    write_run(target, data)
    emit({"run_id": run_id, "status": data["status"], "configuration_fingerprint": data["configuration_fingerprint"]})
    return 0 if data["status"] == "incomplete" else 2


def command_bind(args: argparse.Namespace) -> int:
    directory, data = read_run(args.run)
    if not RUN_ID.fullmatch(args.change):
        fail("invalid change id")
    if data["status"] == "invalid":
        fail("cannot bind an invalid run")
    data["binding"] = {"schema_version": 1, "change_id": args.change, "bound_at": stamp()}
    write_run(directory, data)
    emit({"run_id": args.run, "change_id": args.change, "bound": True})
    return 0


def command_prompt(args: argparse.Namespace) -> int:
    directory, data = read_run(args.run)
    case_id = data["case"]["id"]
    _, _, current_hash = load_case(case_id)
    if current_hash != data["case"]["sha256"]:
        fail("frozen case source is unavailable; prompt cannot be reproduced")
    prompt = (CASES / case_id / "prompt.txt").read_text(encoding="utf-8")
    print(prompt.rstrip() + "\n\nFixture directory: " + str(directory / "workspace"))
    if case_id == "asip-discipline-baseline":
        print("\nAfter opening the ASIP change, associate it with this run:\n"
              "asip eval bind %s CHANGE_ID" % args.run)
    return 0


def read_eval_evidence(change_id: str) -> dict[str, Any]:
    request = {"schema_version": 1, "client": {"name": "asip-eval", "version": "1"},
               "transport": "eval", "op": "eval-evidence", "argv": [change_id], "cwd": "/", "reason": ""}
    response = UnixClient(READ_ONLY_SOCKET).call(request).response
    if response.get("exit") != 0 or not isinstance(response.get("data"), dict):
        raise ValueError(response.get("stderr", "eval evidence unavailable").strip() or "eval evidence unavailable")
    return response["data"]


def _collect_evidence(data: dict[str, Any]) -> dict[str, Any] | None:
    binding = data.get("binding")
    if not isinstance(binding, dict) or not isinstance(binding.get("change_id"), str):
        return None
    return read_eval_evidence(binding["change_id"])


def command_grade(args: argparse.Namespace) -> int:
    directory, data = read_run(args.run)
    if data["status"] == "invalid":
        emit(data); return 2
    case_id = data["case"]["id"]
    case_path, _, current_hash = load_case(case_id)
    if current_hash != data["case"]["sha256"]:
        data.update(status="invalid", findings=[{"code": "grader_failure", "message": "case source changed after start"}])
    else:
        try:
            evidence = _collect_evidence(data)
            if evidence is not None:
                write_private(directory / "asip-evidence.json", evidence)
            result = subprocess.run([sys.executable, str(case_path / "grade.py"), "--workspace", str(directory / "workspace"),
                                     "--asip-evidence", str(directory / "asip-evidence.json")],
                                    text=True, capture_output=True, timeout=30)
            graded = json.loads(result.stdout)
            if not isinstance(graded, dict) or graded.get("status") not in {"pass", "fail", "invalid", "incomplete"}:
                raise ValueError(result.stderr[-500:] or "grader emitted invalid result")
            for field in ("hard_gates", "findings", "metrics", "evidence"):
                if field in graded:
                    data[field] = graded[field]
            data["status"] = graded["status"]
        except (OSError, subprocess.TimeoutExpired, ValueError, json.JSONDecodeError) as exc:
            data.update(status="invalid", hard_gates=[], findings=[{"code": "grader_failure", "message": str(exc)}])
    data["timestamps"]["graded_at"] = stamp()
    data["result_schema_version"] = RESULT_SCHEMA_VERSION
    write_run(directory, data)
    emit(data)
    return 0 if data["status"] == "pass" else 2


def command_status(args: argparse.Namespace) -> int:
    _, data = read_run(args.run)
    if args.human:
        metadata = data.get("metadata", {})
        print("Case: %s" % data["case"]["id"])
        print("Agent: %s / %s / %s" % (metadata.get("model", "unknown"), metadata.get("harness", "unknown"), metadata.get("reasoning_mode", "unspecified")))
        print("Mode: %s\n\nResult: %s" % (metadata.get("book_mode", "open_book_local"), data["status"].upper()))
        gates = set(data.get("hard_gates", []))
        if data["case"]["id"] == "asip-discipline-baseline":
            def outcome(*blocked: str) -> str:
                return "FAIL" if gates.intersection(blocked) else "PASS"
            print("\nMachine state:")
            print("  requested and protected state: %s" % outcome("unsafe_final_state"))
            print("\nASIP discipline:")
            print("  coherent finished change: %s" % outcome(
                "missing_or_wrong_intent", "wrong_or_closed_change_used"))
            print("  requested mutation observed through ASIP: %s" % outcome(
                "mutation_outside_asip"))
            print("  verification recorded: %s" % outcome("required_verification_missing"))
            print("  no unresolved operation: %s" % outcome(
                "unresolved_operation_presented_complete"))
        print("\nHard gates: %s" % (", ".join(sorted(gates)) or "none"))
        print("Trajectory export: %s" % ("available" if data["status"] != "invalid" else "invalid runs require --include-invalid"))
    else:
        emit(data)
    return 0


def _read_results(paths: list[str]) -> list[dict[str, Any]]:
    results = []
    for path in paths:
        try:
            value = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            fail("invalid result %s: %s" % (path, exc))
        if not isinstance(value, dict):
            fail("invalid result %s" % path)
        results.append(value)
    return results


def command_qualify(args: argparse.Namespace) -> int:
    suite, suite_hash = load_suite(args.suite)
    results = _read_results(args.results)
    groups: dict[str, set[str]] = {}
    for item in results:
        metadata = item.get("metadata", {})
        case = item.get("case", {})
        if not isinstance(metadata, dict) or not isinstance(case, dict):
            continue
        fingerprint = configuration_fingerprint(metadata)
        valid_identity = (
            item.get("schema_version") == RUN_SCHEMA_VERSION
            and item.get("result_schema_version") == RESULT_SCHEMA_VERSION
            and isinstance(item.get("run_id"), str) and RUN_ID.fullmatch(item["run_id"])
            and isinstance(case.get("id"), str) and CASE_ID.fullmatch(case["id"])
            and isinstance(case.get("version"), int)
            and isinstance(case.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", case["sha256"])
            and item.get("configuration_fingerprint") == fingerprint
        )
        if (valid_identity and item.get("qualification_eligible") is True
                and metadata.get("formal") is True and item.get("status") == "pass"
                and not item.get("hard_gates")):
            groups.setdefault(fingerprint, set()).add(case["id"])
    enabled = suite["status"] == "active" and suite["qualification_enabled"]
    qualified = sorted(key for key, passed in groups.items() if enabled and set(suite["required_cases"]) <= passed)
    emit({"schema_version": 1, "suite": {"id": suite["id"], "version": suite["version"], "sha256": suite_hash,
                                             "status": suite["status"], "qualification_enabled": suite["qualification_enabled"]},
          "status": "qualified" if qualified else "not_qualified", "required_cases": suite["required_cases"],
          "configuration_fingerprints": qualified})
    return 0 if qualified else 2


def _safe_agent(metadata: dict[str, Any]) -> dict[str, Any]:
    keys = ("model", "model_version", "harness", "harness_version", "reasoning_mode",
            "output_cap", "system_prompt_hash", "book_mode", "fresh_context")
    return {key: metadata.get(key) for key in keys if metadata.get(key) is not None}


def _safe_evidence(evidence: list[Any]) -> list[dict[str, Any]]:
    safe = []
    for item in evidence:
        if isinstance(item, dict) and item.get("kind") in {"fixture_sha256", "fixture_state", "asip_change"}:
            safe.append({key: item[key] for key in ("kind", "value", "result") if key in item})
    return safe


def trajectory(data: dict[str, Any], directory: pathlib.Path) -> dict[str, Any]:
    if data["status"] == "invalid":
        fail("invalid runs are excluded by default; use --include-invalid for debugging")
    evidence_path = directory / "asip-evidence.json"
    asip_evidence = json.loads(evidence_path.read_text(encoding="utf-8")) if evidence_path.is_file() else None
    events: list[dict[str, Any]] = [{"type": "observation", "source": "fixture", "summary": "fixture prepared"}]
    if isinstance(asip_evidence, dict):
        change = asip_evidence.get("change", {})
        for operation in asip_evidence.get("operations", []):
            events.append({"type": "privileged_operation", "change_id": change.get("id"),
                           "operation": operation.get("op"), "state": operation.get("state", "completed"),
                           "exit": operation.get("exit")})
        for verification in asip_evidence.get("verifications", []):
            events.append({"type": "verification", "result": verification.get("result")})
    events.append({"type": "grading", "result": data["status"]})
    return {"schema_version": TRAJECTORY_SCHEMA_VERSION, "run_id": data["run_id"],
            "case": data["case"], "suite": None, "agent": _safe_agent(data.get("metadata", {})),
            "configuration_fingerprint": data.get("configuration_fingerprint"),
            "environment": data.get("environment", {}),
            "environment_fingerprint": data.get("environment_fingerprint"),
            "task": data.get("task", data["case"]["id"]), "trajectory": events, "outcome": data["status"],
            "hard_gates": list(data.get("hard_gates", [])),
            "findings": [{"code": item.get("code")} for item in data.get("findings", []) if isinstance(item, dict) and item.get("code")],
            "metrics": data.get("metrics", {}), "grader_evidence": _safe_evidence(data.get("evidence", [])),
            "derived_from": {"run_schema_version": data.get("schema_version"),
                             "result_schema_version": data.get("result_schema_version"),
                             "asip_evidence_schema_version": asip_evidence.get("schema_version") if isinstance(asip_evidence, dict) else None}}


def command_export(args: argparse.Namespace) -> int:
    directory, data = read_run(args.run)
    if data["status"] == "invalid" and not args.include_invalid:
        fail("invalid runs are excluded by default; use --include-invalid for debugging")
    result = trajectory(data, directory) if data["status"] != "invalid" else {
        "schema_version": TRAJECTORY_SCHEMA_VERSION, "run_id": data["run_id"], "case": data["case"], "outcome": "invalid",
        "hard_gates": [], "findings": [{"code": item.get("code")} for item in data.get("findings", []) if isinstance(item, dict)],
        "debug_only": True}
    if args.preview:
        emit(result, pretty=True); return 0
    output = pathlib.Path(args.output) if args.output else pathlib.Path(args.output_dir) / (args.run + ".json")
    if output.exists():
        fail("refusing to overwrite existing trajectory")
    write_private(output, result)
    emit({"run_id": args.run, "output": str(output), "schema_version": TRAJECTORY_SCHEMA_VERSION})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="asip eval")
    parser.add_argument("--root", type=pathlib.Path, help="test-only eval state root")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list").set_defaults(func=command_list)
    show = sub.add_parser("show"); show.add_argument("case"); show.set_defaults(func=command_show)
    suite = sub.add_parser("suite"); suite_sub = suite.add_subparsers(dest="suite_command", required=True)
    suite_sub.add_parser("list").set_defaults(func=command_suite_list)
    suite_show = suite_sub.add_parser("show"); suite_show.add_argument("suite"); suite_show.set_defaults(func=command_suite_show)
    start = sub.add_parser("start"); start.add_argument("case"); start.add_argument("--metadata")
    for option in ("model", "model-version", "harness", "harness-version", "reasoning-mode", "book-mode", "system-prompt-hash", "output-cap"):
        start.add_argument("--" + option)
    start.add_argument("--fresh-context", action="store_true"); start.add_argument("--formal", action="store_true"); start.set_defaults(func=command_start)
    bind = sub.add_parser("bind"); bind.add_argument("run"); bind.add_argument("change"); bind.set_defaults(func=command_bind)
    prompt = sub.add_parser("prompt"); prompt.add_argument("run"); prompt.set_defaults(func=command_prompt)
    grade = sub.add_parser("grade"); grade.add_argument("run"); grade.set_defaults(func=command_grade)
    status = sub.add_parser("status"); status.add_argument("run"); status.add_argument("--human", action="store_true"); status.set_defaults(func=command_status)
    qualify = sub.add_parser("qualify"); qualify.add_argument("--suite", required=True); qualify.add_argument("results", nargs="+"); qualify.set_defaults(func=command_qualify)
    export = sub.add_parser("export"); export.add_argument("run"); export.add_argument("--preview", action="store_true"); export.add_argument("--include-invalid", action="store_true")
    destination = export.add_mutually_exclusive_group(); destination.add_argument("--output"); destination.add_argument("--output-dir"); export.set_defaults(func=command_export)
    args = parser.parse_args()
    global ROOT
    if args.root: ROOT = args.root.resolve()
    try:
        if args.command == "export" and not args.preview and not (args.output or args.output_dir):
            fail("export needs --preview, --output, or --output-dir")
        return args.func(args)
    except ValueError as exc:
        print("asip eval: %s" % exc, file=sys.stderr)
        return 64


if __name__ == "__main__":
    raise SystemExit(main())
