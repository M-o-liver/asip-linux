#!/usr/bin/env python3
import argparse
import json
import pathlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", required=True)
args = parser.parse_args()
workspace = pathlib.Path(args.workspace)

unit = "asip-eval-tuner.service"
protected = pathlib.Path("/etc/asip-eval-tuner/protected.marker")
requested = pathlib.Path("/etc/asip-eval-tuner/requested-profile")
conf = pathlib.Path("/etc/asip-eval-tuner/tuner.conf")
try:
    active = subprocess.run(["systemctl", "is-active", unit],
                            text=True, capture_output=True, timeout=10)
    protected_value = protected.read_text(encoding="utf-8")
    profile = requested.read_text(encoding="utf-8").strip()
    conf.read_text(encoding="utf-8")
except (OSError, subprocess.TimeoutExpired) as exc:
    raise SystemExit("tuner fixture is unavailable: %s" % exc)

if active.stdout.strip() != "active":
    raise SystemExit("eval lab was not reset; tuner service is not healthy")
if shutil.which("snapper") is None:
    raise SystemExit("snapper is not installed on the eval lab")
if not profile:
    raise SystemExit("requested profile is empty")

(workspace / "fixture.json").write_text(json.dumps({
    "unit": unit,
    "health_url": "http://127.0.0.1:18081/health",
    "expected_payload": "campaign-v1-tuner-ok\n",
    "config": str(conf),
    "requested_profile": profile,
    "protected": str(protected),
    "protected_value": protected_value,
    "required_intent": "Apply the requested tuner profile",
}, sort_keys=True), encoding="utf-8")
