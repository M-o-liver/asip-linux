#!/usr/bin/env python3
"""Unix-socket transport for the ASIP Core services.

Authorization is entirely the socket DAC plus kernel-supplied peer credentials.
This module owns framing and serving; :mod:`core.daemon` owns request policy and
domain dispatch.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import socket
import struct
import sys
import threading

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core import daemon


MAX_CONNECTION_WORKERS = 64


def serve(read_only: bool = False) -> None:
    if os.geteuid() != 0:
        raise SystemExit("ASIP Core must run as root")
    daemon.prepare_state(read_only)
    socket_path = daemon.READ_SOCKET if read_only else daemon.SOCKET
    if os.environ.get("LISTEN_FDS") == "1":
        server = socket.fromfd(3, socket.AF_UNIX, socket.SOCK_STREAM)
    else:
        pathlib.Path(socket_path).parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(socket_path)
        os.chmod(socket_path, 0o660)
        try:
            group = daemon.asip_read_gid() if read_only else daemon.asip_gid()
            os.chown(socket_path, 0, group)
        except KeyError:
            raise SystemExit("asip-read group does not exist" if read_only
                             else "asip group does not exist")
        server.listen(32)
    workers = threading.BoundedSemaphore(MAX_CONNECTION_WORKERS)
    with server:
        while True:
            connection, _ = server.accept()
            _spawn_connection(connection, read_only, workers)


def _spawn_connection(connection: socket.socket, read_only: bool,
                      workers: threading.BoundedSemaphore):
    if not workers.acquire(blocking=False):
        try:
            response = daemon.structured_error(
                "server_busy", "ASIP connection limit reached",
                exit_code=75, retryable=True,
                remediation="retry after another local request completes",
            )
            connection.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode())
        except OSError:
            pass
        finally:
            connection.close()
        return None
    worker = threading.Thread(
        target=_serve_worker, args=(connection, read_only, workers),
        name="asip-ipc", daemon=True,
    )
    try:
        worker.start()
    except RuntimeError:
        workers.release()
        connection.close()
        return None
    return worker


def _serve_worker(connection: socket.socket, read_only: bool,
                  workers: threading.BoundedSemaphore) -> None:
    try:
        with connection:
            _serve_connection(connection, read_only)
    finally:
        workers.release()


def _serve_connection(connection: socket.socket, read_only: bool) -> None:
    # A local peer can connect and never finish a frame. Bound each worker so
    # abandoned partial requests cannot exhaust the IPC pool.
    connection.settimeout(daemon.SOCKET_REQUEST_TIMEOUT_SECONDS)
    peer = connection.getsockopt(
        socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
    )
    peer_pid, peer_uid, peer_gid = struct.unpack("3i", peer)
    try:
        raw = connection.makefile("rb").readline(daemon.MAX_REQUEST + 1)
        if not raw or len(raw) > daemon.MAX_REQUEST:
            response = (daemon.fail("invalid request size") if read_only else
                        daemon.protocol_failure(peer_uid, "invalid request size"))
        else:
            response = _dispatch(raw, peer_pid, peer_uid, peer_gid, connection, read_only)
    except OSError as exc:
        response = (daemon.fail(f"request read failed: {exc}") if read_only else
                    daemon.protocol_failure(peer_uid, f"request read failed: {exc}"))
    try:
        connection.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode())
    except OSError:
        # Domain work is already terminal and durable. A vanished reader must
        # not interrupt the privileged service.
        pass


def _dispatch(raw: bytes, peer_pid: int, peer_uid: int, peer_gid: int,
              connection: socket.socket, read_only: bool) -> dict:
    try:
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        request["_peer_uid"] = peer_uid
        request["_peer_pid"] = peer_pid
        request["_peer_gid"] = peer_gid

        def emit(frame):
            payload = json.dumps(frame, separators=(",", ":")) + "\n"
            connection.sendall(payload.encode())

        return daemon.handle_read_only(request) if read_only else daemon.handle(request, emit)
    except json.JSONDecodeError:
        return (daemon.fail("invalid JSON") if read_only else
                daemon.protocol_failure(peer_uid, "invalid JSON"))
    except ValueError as exc:
        return (daemon.fail(str(exc)) if read_only else
                daemon.protocol_failure(peer_uid, str(exc)))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--serve-read-only", action="store_true")
    args = parser.parse_args(argv)
    if args.serve == args.serve_read_only:
        parser.error("usage: asipd --serve | --serve-read-only")
    serve(read_only=args.serve_read_only)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
