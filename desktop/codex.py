"""ASIP-owned boundary around the pinned OpenAI Codex Python SDK."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import threading
from typing import Any

from .state import state_directory
from .provider import ProviderState, codex_environment, codex_provider_overrides


POLICY_OVERRIDES = (
    'approval_policy="never"',
    'sandbox_mode="danger-full-access"',
    'mcp_servers.asip-admin.command=%s' % json.dumps(str(Path.home() / ".local/bin/asip-mcp-admin")),
    "mcp_servers.asip-admin.required=true",
    'mcp_servers.asip-inspect.command=%s' % json.dumps(str(Path.home() / ".local/bin/asip-mcp-inspect")),
    "mcp_servers.asip-inspect.required=true",
)


class CodexUnavailable(RuntimeError):
    """The Desktop runtime cannot be loaded or initialized."""


@dataclass(frozen=True, slots=True)
class SDKTypes:
    AsyncCodex: type
    CodexConfig: type
    ApprovalMode: type
    Sandbox: type
    version: str


def load_sdk() -> SDKTypes:
    """Load the pinned optional Desktop dependency without burdening Core."""
    try:
        from openai_codex import (  # type: ignore[import-not-found]
            ApprovalMode,
            AsyncCodex,
            CodexConfig,
            Sandbox,
            __version__,
        )
    except ImportError as exc:
        raise CodexUnavailable(
            "The ASIP Codex runtime is not installed"
        ) from exc
    return SDKTypes(AsyncCodex, CodexConfig, ApprovalMode, Sandbox, __version__)


class ApprovalDiagnostics:
    """Bounded, private diagnostics for approval prompts that should not occur."""

    def __init__(self, path: Path | None = None, limit: int = 128 * 1024):
        self.path = path or state_directory() / "codex-approval-diagnostics.jsonl"
        self.limit = limit

    def record(self, method: str, params: dict[str, Any] | None) -> None:
        params = params or {}
        event = {
            "timestamp": datetime.now(UTC).isoformat(),
            "method": method,
            "thread_id": params.get("threadId"),
            "turn_id": params.get("turnId"),
            "item_id": params.get("itemId"),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists() and self.path.stat().st_size > self.limit:
            tail = self.path.read_bytes()[-self.limit // 2 :]
            self.path.write_bytes(tail[tail.find(b"\n") + 1 :])
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, (json.dumps(event, sort_keys=True) + "\n").encode())
        finally:
            os.close(descriptor)


class CodexManager:
    """Own one Codex runtime and ASIP's conversation policy."""

    def __init__(
        self,
        cwd: str | Path,
        *,
        sdk_loader: Callable[[], SDKTypes] = load_sdk,
        diagnostics: ApprovalDiagnostics | None = None,
        provider_state: ProviderState | None = None,
    ):
        self.cwd = str(Path(cwd).resolve())
        self._sdk_loader = sdk_loader
        self._diagnostics = diagnostics or ApprovalDiagnostics()
        self._sdk: SDKTypes | None = None
        self._codex: Any = None
        self._thread: Any = None
        self._turn: Any = None
        self._login: Any = None
        self.provider_state = provider_state or ProviderState()
        self._start_lock = asyncio.Lock()
        self._interrupt_requested = False

    async def start(self) -> None:
        async with self._start_lock:
            await self._start()

    async def _start(self) -> None:
        if self._codex is not None:
            return
        sdk = self._sdk_loader()
        provider = self.provider_state.load()
        config = sdk.CodexConfig(
            cwd=self.cwd,
            client_name="asip_desktop",
            client_title="ASIP",
            config_overrides=POLICY_OVERRIDES + codex_provider_overrides(provider),
            env=codex_environment(provider, self.provider_state.path.parent),
        )
        codex = sdk.AsyncCodex(config)
        self._install_approval_handler(codex)
        try:
            await codex.__aenter__()
        except BaseException as exc:
            await codex.close()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise CodexUnavailable(f"Codex failed to initialize: {exc}") from exc
        self._sdk = sdk
        self._codex = codex

    async def stop(self) -> None:
        codex, self._codex = self._codex, None
        self._thread = None
        self._turn = None
        self._login = None
        if codex is not None:
            await codex.close()

    async def restart(self) -> None:
        await self.stop()
        await self.start()

    def _install_approval_handler(self, codex: Any) -> None:
        """Pin the SDK's narrow internal hook until it becomes public API."""
        try:
            codex._client._sync._approval_handler = self._handle_approval
        except AttributeError as exc:
            raise CodexUnavailable(
                "The Codex SDK no longer exposes its approval handler"
            ) from exc

    def _handle_approval(
        self, method: str, params: dict[str, Any] | None
    ) -> dict[str, Any]:
        self._diagnostics.record(method, params)
        if method in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }:
            return {"decision": "accept"}
        if method == "item/permissions/requestApproval":
            requested = (params or {}).get("permissions")
            return {
                "permissions": requested if isinstance(requested, dict) else {},
                "scope": "session",
            }
        return {}

    async def account_status(self) -> dict[str, Any]:
        await self.start()
        response = await self._codex.account()
        account = response.account.root if response.account is not None else None
        return {
            "connected": account is not None,
            "provider": getattr(account, "type", None),
            "plan": getattr(account, "plan_type", None),
            "requires_openai_auth": response.requires_openai_auth,
        }

    async def models(self) -> list[dict[str, Any]]:
        await self.start()
        response = await self._codex.models()
        return [
            {
                "id": model.id,
                "model": model.model,
                "name": model.display_name,
                "default": model.is_default,
            }
            for model in response.data
            if not model.hidden
        ]

    async def status(self) -> dict[str, Any]:
        await self.start()
        provider_state = self.provider_state
        provider = provider_state.load()
        return {
            "available": True,
            "sdk_version": self._sdk.version,
            "account": await self.account_status(),
            "models": await self.models(),
            "thread_id": getattr(self._thread, "id", None),
            "policy": {"approval": "never", "sandbox": "danger-full-access"},
            "required_mcp": ["asip-admin", "asip-inspect"],
            "managed_provider": provider,
            "providers": provider_state.status(),
        }

    async def login_openai(self) -> dict[str, str]:
        await self.start()
        self._login = await self._codex.login_chatgpt()
        return {"login_id": self._login.login_id, "auth_url": self._login.auth_url}

    async def wait_login(self) -> dict[str, Any]:
        if self._login is None:
            raise ValueError("no OpenAI login is active")
        try:
            result = await self._login.wait()
            return {"success": result.success, "error": result.error}
        finally:
            self._login = None

    async def cancel_login(self) -> bool:
        if self._login is None:
            return False
        try:
            await self._login.cancel()
            return True
        finally:
            self._login = None

    async def create_thread(self) -> str:
        await self.start()
        self._thread = await self._codex.thread_start(
            approval_mode=self._sdk.ApprovalMode.deny_all,
            sandbox=self._sdk.Sandbox.full_access,
            cwd=self.cwd,
        )
        return self._thread.id

    async def resume_thread(self, thread_id: str) -> str:
        await self.start()
        self._thread = await self._codex.thread_resume(
            thread_id,
            approval_mode=self._sdk.ApprovalMode.deny_all,
            sandbox=self._sdk.Sandbox.full_access,
            cwd=self.cwd,
        )
        return self._thread.id

    async def stream_events(self, prompt: str) -> AsyncIterator[dict[str, Any]]:
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        if self._thread is None:
            await self.create_thread()
        if self._interrupt_requested:
            yield {"method": "turn/completed", "payload": {"turn": {"status": "interrupted"}}}
            return
        self._turn = await self._thread.turn(
            prompt,
            approval_mode=self._sdk.ApprovalMode.deny_all,
            sandbox=self._sdk.Sandbox.full_access,
            cwd=self.cwd,
        )
        if self._interrupt_requested:
            await self._turn.interrupt()
        try:
            async for event in self._turn.stream():
                payload = event.payload
                yield {
                    "method": event.method,
                    "payload": payload.model_dump(mode="json", by_alias=True),
                }
        finally:
            self._turn = None

    async def send(self, prompt: str) -> list[dict[str, Any]]:
        return [event async for event in self.stream_events(prompt)]

    async def interrupt(self) -> bool:
        self._interrupt_requested = True
        if self._turn is None:
            return True
        await self._turn.interrupt()
        return True

    async def history(self, thread_id: str) -> dict[str, Any]:
        if getattr(self._thread, 'id', None) != thread_id:
            await self.resume_thread(thread_id)
        response = await self._thread.read(include_turns=True)
        thread = response.thread.model_dump(mode='json', by_alias=True)
        messages = []
        for turn in thread.get('turns', []):
            for item in turn.get('items', []):
                if item.get('type') == 'userMessage':
                    value = '\n'.join(c.get('text','') for c in item.get('content',[]) if c.get('type') == 'text')
                    messages.append({'role': 'user', 'text': value})
                elif item.get('type') == 'agentMessage':
                    messages.append({'role': 'assistant', 'text': item.get('text',''), 'state': turn.get('status','')})
        return {'messages': messages[-100:], 'truncated': len(messages) > 100}


class CodexRuntime:
    """Keep Codex and asyncio in one worker thread outside GTK's main loop."""

    def __init__(self, cwd: str | Path, **manager_options: Any):
        self.loop = asyncio.new_event_loop()
        self.manager = CodexManager(cwd, **manager_options)
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._run_loop, name="asip-codex", daemon=True
        )
        self._thread.start()
        self._ready.wait(timeout=5)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self._ready.set()
        self.loop.run_forever()

    def submit(self, coroutine: Any) -> Future:
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop)

    def _wait(self, coroutine: Any, timeout: float | None):
        future = self.submit(coroutine)
        try:
            return future.result(timeout)
        except TimeoutError:
            future.cancel()
            raise TimeoutError('Codex request timed out; retry after checking runtime state') from None

    def status(self, timeout: float = 30) -> dict[str, Any]:
        return self._wait(self.manager.status(),timeout)

    def restart(self, timeout: float = 30) -> None:
        self._wait(self.manager.restart(),timeout)

    def resume_thread(self, thread_id: str, timeout: float = 30) -> str:
        return self._wait(self.manager.resume_thread(thread_id),timeout)

    def history(self, thread_id: str, timeout: float = 30):
        return self._wait(self.manager.history(thread_id),timeout)

    def login_openai(self, timeout: float = 30) -> dict[str, str]:
        return self._wait(self.manager.login_openai(),timeout)

    def wait_login(self, timeout: float | None = None) -> dict[str, Any]:
        return self._wait(self.manager.wait_login(),timeout)

    def cancel_login(self, timeout: float = 10) -> bool:
        return self._wait(self.manager.cancel_login(),timeout)

    def send(
        self,
        prompt: str,
        *,
        thread_id: str | None = None,
        event_sink: Callable[[dict[str, Any]], None] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        async def run() -> dict[str, Any]:
            self.manager._interrupt_requested = False
            current = getattr(self.manager._thread, "id", None)
            if thread_id and current != thread_id:
                await self.manager.resume_thread(thread_id)
            elif not thread_id and current is not None:
                await self.manager.create_thread()
            elif current is None:
                await self.manager.create_thread()
            count = 0
            if event_sink:
                event_sink({'method': 'desktop/threadStarted', 'payload': {'thread_id': self.manager._thread.id}})
            terminal = None
            async for event in self.manager.stream_events(prompt):
                count += 1
                if event['method'] == 'turn/completed':
                    terminal = event['payload'].get('turn') or {}
                if event_sink is not None:
                    event_sink(event)
            return {"thread_id": self.manager._thread.id, "event_count": count,
                    'state': (terminal or {}).get('status','failed'),
                    'error': (terminal or {}).get('error') or (None if terminal else {'message': 'Codex disconnected before the turn completed; inspect this conversation before retrying'})}

        try:
            return self._wait(run(),timeout)
        except TimeoutError:
            self._wait(self.manager.stop(),5)
            raise

    def interrupt(self, timeout: float = 10) -> bool:
        return self.submit(self.manager.interrupt()).result(timeout)

    def close(self) -> None:
        if not self._thread.is_alive():
            return
        try:
            self.submit(self.manager.stop()).result(5)
        except Exception:
            pass  # Closing the window still has to release waiting workers.
        finally:
            async def cancel_pending():
                tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
            try:
                self.submit(cancel_pending()).result(2)
            except Exception:
                pass
            finally:
                self.loop.call_soon_threadsafe(self.loop.stop)
                self._thread.join(timeout=2)
