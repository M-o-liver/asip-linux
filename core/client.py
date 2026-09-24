#!/usr/bin/env python3
"""Small JSON client kept separate so the public client stays POSIX sh."""
import argparse
import json
import os
import pathlib
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.protocol import SCHEMA_VERSION, VERSION, UnixClient, is_read_only

parser = argparse.ArgumentParser()
parser.add_argument("--socket", default="/run/asip/sock")
parser.add_argument("--op", required=True)
parser.add_argument("--reason", default="")
parser.add_argument("--manager")
parser.add_argument("--action")
parser.add_argument("--cwd", default=os.getcwd())
parser.add_argument("--target")
parser.add_argument("--source")
parser.add_argument("--evidence")
parser.add_argument("--references")
parser.add_argument("--affects")
parser.add_argument("--sensitive", action="store_true")
parser.add_argument("--covered")
parser.add_argument("--kind")
parser.add_argument("--unblock")
parser.add_argument("--observe", action="append")
parser.add_argument("--gate")
parser.add_argument("--cannot")
parser.add_argument("--choices")
parser.add_argument("--choice")
parser.add_argument("--note")
parser.add_argument("--name")
parser.add_argument("--label")
parser.add_argument("--env-var")
parser.add_argument("--free-text", action="store_true")
parser.add_argument("--change-id")
parser.add_argument("--standalone-reason")
parser.add_argument("--request-key")
parser.add_argument("--offset", type=int)
parser.add_argument("--limit", type=int)
parser.add_argument("--client-name", default="asip-cli")
parser.add_argument("--client-version", default=VERSION)
parser.add_argument("--response-json", action="store_true")
parser.add_argument("--json", action="store_true")
parser.add_argument("argv", nargs="*")
def main(argv=None):
    args = parser.parse_args(argv)
    request = {
        "schema_version": SCHEMA_VERSION,
        "op": args.op,
        "reason": args.reason,
        "cwd": args.cwd,
        "argv": args.argv,
        "client": {"name": args.client_name, "version": args.client_version},
        "transport": "cli",
    }
    if args.manager:
        request["manager"] = args.manager
    if args.action:
        request["action"] = args.action
    if args.target:
        request["target"] = args.target
    if args.source:
        request["source"] = args.source
    if args.evidence:
        request["evidence"] = args.evidence
    if args.references:
        request["references"] = [item for item in args.references.split(",") if item]
    if args.affects:
        request["affects"] = [item for item in args.affects.split(",") if item]
    if args.sensitive:
        request["sensitive"] = True
    if args.covered:
        request["covered"] = args.covered
    if args.kind:
        request["kind"] = args.kind
    if args.unblock:
        request["unblock"] = args.unblock
    if args.observe:
        request["observations"] = [item for item in args.observe if item]
    if args.gate:
        request["gate"] = args.gate
    if args.cannot:
        request["cannot"] = args.cannot
    if args.choices:
        request["choices"] = [item for item in args.choices.split(",") if item]
    if args.choice:
        request["choice"] = args.choice
    if args.note:
        request["note"] = args.note
    if args.name:
        request["name"] = args.name
    if args.label:
        request["label"] = args.label
    if args.env_var:
        request["env_var"] = args.env_var
    if args.free_text:
        request["free_text"] = True
    if args.change_id:
        request["change_id"] = args.change_id
    if args.standalone_reason:
        request["standalone_reason"] = args.standalone_reason
    if args.request_key:
        request["request_key"] = args.request_key
    if args.offset is not None:
        request["offset"] = args.offset
    if args.limit is not None:
        request["limit"] = args.limit

    streamed = {"stdout": False, "stderr": False}

    def stream_output(stream, data):
        streamed[stream] = True
        destination = sys.stdout if stream == "stdout" else sys.stderr
        destination.write(data)
        destination.flush()

    try:
        response = UnixClient(args.socket).call(
            request, None if (args.json or args.response_json) else stream_output
        ).response
    except PermissionError:
        required_group = "asip-read" if args.socket == "/run/asip/read.sock" else "asip"
        uid = os.getuid()
        try:
            import grp
            import pwd
            user = pwd.getpwuid(uid).pw_name
            account = []
            for gid in os.getgrouplist(user, pwd.getpwuid(uid).pw_gid):
                try:
                    account.append(grp.getgrgid(gid).gr_name)
                except KeyError:
                    account.append(str(gid))
            effective = []
            for gid in os.getgroups():
                try:
                    effective.append(grp.getgrgid(gid).gr_name)
                except KeyError:
                    effective.append(str(gid))
            account_text = ",".join(account) if account else "(none)"
            effective_text = ",".join(effective) if effective else "(none)"
            in_account = required_group in account
            in_effective = required_group in effective
        except (KeyError, ImportError, OSError):
            user = str(uid)
            account_text = "unavailable"
            effective_text = "unavailable"
            in_account = False
            in_effective = False
        extra = ""
        if in_account and not in_effective:
            extra = (
                " Account membership includes '%s', but this process token does not; "
                "start a new login or harness from a host context that preserves the "
                "group. In a confined runner, do not use sg: it may fail before ASIP "
                "starts."
                % required_group
            )
        sys.stderr.write(
            "asip: permission denied connecting to %s; uid=%s user=%s "
            "effective groups=[%s] account groups=[%s] is missing '%s' in the "
            "process token. Help and --help do not need the socket. Restart the "
            "login or harness with the required group in its process token.%s\n"
            % (args.socket, uid, user, effective_text, account_text,
               required_group, extra)
        )
        raise SystemExit(77)
    except FileNotFoundError:
        sys.stderr.write(
            "asip: socket %s does not exist; verify that ASIP is installed and its "
            "systemd socket unit is active.\n" % args.socket
        )
        raise SystemExit(69)
    except ConnectionRefusedError:
        sys.stderr.write(
            "asip: connection to %s was refused; check the corresponding ASIP "
            "systemd socket and service.\n" % args.socket
        )
        raise SystemExit(69)
    except ConnectionError:
        sys.stderr.write(
            "asip: the daemon transitioned before completing this request; inspect "
            "the associated change and operation state before deciding whether to retry.\n"
        )
        raise SystemExit(75)
    if args.json:
        if "data" in response:
            payload = response["data"]
        else:
            payload = {
                "id": response.get("id", ""),
                "exit": response.get("exit", 1),
                "stdout": response.get("stdout", ""),
                "stderr": response.get("stderr", ""),
            }
            if response.get("error"):
                payload["error"] = response["error"]
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        raise SystemExit(response.get("exit", 1))
    if args.response_json:
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        raise SystemExit(response.get("exit", 1))
    if not streamed["stdout"]:
        sys.stdout.write(response.get("stdout", ""))
    if not streamed["stderr"]:
        sys.stderr.write(response.get("stderr", ""))
    error = response.get("error")
    if isinstance(error, dict) and error.get("remediation"):
        sys.stderr.write("asip: next step: %s\n" % error["remediation"])
    if is_read_only({"op": args.op, "action": args.action}):
        raise SystemExit(response.get("exit", 1))
    summary = "asip: journal %s (exit %s, %sms)" % (
        response.get("id", "unknown"), response.get("exit", 1),
        response.get("duration_ms", 0)
    )
    if response.get("idempotent_replay"):
        summary += "; idempotent replay"
    if response.get("capture") == "sensitive":
        summary += "; sensitive output omitted, sha256 stdout=%s stderr=%s" % (
            response.get("stdout_sha256", "unknown"), response.get("stderr_sha256", "unknown")
        )
    elif response.get("output_bytes", 0) >= 65536:
        summary += "; blobs stdout=%s stderr=%s" % (
            response.get("stdout_blob", "unknown"), response.get("stderr_blob", "unknown")
        )
    sys.stderr.write(summary + "\n")
    raise SystemExit(response.get("exit", 1))


if __name__ == "__main__":
    main()
