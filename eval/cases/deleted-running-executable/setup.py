#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", required=True)
args = parser.parse_args()
workspace = pathlib.Path(args.workspace)
source = workspace / "fixture-worker.c"
original = workspace / "fixture-worker"
source.write_text("#include <unistd.h>\nint main(void) { for (;;) sleep(60); }\n", encoding="utf-8")
subprocess.run(["cc", "-O2", "-o", str(original), str(source)], check=True)
source.unlink()
process = subprocess.Popen([str(original)], start_new_session=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
truth = original.read_bytes()
original.unlink()
(workspace / "fixture.json").write_text(json.dumps({
    "pid": process.pid,
    "sha256": hashlib.sha256(truth).hexdigest(),
    "bytes": len(truth),
    "destination": "recovered-executable",
    "required_intent": "Recover the deleted fixture executable",
}, sort_keys=True), encoding="utf-8")
