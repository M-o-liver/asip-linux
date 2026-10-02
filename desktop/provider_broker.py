"""Credential broker and narrow Codex Responses-to-Gemini adapter."""

from __future__ import annotations

import argparse
import ctypes
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import threading
import time
import uuid
from urllib.parse import urlsplit

HOP_HEADERS = {"authorization", "connection", "keep-alive", "proxy-authenticate",
               "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host"}
MAX_REQUEST = 16 * 1024 * 1024


def _non_dumpable() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "could not protect provider broker memory")


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(item.get("text", "") for item in content
                   if isinstance(item, dict) and item.get("type") in {"input_text", "output_text", "text"})


def responses_to_chat(request: dict) -> dict:
    messages = []
    instructions = request.get("instructions")
    if isinstance(instructions, str) and instructions:
        messages.append({"role": "system", "content": instructions})
    inputs = request.get("input", [])
    if isinstance(inputs, str):
        inputs = [{"role": "user", "content": inputs}]
    for item in inputs if isinstance(inputs, list) else []:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "function_call":
            messages.append({"role": "assistant", "tool_calls": [{
                "id": item.get("call_id") or item.get("id") or uuid.uuid4().hex,
                "type": "function", "function": {"name": item.get("name", ""),
                "arguments": item.get("arguments", "{}")},
            }]})
        elif kind == "function_call_output":
            messages.append({"role": "tool", "tool_call_id": item.get("call_id", ""),
                             "content": _text(item.get("output", "")) or str(item.get("output", ""))})
        elif kind == 'reasoning':
            continue
        else:
            role = item.get("role", "user")
            if role == "developer":
                role = "system"
            messages.append({"role": role, "content": _text(item.get("content", ""))})
    chat = {"model": request.get("model"), "messages": messages,
            "stream": bool(request.get("stream", False))}
    if chat["stream"]:
        chat["stream_options"] = {"include_usage": True}
    tools = []
    for tool in request.get("tools") or []:
        if not isinstance(tool,dict) or tool.get('type') != 'function':
            raise ValueError('The Gemini adapter accepts function tools only')
        if isinstance(tool, dict) and tool.get("type") == "function":
            tools.append({"type": "function", "function": {
                "name": tool.get("name", ""), "description": tool.get("description", ""),
                "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
            }})
    if tools:
        chat["tools"] = tools
    choice = request.get("tool_choice")
    if isinstance(choice, dict) and choice.get("type") == "function":
        chat["tool_choice"] = {"type": "function", "function": {"name": choice.get("name", "")}}
    elif isinstance(choice,str) and choice in {"auto", "none", "required"}:
        chat["tool_choice"] = choice
    elif choice is not None:
        raise ValueError('Unsupported Gemini tool choice')
    reasoning = request.get("reasoning")
    if isinstance(reasoning, dict) and reasoning.get("effort") in {"low", "medium", "high"}:
        chat["reasoning_effort"] = reasoning["effort"]
    if isinstance(request.get("temperature"), (int, float)):
        chat["temperature"] = request["temperature"]
    return chat


def chat_to_response(value: dict, response_id: str | None = None) -> dict:
    if not isinstance(value,dict) or not value.get('choices') or value.get('error'):
        raise ValueError('Provider returned no completion')
    if value['choices'][0].get('finish_reason') not in ('stop','tool_calls'):
        raise ValueError('Provider response was incomplete')
    response_id = response_id or value.get("id") or "resp_" + uuid.uuid4().hex
    output = []
    message = ((value.get("choices") or [{}])[0].get("message") or {})
    if message.get("content"):
        output.append({"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant",
                       "status": "completed", "content": [{"type": "output_text", "text": message["content"], "annotations": []}]})
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        output.append({"id": "fc_" + uuid.uuid4().hex, "type": "function_call",
                       "call_id": call.get("id", ""), "name": function.get("name", ""),
                       "arguments": function.get("arguments", "{}"), "status": "completed"})
    usage = value.get("usage") or {}
    return {"id": response_id, "object": "response", "created_at": int(time.time()),
            "status": "completed", "model": value.get("model"), "output": output,
            "output_text": message.get("content") or "",
            "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                      "output_tokens": usage.get("completion_tokens", 0),
                      "total_tokens": usage.get("total_tokens", 0)}}


class ProviderBroker(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, upstream: str, token: str, adapter: str,
                 client_token: str):
        parsed = urlsplit(upstream)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("invalid upstream provider URL")
        if adapter not in {"passthrough", "gemini-chat-completions"}:
            raise ValueError("invalid provider adapter")
        self.upstream = parsed
        self.token = token
        self.client_token = client_token
        self.adapter = adapter
        self._active: dict[str, tuple[http.client.HTTPConnection, socket.socket | None]] = {}
        self._active_lock = threading.Lock()
        super().__init__(address, ProviderHandler)

    def register(self, response_id: str, connection: http.client.HTTPConnection) -> None:
        with self._active_lock:
            self._active[response_id] = (connection, connection.sock)

    def unregister(self, response_id: str) -> None:
        with self._active_lock:
            self._active.pop(response_id, None)

    def cancel(self, response_id: str) -> bool:
        with self._active_lock:
            active = self._active.get(response_id)
        if active is None:
            return False
        connection, transport = active
        if transport is not None:
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()
        return True


class ProviderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/_asip/health":
            self._json(200, {"ok": True, "upstream": self.server.upstream.geturl().rstrip("/"),
                             "adapter": self.server.adapter, "pid": os.getpid()})
        else:
            self._forward()

    def do_POST(self):
        if not self._authorized():
            return
        if self.server.adapter == "gemini-chat-completions" and urlsplit(self.path).path == "/responses":
            self._gemini_response()
        else:
            self._forward()

    def do_DELETE(self):
        if not self._authorized():
            return
        if self.server.adapter == "gemini-chat-completions" and self.path.startswith("/responses/"):
            response_id = self.path.rsplit("/", 1)[-1]
            cancelled = self.server.cancel(response_id)
            self._json(200 if cancelled else 404, {"id": response_id, "object": "response",
                                                     "status": "cancelled" if cancelled else "not_found"})
        else:
            self._forward()

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.client_token
        if hmac.compare_digest(supplied, expected):
            return True
        self._json(401, {"error": {"message": "ASIP provider capability is required",
                                    "type": "authentication_error"}})
        return False

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid content length") from exc
        if length < 0 or length > MAX_REQUEST:
            raise OverflowError
        return self.rfile.read(length) if length else b""

    def _connection(self):
        upstream = self.server.upstream
        cls = http.client.HTTPSConnection if upstream.scheme == "https" else http.client.HTTPConnection
        return cls(upstream.hostname, upstream.port, timeout=310)

    def _headers(self, body: bytes) -> dict[str, str]:
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in HOP_HEADERS and key.lower() not in ("content-length",'accept-encoding')}
        headers["Authorization"] = "Bearer " + self.server.token
        headers["Content-Length"] = str(len(body))
        headers["Content-Type"] = "application/json"
        headers['Accept-Encoding'] = 'identity'
        return headers

    def _path(self, suffix: str) -> str:
        return self.server.upstream.path.rstrip("/") + suffix

    def _gemini_response(self):
        try:
            incoming = json.loads(self._read_body() or b"{}")
            if not isinstance(incoming, dict):
                raise ValueError("request must be an object")
            chat = responses_to_chat(incoming)
        except OverflowError:
            self.send_error(413)
            return
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"error": {"message": str(exc), "type": "invalid_request_error"}})
            return
        body = json.dumps(chat, separators=(",", ":")).encode()
        connection = self._connection()
        response_id = "resp_" + uuid.uuid4().hex
        self.server.register(response_id, connection)
        streaming = False
        try:
            connection.request("POST", self._path("/chat/completions"), body=body, headers=self._headers(body))
            self.server.register(response_id, connection)
            response = connection.getresponse()
            if response.status >= 400:
                self._bytes(response.status, response.read(MAX_REQUEST), response.getheader("Content-Type") or "application/json")
            elif chat["stream"]:
                streaming = True
                self._stream_chat(response, response_id)
            else:
                self._json(response.status, chat_to_response(json.loads(response.read(MAX_REQUEST)), response_id))
        except (OSError, http.client.HTTPException, ValueError, OverflowError):
            if streaming:
                try:
                    self._event({'type':'response.failed','response':{'id':response_id,'object':'response','status':'failed',
                                'error':{'code':'server_error','message':'Provider stream did not complete successfully'},'output':[]}})
                except OSError:
                    pass
            else:
                self._json(502, {"error": {"message": "The configured provider could not complete the request", "type": "provider_error"}})
        finally:
            self.server.unregister(response_id)
            connection.close()
            self.close_connection = True

    def _stream_chat(self, response, response_id: str):
        message_id = "msg_" + uuid.uuid4().hex
        tool_calls: dict[int, dict] = {}
        text_parts = []
        usage = {}
        received = 0
        finish_reason = None
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self._event({"type": "response.created", "response": {"id": response_id, "object": "response", "status": "in_progress", "output": []}})
        self._event({"type": "response.output_item.added", "output_index": 0,
                     "item": {"id": message_id, "type": "message", "role": "assistant", "status": "in_progress", "content": []}})
        self._event({"type": "response.content_part.added", "item_id": message_id, "output_index": 0,
                     "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})
        while True:
            line = response.readline(MAX_REQUEST+1)
            if not line:
                break
            received += len(line)
            if received > MAX_REQUEST:
                raise OverflowError('Provider output exceeded the capture limit')
            line = line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError as exc:
                raise ValueError('Malformed provider stream') from exc
            if not isinstance(chunk,dict) or chunk.get('error'):
                raise ValueError('Provider stream failed')
            if chunk.get("usage"):
                usage = chunk["usage"]
            choice = (chunk.get("choices") or [{}])[0]
            finish_reason = choice.get('finish_reason') or finish_reason
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if isinstance(content, str) and content:
                text_parts.append(content)
                self._event({"type": "response.output_text.delta", "item_id": message_id,
                             "output_index": 0, "content_index": 0, "delta": content})
            for part in delta.get("tool_calls") or []:
                index = int(part.get("index", 0))
                current = tool_calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                current["id"] = part.get("id") or current["id"]
                function = part.get("function") or {}
                current["name"] = function.get("name") or current["name"]
                addition = function.get("arguments") or ""
                current["arguments"] += addition
                if not current.get("announced") and current["id"] and current["name"]:
                    current["announced"] = True
                    self._event({"type": "response.output_item.added", "output_index": index + 1,
                                 "item": {"id": "fc_" + current["id"], "type": "function_call",
                                          "status": "in_progress", "call_id": current["id"],
                                          "name": current["name"], "arguments": ""}})
                    addition = current["arguments"]
                if addition and current.get("announced"):
                    self._event({"type": "response.function_call_arguments.delta", "item_id": 'fc_'+current["id"],
                                 "output_index": index + 1, "delta": addition})
        if finish_reason not in ('stop','tool_calls') or any(not call.get('announced') for call in tool_calls.values()):
            raise ValueError('Provider stream ended before successful completion')
        text = "".join(text_parts)
        self._event({"type": "response.output_text.done", "item_id": message_id, "output_index": 0, "content_index": 0, "text": text})
        message = {"id": message_id, "type": "message", "role": "assistant", "status": "completed",
                   "content": [{"type": "output_text", "text": text, "annotations": []}]}
        self._event({"type": "response.output_item.done", "output_index": 0, "item": message})
        output = [message]
        for index, call in sorted(tool_calls.items()):
            item = {"id": "fc_" + call["id"], "type": "function_call", "status": "completed",
                    "call_id": call["id"], "name": call["name"], "arguments": call["arguments"]}
            output.append(item)
            self._event({"type": "response.function_call_arguments.done", "item_id": item["id"],
                         "output_index": index + 1, "arguments": call["arguments"]})
            self._event({"type": "response.output_item.done", "output_index": index + 1, "item": item})
        completed = {"id": response_id, "object": "response", "status": "completed", "output": output,
                     "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                               "output_tokens": usage.get("completion_tokens", 0),
                               "total_tokens": usage.get("total_tokens", 0)}}
        self._event({"type": "response.completed", "response": completed})

    def _event(self, value: dict) -> None:
        payload = json.dumps(value, separators=(",", ":"))
        if self.server.token:
            payload = payload.replace(json.dumps(self.server.token)[1:-1], '[REDACTED]')
        self.wfile.write(("data: " + payload + "\n\n").encode())
        self.wfile.flush()

    def _forward(self):
        try:
            body = self._read_body()
        except ValueError:
            self.send_error(400)
            return
        except OverflowError:
            self.send_error(413)
            return
        incoming = urlsplit(self.path)
        path = self._path(incoming.path if incoming.path.startswith("/") else "/" + incoming.path)
        if incoming.query:
            path += "?" + incoming.query
        connection = self._connection()
        streaming = False
        try:
            connection.request(self.command, path, body=body or None, headers=self._headers(body))
            response = connection.getresponse()
            content_type = response.getheader('Content-Type') or 'application/octet-stream'
            if response.status < 400 and content_type.startswith('text/event-stream'):
                streaming = True
                self.send_response(response.status)
                self.send_header('Content-Type',content_type)
                self.send_header('Connection','close')
                self.end_headers()
                received = 0
                pending = b''
                token = self.server.token.encode()
                while chunk := response.read1(65536):
                    received += len(chunk)
                    if received > MAX_REQUEST:
                        break
                    pending += chunk
                    safe = pending.replace(token,b'[REDACTED]')
                    # Retain only a possible split secret. Keeping an arbitrary
                    # tail also withholds SSE newlines until the next event.
                    keep = next((n for n in range(min(len(token)-1,len(safe)),0,-1)
                                 if safe.endswith(token[:n])),0)
                    if len(safe)>keep:
                        self.wfile.write(safe[:-keep] if keep else safe)
                        self.wfile.flush()
                        pending = safe[-keep:] if keep else b''
                if pending:
                    self.wfile.write(pending.replace(token,b'[REDACTED]'))
                    self.wfile.flush()
            else:
                self._bytes(response.status, response.read(MAX_REQUEST), content_type)
        except (OSError, http.client.HTTPException):
            if not streaming:
                self.send_error(502)
        finally:
            connection.close()
            self.close_connection = True

    def _json(self, status: int, value: dict) -> None:
        self._bytes(status, json.dumps(value, separators=(",", ":")).encode(), "application/json")

    def _bytes(self, status: int, body: bytes, content_type: str) -> None:
        token = self.server.token.encode("utf-8")
        if token:
            body = body.replace(token, b"[REDACTED]")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ASIP compatible-provider credential broker")
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--env-var", default="ASIP_PROVIDER_API_KEY")
    parser.add_argument("--adapter", choices=("passthrough", "gemini-chat-completions"), default="passthrough")
    parser.add_argument("--client-token-file", type=Path, required=True)
    args = parser.parse_args(argv)
    token = os.environ.pop(args.env_var, "")
    if not token:
        raise SystemExit("provider authority is unavailable")
    try:
        client_token = args.client_token_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise SystemExit("provider client capability is unavailable") from exc
    if not client_token:
        raise SystemExit("provider client capability is empty")
    _non_dumpable()
    server = ProviderBroker(("127.0.0.1", args.port), args.upstream, token, args.adapter, client_token)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
