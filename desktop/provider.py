"""ASIP-managed compatible-provider state and broker lifecycle helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import tempfile
from typing import Any
from urllib.parse import urlparse

from .state import state_directory, private_json

AUTHORITY_NAME = "ai.compatible_provider"
AUTHORITY_ENV = "ASIP_PROVIDER_API_KEY"
GOOGLE_AUTHORITY_NAME = "ai.google_gemini"
GOOGLE_AUTHORITY_ENV = "GEMINI_API_KEY"
GOOGLE_MODEL = "gemini-3.8-flash"
GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
BROKER_HOST = "127.0.0.1"
BROKER_PORT = 18765
BROKER_BASE_URL = f"http://{BROKER_HOST}:{BROKER_PORT}"


class ProviderState:
    def __init__(self, path: Path | None = None):
        self.path = path or state_directory() / "provider.json"

    def load_document(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"schema_version": 2, "active": "chatgpt", "chatgpt_connected": False, "connections": {}}
        if not isinstance(value, dict):
            return {"schema_version": 2, "active": "chatgpt", "chatgpt_connected": False, "connections": {}}
        if value.get("schema_version") == 1:
            legacy = self._validate_connection(value)
            if legacy:
                legacy["legacy_default_codex_home"] = True
            return {"schema_version": 2, "active": "compatible", "chatgpt_connected": True,
                    "connections": {"compatible": legacy} if legacy else {}}
        if value.get("schema_version") != 2:
            return {"schema_version": 2, "active": "chatgpt", "chatgpt_connected": False, "connections": {}}
        active = value.get("active") if isinstance(value.get("active"), str) else "chatgpt"
        connections = {}
        for key, item in (value.get("connections") if isinstance(value.get("connections"),dict) else {}).items():
            if key not in ('google','compatible'):
                continue
            clean = self._validate_connection(item, provider_id=key)
            if clean:
                connections[key] = clean
        if active != "chatgpt" and active not in connections:
            active = "chatgpt"
        return {"schema_version": 2, "active": active,
                "chatgpt_connected": bool(value.get("chatgpt_connected", False)),
                "connections": connections}

    def load(self) -> dict[str, Any] | None:
        document = self.load_document()
        active = document["active"]
        return None if active == "chatgpt" else document["connections"].get(active)

    @staticmethod
    def _validate_connection(value: Any, provider_id: str = "compatible") -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        required = ("name", "base_url", "model")
        if not all(isinstance(value.get(key), str) and value[key] for key in required):
            return None
        return {
            "id": provider_id,
            "kind": value.get("kind", "asip-managed-compatible-provider"),
            "name": value["name"], "base_url": value["base_url"], "model": value["model"],
            "authority": value.get("authority", AUTHORITY_NAME),
            "env_var": value.get("env_var", AUTHORITY_ENV),
            "broker_base_url": value.get("broker_base_url", BROKER_BASE_URL),
            "adapter": value.get("adapter", "passthrough"),
            "pid": value.get("pid") if isinstance(value.get("pid"), int) else None,
            "process_start": value.get("process_start") if isinstance(value.get("process_start"), str) else None,
            "verified": bool(value.get("verified", False)),
            "legacy_default_codex_home": bool(value.get("legacy_default_codex_home", False)),
        }

    @staticmethod
    def validated(*, name: str, base_url: str, model: str, pid: int | None = None, process_start: str | None = None,
                  provider_id: str = "compatible", authority: str = AUTHORITY_NAME,
                  env_var: str = AUTHORITY_ENV, adapter: str = "passthrough",
                  verified: bool = False, legacy_default_codex_home: bool = False,
                  broker_base_url: str = BROKER_BASE_URL) -> dict[str, Any]:
        parsed = urlparse(base_url)
        if (parsed.scheme not in ("http", "https") or not parsed.netloc
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("provider base URL must be an http(s) URL without credentials, query, or fragment")
        if parsed.scheme == 'http' and parsed.hostname not in ('localhost','127.0.0.1','::1'):
            raise ValueError('Use HTTPS for a remote provider; HTTP is allowed only on loopback')
        value = {
            "id": provider_id,
            "kind": "asip-managed-compatible-provider",
            "name": name.strip(),
            "base_url": base_url.rstrip("/"),
            "model": model.strip(),
            "authority": authority,
            "env_var": env_var,
            "broker_base_url": broker_base_url,
            "adapter": adapter,
            "pid": pid,
            "process_start": process_start,
            "verified": verified,
            "legacy_default_codex_home": legacy_default_codex_home,
        }
        if not value["name"] or not value["model"]:
            raise ValueError("provider name and model are required")
        return value

    def save(self, *, name: str, base_url: str, model: str, pid: int | None = None, process_start: str | None = None,
             provider_id: str = "compatible", authority: str = AUTHORITY_NAME,
             env_var: str = AUTHORITY_ENV, adapter: str = "passthrough",
             verified: bool = False, activate: bool = True,
             legacy_default_codex_home: bool = False,
             broker_base_url: str = BROKER_BASE_URL) -> dict[str, Any]:
        value = self.validated(name=name, base_url=base_url, model=model, pid=pid, process_start=process_start,
                               provider_id=provider_id, authority=authority,
                               env_var=env_var, adapter=adapter, verified=verified,
                               legacy_default_codex_home=legacy_default_codex_home,
                               broker_base_url=broker_base_url)
        document = self.load_document()
        document["connections"][provider_id] = value
        if activate:
            document["active"] = provider_id
        self._write(document)
        return value

    def select(self, provider_id: str) -> dict[str, Any]:
        document = self.load_document()
        if provider_id != "chatgpt" and provider_id not in document["connections"]:
            raise ValueError("provider is not connected")
        document["active"] = provider_id
        self._write(document)
        return document

    def mark_chatgpt_connected(self, connected: bool = True) -> None:
        document = self.load_document()
        document["chatgpt_connected"] = connected
        self._write(document)

    def remove(self, provider_id: str = "compatible") -> None:
        document = self.load_document()
        document["connections"].pop(provider_id, None)
        if document["active"] == provider_id:
            document["active"] = "chatgpt"
        if document["connections"] or document["active"] != "chatgpt" or document["chatgpt_connected"]:
            self._write(document)
        else:
            self.path.unlink(missing_ok=True)

    def _write(self, document: dict[str, Any]) -> None:
        private_json(self.path,document)

    def status(self) -> dict[str, Any]:
        document = self.load_document()
        return {"active": document["active"], "chatgpt_connected": document["chatgpt_connected"],
                "connections": document["connections"]}


def codex_provider_overrides(state: dict[str, Any] | None) -> tuple[str, ...]:
    if not state:
        return ()
    quote = json.dumps
    overrides = (
        'model_provider="asip-managed"',
        "model=%s" % quote(state["model"]),
        "model_providers.asip-managed.name=%s" % quote(state["name"]),
        "model_providers.asip-managed.base_url=%s" % quote(state["broker_base_url"]),
        'model_providers.asip-managed.wire_api="responses"',
        "model_providers.asip-managed.requires_openai_auth=false",
        "model_providers.asip-managed.supports_websockets=false",
        'model_providers.asip-managed.env_key="ASIP_BROKER_TOKEN"',
    )
    if state.get('adapter') == 'gemini-chat-completions':
        # Chat Completions has function calls but no Responses hosted/namespace tools.
        overrides += ('features.multi_agent=false', 'web_search="disabled"')
    return overrides


def codex_environment(state: dict[str, Any] | None, root: Path | None = None) -> dict[str, str]:
    """Keep API-provider Codex state separate without disturbing ChatGPT auth."""
    if state and state.get("legacy_default_codex_home"):
        return {}
    provider_id = state["id"] if state else "chatgpt"
    home = (root or state_directory()) / "codex" / provider_id
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment = {"CODEX_HOME": str(home)}
    if state:
        try:
            environment["ASIP_BROKER_TOKEN"] = broker_token_path(provider_id,root).read_text(encoding="utf-8").strip()
        except OSError:
            pass
    return environment


def broker_token_path(provider_id: str, root: Path | None = None) -> Path:
    return (root or state_directory()) / ("broker-%s.token" % provider_id)


def ensure_broker_token(provider_id: str, root: Path | None = None) -> Path:
    path = broker_token_path(provider_id, root)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_file():
        descriptor, temporary = tempfile.mkstemp(prefix='.broker-', dir=path.parent)
        try:
            with os.fdopen(descriptor,'w',encoding='utf-8') as handle:
                handle.write(secrets.token_urlsafe(32)+'\n')
                handle.flush(); os.fsync(handle.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temporary)
    if path.stat().st_mode & 0o077:
        os.chmod(path, 0o600)
    return path


def process_start(pid: int) -> str | None:
    try:
        return (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None
