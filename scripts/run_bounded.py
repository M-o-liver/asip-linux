#!/usr/bin/env python3
"""Run one command in a bounded process group.

Test and qualification commands often launch helper processes. Inheriting a
new process group lets a timeout or interruption clean up those helpers
instead of leaving them behind on the operator's desktop. Child output is
inherited, rather than captured, so a verbose suite cannot consume the
parent's memory while it runs.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time


def _stop_group(process: subprocess.Popen[object], grace: float) -> None:
    """Ask the process group to exit, then force it if necessary."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=max(0.0, grace))
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        pass


def run(command: list[str], timeout: float, grace: float) -> int:
    if timeout <= 0 or grace < 0:
        raise ValueError("timeout must be positive and grace must be non-negative")
    process = subprocess.Popen(command, start_new_session=True)
    started = time.monotonic()
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        elapsed = time.monotonic() - started
        print(
            f"run_bounded: timeout after {elapsed:.1f}s; terminating process group",
            file=sys.stderr,
            flush=True,
        )
        _stop_group(process, grace)
        return 124
    except KeyboardInterrupt:
        print("run_bounded: interrupted; terminating process group", file=sys.stderr, flush=True)
        _stop_group(process, grace)
        return 130


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--grace", type=float, default=5.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = list(args.command)
    if command[:1] == ["--"]:
        command.pop(0)
    if not command:
        parser.error("a command is required after --")
    try:
        return run(command, args.timeout, args.grace)
    except OSError as exc:
        print(f"run_bounded: could not start command: {exc}", file=sys.stderr)
        return 127
    except ValueError as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
