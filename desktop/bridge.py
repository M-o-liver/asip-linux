"""Validation and envelopes for the WebKit JavaScript/native bridge."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable


class BridgeError(ValueError):
    pass


@dataclass(frozen=True)
class BridgeRequest:
    request_id: str
    method: str
    params: dict[str, Any]

    @classmethod
    def parse(cls, value: str | dict[str, Any]) -> "BridgeRequest":
        try:
            raw = json.loads(value) if isinstance(value, str) else value
        except json.JSONDecodeError as exc:
            raise BridgeError("message is not valid JSON") from exc
        if not isinstance(raw, dict):
            raise BridgeError("message must be an object")
        request_id = raw.get("id")
        method = raw.get("method")
        params = raw.get("params", {})
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            raise BridgeError("message id must be a non-empty string")
        if not isinstance(method, str) or not method or len(method) > 128:
            raise BridgeError("message method must be a non-empty string")
        if not isinstance(params, dict):
            raise BridgeError("message params must be an object")
        return cls(request_id=request_id, method=method, params=params)


def success(request_id: str, result: Any) -> dict[str, Any]:
    return {"id": request_id, "ok": True, "result": result}


def failure(request_id: str, code: str, message: str) -> dict[str, Any]:
    return {
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": message},
    }


class MessageRouter:
    def __init__(self):
        self._handlers: dict[str, Callable[[dict[str, Any]], Any]] = {}

    def register(self, method: str, handler: Callable[[dict[str, Any]], Any]) -> None:
        self._handlers[method] = handler

    def handle(self, value: str | dict[str, Any]) -> dict[str, Any]:
        try:
            request = BridgeRequest.parse(value)
        except BridgeError as exc:
            return failure("", "invalid_message", str(exc))
        handler = self._handlers.get(request.method)
        if handler is None:
            return failure(request.request_id, "unknown_method", "Unknown Desktop method")
        try:
            return success(request.request_id, handler(request.params))
        except Exception as exc:  # The native boundary must always answer WebKit.
            return failure(request.request_id, "backend_unavailable", str(exc))
