"""Adversarial framing tests for the local Unix transport."""

from __future__ import annotations

import json
import socket
import threading
import time
import unittest
from unittest import mock

from core import server


class ServerFramingTestCase(unittest.TestCase):
    def _run_connection(self, connection, errors):
        try:
            with connection:
                server._serve_connection(connection, read_only=False)
        except BaseException as exc:  # surface failures in the test thread
            errors.append(exc)

    def _exchange(self, payload, *, request_limit=None, timeout=None):
        server_side, client_side = socket.socketpair()
        client_side.settimeout(1.0)
        errors = []
        thread = threading.Thread(target=self._run_connection, args=(server_side, errors))
        max_patch = (mock.patch.object(server.daemon, "MAX_REQUEST", request_limit)
                     if request_limit is not None else mock.patch.object(server.daemon, "MAX_REQUEST",
                                                                          server.daemon.MAX_REQUEST))
        timeout_patch = (mock.patch.object(server.daemon, "SOCKET_REQUEST_TIMEOUT_SECONDS", timeout)
                         if timeout is not None else mock.patch.object(
                             server.daemon, "SOCKET_REQUEST_TIMEOUT_SECONDS",
                             server.daemon.SOCKET_REQUEST_TIMEOUT_SECONDS))
        failure_patch = mock.patch.object(
            server.daemon, "protocol_failure",
            side_effect=lambda _uid, message: {"ok": False, "message": message},
        )
        with max_patch, timeout_patch, failure_patch:
            thread.start()
            try:
                if payload is not None:
                    client_side.sendall(payload)
                reader = client_side.makefile("rb")
                try:
                    response = reader.readline()
                finally:
                    reader.close()
                thread.join(timeout=1.0)
            finally:
                client_side.close()
                if thread.is_alive():
                    server_side.close()
                    thread.join(timeout=1.0)
        self.assertFalse(thread.is_alive(), "connection handler did not finish")
        self.assertEqual(errors, [])
        self.assertTrue(response.endswith(b"\n"))
        return json.loads(response)

    def test_invalid_json_is_reported_without_dispatch(self):
        with mock.patch.object(server.daemon, "handle") as handle:
            response = self._exchange(b"{not-json}\n")
        self.assertFalse(response["ok"])
        handle.assert_not_called()

    def test_oversized_frame_is_rejected_before_dispatch(self):
        with mock.patch.object(server.daemon, "handle") as handle:
            response = self._exchange(b"x" * 40 + b"\n", request_limit=32)
        self.assertFalse(response["ok"])
        handle.assert_not_called()

    def test_incomplete_frame_times_out_and_releases_accept_lane(self):
        started = time.monotonic()
        response = self._exchange(b'{"op":"brief"}', timeout=0.05)
        self.assertFalse(response["ok"])
        self.assertLess(time.monotonic() - started, 0.5)

    def test_json_cannot_forge_kernel_peer_credentials(self):
        server_side, client_side = socket.socketpair()
        try:
            request = json.dumps({"op": "brief", "_peer_uid": 0, "_peer_pid": 1,
                                  "_peer_gid": 0}).encode()
            with mock.patch.object(server.daemon, "handle", return_value={"ok": True}) as handle:
                server._dispatch(request, 4321, 1234, 5678, server_side, read_only=False)
            actual = handle.call_args.args[0]
            self.assertEqual((actual["_peer_pid"], actual["_peer_uid"], actual["_peer_gid"]),
                             (4321, 1234, 5678))
        finally:
            server_side.close()
            client_side.close()

    def test_accept_loop_can_dispatch_connections_while_one_handler_is_busy(self):
        first_entered = threading.Event()
        second_entered = threading.Event()
        release_first = threading.Event()
        workers = threading.BoundedSemaphore(2)
        first_server, first_client = socket.socketpair()
        second_server, second_client = socket.socketpair()

        def dispatch(connection, _read_only):
            if connection is first_server:
                first_entered.set()
                if not release_first.wait(1):
                    raise AssertionError("first connection was not released")
            else:
                second_entered.set()

        first_worker = None
        second_worker = None
        try:
            with mock.patch.object(server, "_serve_connection", side_effect=dispatch):
                first_worker = server._spawn_connection(first_server, False, workers)
                self.assertTrue(first_entered.wait(1))
                second_worker = server._spawn_connection(second_server, False, workers)
                self.assertTrue(second_entered.wait(1))
                release_first.set()
                first_worker.join(timeout=1)
                second_worker.join(timeout=1)
            self.assertFalse(first_worker.is_alive())
            self.assertFalse(second_worker.is_alive())
        finally:
            release_first.set()
            first_client.close()
            second_client.close()
            if first_worker and first_worker.is_alive():
                first_worker.join(timeout=1)
            if second_worker and second_worker.is_alive():
                second_worker.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
