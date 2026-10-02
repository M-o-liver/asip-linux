"""User-level Desktop backend and read-only Core view models."""

from __future__ import annotations

import platform
import json
import os
import signal
import socket
import threading
import time
import uuid
from datetime import UTC, datetime
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Any

from core.protocol import PRIVILEGED_SOCKET, READ_ONLY_SOCKET, SCHEMA_VERSION, UnixClient

from . import product_version
from .bridge import MessageRouter
from .codex import CodexRuntime
from .state import DesktopState
from .provider import (
    GOOGLE_AUTHORITY_ENV, GOOGLE_AUTHORITY_NAME, GOOGLE_BASE_URL, GOOGLE_MODEL,
    ProviderState, broker_token_path, ensure_broker_token, process_start,
)


class DesktopBackend:
    def __init__(
        self,
        state: DesktopState | None = None,
        socket_path: str = READ_ONLY_SOCKET,
        privileged_socket_path: str = PRIVILEGED_SOCKET,
        codex: CodexRuntime | None = None,
        provider_state: ProviderState | None = None,
    ):
        state_supplied = state is not None
        self.state = state or DesktopState()
        self.client = UnixClient(socket_path)
        self.admin_client = UnixClient(privileged_socket_path)
        self.codex = codex
        self.codex_lock = threading.RLock()
        self.work_lock = threading.RLock()
        self.turn_active = threading.Event()
        self.provider_state = provider_state or ProviderState(
            self.state.path.parent / "provider.json" if state_supplied else None
        )
        self.event_sink = lambda _message: None
        self.router = MessageRouter()
        self.router.register("application.initialize", self.initialize)
        self.router.register("navigation.select", self.select_tab)
        self.router.register("appearance.theme", self.select_theme)
        self.router.register("conversation.list", self.conversation_list)
        self.router.register("conversation.new", self.conversation_new)
        self.router.register("conversation.select", self.conversation_select)
        self.router.register("conversation.rename", self.conversation_rename)
        self.router.register("conversation.keep", self.conversation_keep)
        self.router.register("conversation.forget", self.conversation_forget)
        self.router.register("core.refresh", self.core_snapshot)
        self.router.register("change.list", self.change_list)
        self.router.register("operation.detail", self.operation_detail)
        self.router.register("operation.output", self.operation_output)
        self.router.register("change.detail", self.change_detail)
        self.router.register("verification.list", self.verification_list)
        self.router.register("maintenance.detail", self.maintenance_detail)
        self.router.register("recovery.detail", self.recovery_detail)
        self.router.register("health.detail", self.health_detail)
        self.router.register("question.answer", self.question_answer)
        self.router.register("access.provision", self.access_provision)
        self.router.register("access.dismiss", self.access_dismiss)
        self.router.register("access.remove", self.access_remove)
        self.router.register("codex.status", self.codex_status)
        self.router.register("codex.restart", self.codex_restart)
        self.router.register("codex.login.openai", self.codex_login_openai)
        self.router.register("codex.login.wait", self.codex_login_wait)
        self.router.register("codex.login.cancel", self.codex_login_cancel)
        self.router.register("ask.send", self.ask_send)
        self.router.register("ask.interrupt", self.ask_interrupt)
        self.router.register("provider.configure", self.provider_configure)
        self.router.register("provider.google.configure", self.provider_google_configure)
        self.router.register("provider.select", self.provider_select)
        self.router.register("provider.remove", self.provider_remove)

    def _migrate_conversation_owners(self) -> None:
        state = self.state.load()
        conversations = state.get("conversations", [])
        if not any(item.get("provider") == "legacy" for item in conversations):
            return
        owner = self.provider_state.load_document()["active"]
        for item in conversations:
            if item.get("provider") == "legacy":
                item["provider"] = owner
        self.state.update(conversations=conversations)

    def handle(self, message):
        try: parsed=json.loads(message) if isinstance(message,str) else message
        except (ValueError,TypeError): return self.router.handle(message)
        method=parsed.get('method','') if isinstance(parsed,dict) else ''
        protected=method.startswith(('conversation.','provider.')) or method in ('codex.restart','codex.login.openai')
        if not protected: return self.router.handle(message)
        if not self.work_lock.acquire(blocking=False):
            return {'id':parsed.get('id',''),'ok':False,'error':{'code':'turn_active','message':'Finish or stop the active turn first'}}
        try: return self.router.handle(message)
        finally: self.work_lock.release()

    def _call(self, client: UnixClient, op: str, **fields: Any) -> dict[str, Any]:
        request = {
            "schema_version": SCHEMA_VERSION,
            "client": {"name": "asip-desktop", "version": product_version()},
            "transport": "desktop",
            "op": op,
            "argv": [],
            "cwd": "/",
            "reason": "",
            **fields,
        }
        try:
            response = client.call(request).response
        except PermissionError as exc:
            raise ConnectionError(
                "ASIP is installed, but this login session does not have ASIP access yet. "
                "Start a fresh login session, then reopen ASIP."
            ) from exc
        except FileNotFoundError as exc:
            raise ConnectionError(
                "ASIP could not reach its local service. The service is not installed "
                "or its socket is unavailable. Check the local services."
            ) from exc
        except ConnectionRefusedError as exc:
            raise ConnectionError(
                "ASIP could not reach its local service. The service is installed but "
                "not running. Retry or inspect the local services."
            ) from exc
        if not response.get("ok"):
            error = response.get("error", {}).get("message") or response.get("stderr")
            raise ConnectionError(str(error or "ASIP Core request failed"))
        return response.get("data", {})

    def _read(self, op: str, **fields: Any) -> dict[str, Any]:
        return self._call(self.client, op, **fields)

    def _mutate(self, op: str, **fields: Any) -> dict[str, Any]:
        return self._call(self.admin_client, op, **fields)

    def set_event_sink(self, sink) -> None:
        self.event_sink = sink

    def _codex(self) -> CodexRuntime:
        with self.codex_lock:
            if self.codex is None:
                self.codex = CodexRuntime(Path.home(), provider_state=self.provider_state)
            return self.codex

    def _reset_codex(self) -> None:
        with self.codex_lock:
            if self.codex is not None:
                runtime, self.codex = self.codex, None
                runtime.close()

    def _broker_healthy(self, state=None):
        if not state or not state.get('pid'):
            return False
        if state.get('process_start') and process_start(state['pid']) != state['process_start']:
            return False
        try:
            token = broker_token_path(state['id'], self.provider_state.path.parent).read_text().strip()
            req = Request(state['broker_base_url']+'/_asip/health', headers={'Authorization':'Bearer '+token})
            with urlopen(req,timeout=1) as response:
                payload=json.loads(response.read(4096))
            return payload.get('ok') is True and payload.get('upstream')==state['base_url'] and payload.get('pid')==state['pid']
        except (OSError,ValueError):
            return False

    def _stop_provider_broker(self, state: dict[str, Any] | None) -> None:
        pid = (state or {}).get("pid")
        if not isinstance(pid, int) or pid <= 1:
            return
        if state.get('process_start'):
            if process_start(pid) != state['process_start']:
                return
        elif not self._broker_healthy(state):
            return
        try:
            command = Path("/proc") / str(pid) / "cmdline"
            if b"desktop.provider_broker" not in command.read_bytes():
                return
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
        except (OSError, PermissionError):
            return

    def _start_provider_broker(self, state, *, change_id=None):
        client_token=ensure_broker_token(state['id'],self.provider_state.path.parent)
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1',0))
            port=reserve.getsockname()[1]
        result=self._mutate('access',action='start',name=state['authority'],
            argv=['/usr/bin/python3','-m','desktop.provider_broker','--upstream',state['base_url'],
                '--port',str(port),'--env-var',state['env_var'],'--adapter',state.get('adapter','passthrough'),
                '--client-token-file',str(client_token)],cwd='/',change_id=change_id,
            env={'PYTHONPATH':str(Path(__file__).resolve().parents[1])},
            standalone_reason=None if change_id else 'Start the saved ASIP provider broker')
        running=dict(state,pid=result.get('pid'),process_start=result.get('process_start') or process_start(result.get('pid')),
                     broker_base_url=f'http://127.0.0.1:{port}')
        for _ in range(30):
            if self._broker_healthy(running):
                return running
            time.sleep(.1)
        self._stop_provider_broker(running)
        raise ConnectionError('Provider broker failed to start; previous connection retained')

    def provider_configure(self, params: dict[str, Any]) -> dict[str, Any]:
        name, base_url, model, api_key = (
            params.get("name"), params.get("base_url"), params.get("model"), params.get("api_key")
        )
        if not all(isinstance(value, str) and value.strip() for value in (name, base_url, model, api_key)):
            raise ValueError("provider name, base URL, model, and API key are required")
        candidate = ProviderState.validated(name=name, base_url=base_url, model=model)
        return self._configure_provider(candidate, api_key, "Configure an advanced compatible AI provider")

    def provider_google_configure(self, params: dict[str, Any]) -> dict[str, Any]:
        api_key = params.get("api_key")
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("Google API key is required")
        candidate = ProviderState.validated(
            name="Google Gemini", base_url=GOOGLE_BASE_URL, model=params.get('model') or GOOGLE_MODEL,
            provider_id="google", authority=GOOGLE_AUTHORITY_NAME,
            env_var=GOOGLE_AUTHORITY_ENV, adapter="gemini-chat-completions",
        )
        return self._configure_provider(candidate, api_key, "Connect Google Gemini to ASIP", validate=True)

    def _configure_provider(self, candidate, api_key, intent, validate=False):
        if not self.work_lock.acquire(blocking=False):
            raise ValueError('Finish or stop the active turn before changing providers')
        previous_doc=self.provider_state.load_document()
        previous=self.provider_state.load()
        old=previous_doc['connections'].get(candidate['id'])
        candidate=dict(candidate, authority='desktop.'+candidate['id']+'.'+uuid.uuid4().hex[:12])
        change_id=None
        running=None
        provisioned=False
        committed=False
        try:
            change_id=self._start_change(intent)
            self._mutate('access',action='provision',name=candidate['authority'],
                label=candidate['name']+' API key',env_var=candidate['env_var'],value=api_key,change_id=change_id)
            provisioned=True
            running=self._start_provider_broker(candidate,change_id=change_id)
            if validate:
                self._validate_provider(running)
                running['verified']=True
            self._reset_codex()
            self.provider_state.save(**self._provider_fields(running))
            self.state.update(thread_id=None,active_conversation_id=None)
            committed=True
            self._stop_provider_broker(previous)
            if old and old.get('pid')!=(previous or {}).get('pid'):
                self._stop_provider_broker(old)
            warnings=[]
            if old and old['authority'].startswith('desktop.'):
                try: self._mutate('access',action='remove',name=old['authority'],change_id=change_id)
                except Exception: warnings.append('The old provider authority remains in Connected services; remove it there when convenient.')
            try:
                self._mutate('change',action='finish',argv=[change_id,'Configured '+candidate['name']+'; model availability is confirmed by the first successful turn'])
            except Exception:
                warnings.append('Provider is active, but its change could not be closed. Inspect change '+change_id+'.')
            return {'change_id':change_id,'provider':running,'warning':' '.join(warnings)}
        except Exception:
            if committed:
                raise
            self._stop_provider_broker(running)
            self.provider_state._write(previous_doc)
            if provisioned:
                try: self._mutate('access',action='remove',name=candidate['authority'],change_id=change_id)
                except Exception: pass
            if change_id:
                try: self._mutate('change',action='fail',argv=[change_id,'Provider setup failed; previous connection retained'])
                except Exception: pass
            raise
        finally:
            self.work_lock.release()

    def _validate_provider(self, state):
        token=broker_token_path(state['id'],self.provider_state.path.parent).read_text().strip()
        req=Request(state['broker_base_url']+'/models',headers={'Authorization':'Bearer '+token})
        try:
            with urlopen(req,timeout=15) as response:
                response.read(65536)
        except Exception:
            raise ConnectionError('Provider authentication failed; previous connection retained') from None

    @staticmethod
    def _provider_fields(state):
        return {('provider_id' if k=='id' else k):state[k] for k in
            ('id','name','base_url','model','pid','process_start','authority','env_var','adapter','verified','legacy_default_codex_home','broker_base_url') if k in state}

    def provider_select(self, params):
        if not self.work_lock.acquire(blocking=False):
            raise ValueError('Finish or stop the active turn before switching providers')
        previous_doc=self.provider_state.load_document()
        previous=self.provider_state.load()
        running=None
        try:
            provider_id=params.get('provider')
            if provider_id!='chatgpt' and provider_id not in previous_doc['connections']:
                raise ValueError('Provider is not configured')
            active=previous_doc['connections'].get(provider_id)
            if active:
                running=active if self._broker_healthy(active) else self._start_provider_broker(active)
            switching = provider_id != previous_doc['active']
            if switching or (running and running.get('pid') != (previous or {}).get('pid')):
                self._reset_codex()
            if running: self.provider_state.save(**self._provider_fields(running))
            else: self.provider_state.select('chatgpt')
            if switching:
                self.state.update(thread_id=None,active_conversation_id=None)
            if previous and previous.get('pid') != (running or {}).get('pid'):
                self._stop_provider_broker(previous)
            return {'providers':self.provider_state.status()}
        except Exception:
            if running and running.get('pid')!=(previous or {}).get('pid'): self._stop_provider_broker(running)
            self.provider_state._write(previous_doc)
            raise
        finally: self.work_lock.release()

    def provider_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        provider_id = params.get("provider", "compatible")
        provider_state = self.provider_state
        document = provider_state.load_document()
        state = document["connections"].get(provider_id)
        if state is None:
            return {"removed": False}
        change_id = self._start_change("Remove the compatible AI provider from ASIP")
        try:
            provider_state.remove(provider_id)
            if document['active'] == provider_id:
                self._reset_codex()
                self.state.update(thread_id=None, active_conversation_id=None)
        except Exception:
            provider_state._write(document)
            try:
                self._mutate('change', action='fail', argv=[change_id, 'Provider removal failed; connection retained'])
            except Exception:
                pass
            raise
        self._stop_provider_broker(state)
        warnings = []
        try:
            broker_token_path(provider_id, provider_state.path.parent).unlink(missing_ok=True)
            # Older installations share this authority with other agents.
            if state["authority"].startswith("desktop."):
                self._mutate("access", action="remove", name=state["authority"], change_id=change_id)
        except Exception:
            warnings.append('Provider disconnected; its old authority may remain in Connected services.')
        try:
            self._mutate(
                "change", action="finish",
                        argv=[change_id, "Disconnected the ASIP provider"],
            )
        except Exception:
            warnings.append('The change could not be closed; inspect change '+change_id+'.')
        return {"change_id": change_id, "removed": True, 'warning': ' '.join(warnings)}

    def codex_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        return self._codex().status()

    def codex_restart(self, _params):
        self._codex().restart()
        return self._codex().status()

    def codex_login_openai(self, _params):
        self.provider_select({'provider':'chatgpt'})
        result=self._codex().login_openai()
        self.event_sink({'method':'desktop/openExternal','payload':{'url':result['auth_url']}})
        return {'login_id':result['login_id']}

    def codex_login_wait(self, _params: dict[str, Any]) -> dict[str, Any]:
        with self.work_lock:
            runtime = self._codex()
            result = runtime.wait_login()
            if result.get("success"):
                self.provider_state.mark_chatgpt_connected()
            return {"login": result, "status": runtime.status()}

    def codex_login_cancel(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"cancelled": self._codex().cancel_login()}

    def ask_send(self, params):
        if not self.work_lock.acquire(blocking=False):
            raise ValueError('A turn is already active; stop it before starting another')
        selected=None
        response_text=[]
        self.turn_active.set()
        try:
            self._migrate_conversation_owners()
            prompt=params.get('prompt')
            if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>100000:
                raise ValueError('Prompt must contain 1–100000 characters')
            state=self.state.load()
            conversations=list(state['conversations'])
            active=state.get('active_conversation_id')
            selected=next((i for i in conversations if i['id']==active),None)
            provider=self.provider_state.status()['active']
            if selected and selected['provider']!=provider:
                raise ValueError('Switch to '+selected['provider']+' or start a new conversation')
            now=datetime.now(UTC).isoformat()
            if not selected:
                selected={'id':uuid.uuid4().hex,'thread_id':None,'title':self._conversation_title(prompt),
                    'kept':False,'created_at':now,'updated_at':now,'turns':0,'harness':'codex','provider':provider,'messages':[]}
                conversations.insert(0,selected)
            selected.setdefault('messages',[]).append({'role':'user','text':prompt.strip()})
            self.state.update(active_conversation_id=selected['id'],conversations=conversations)
            def event(message):
                if message.get('method')=='desktop/threadStarted':
                    selected['thread_id']=message['payload']['thread_id']
                    self.state.update(thread_id=selected['thread_id'],conversations=conversations)
                if message.get('method')=='item/agentMessage/delta':
                    response_text.append(message.get('payload',{}).get('delta',''))
                self.event_sink(message)
            result=self._codex().send(prompt.strip(),thread_id=selected['thread_id'],event_sink=event)
            selected['thread_id']=result['thread_id']
            selected['turns']+=1
            selected['updated_at']=datetime.now(UTC).isoformat()
            answer=''.join(response_text)
            error=(result.get('error') or {}).get('message')
            if error and error not in answer:
                answer+='\n'+error
            selected['messages'].append({'role':'assistant','text':answer, 'state':result.get('state','failed')})
            self.state.update(thread_id=selected['thread_id'],active_conversation_id=selected['id'],conversations=conversations)
            result['conversation_id']=selected['id']
            result['answer']=answer
            return result
        except Exception as exc:
            if selected:
                selected['messages'].append({'role':'assistant','text':''.join(response_text) or str(exc), 'state':'failed'})
                self.state.update(conversations=conversations)
            raise
        finally:
            self.turn_active.clear()
            self.work_lock.release()
            self.event_sink({'method':'desktop/turnFinished','payload':{}})

    @staticmethod
    def _conversation_title(prompt: str) -> str:
        title = " ".join(prompt.split())
        return title[:60] + ("…" if len(title) > 60 else "")

    def _conversations(self) -> tuple[list[dict[str, Any]], str | None]:
        self._migrate_conversation_owners()
        state = self.state.load()
        items = list(state.get("conversations", []))
        active = state.get("active_conversation_id")
        legacy_thread = state.get("thread_id")
        if not items and isinstance(legacy_thread, str) and legacy_thread:
            now = datetime.now(UTC).isoformat()
            active = uuid.uuid4().hex
            items = [{"id": active, "thread_id": legacy_thread, "title": "Previous conversation", "kept": False, "created_at": now, "updated_at": now, "turns": 0, "harness": "codex", "provider": "chatgpt"}]
            self.state.update(active_conversation_id=active, conversations=items)
        return items, active if any(item["id"] == active for item in items) else None

    def conversation_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        items, active = self._conversations()
        return {"active_id": active, "conversations": items}

    def conversation_new(self, _params: dict[str, Any]) -> dict[str, Any]:
        self.state.update(active_conversation_id=None, thread_id=None)
        return {"active_id": None, "conversations": self.state.load().get("conversations", [])}

    def conversation_select(self, params):
        conversation_id=params.get('conversation_id')
        items,_=self._conversations()
        selected=next((i for i in items if i['id']==conversation_id),None)
        if selected is None: raise ValueError('Conversation is unknown')
        self.state.update(active_conversation_id=conversation_id,thread_id=selected['thread_id'])
        result={'active_id':conversation_id,'conversation':selected,'messages':selected.get('messages',[])}
        if selected.get('thread_id') and selected.get('provider')==self.provider_state.status()['active']:
            try: result.update(self._codex().history(selected['thread_id']))
            except Exception as exc: result['history_error']='Saved context could not be loaded: '+str(exc)
        elif selected.get('provider')!=self.provider_state.status()['active']:
            result['history_error']='Switch to '+selected.get('provider','its provider')+' to continue this conversation'
        return result

    def conversation_rename(self, params: dict[str, Any]) -> dict[str, Any]:
        conversation_id, title = params.get("conversation_id"), params.get("title")
        if not isinstance(conversation_id, str) or not isinstance(title, str) or not title.strip():
            raise ValueError("conversation id and title are required")
        title = " ".join(title.split())[:80]
        items, active = self._conversations()
        selected = next((item for item in items if item["id"] == conversation_id), None)
        if selected is None:
            raise ValueError("conversation is unknown")
        selected["title"] = title
        self.state.update(conversations=items)
        return {"active_id": active, "conversations": items}

    def conversation_keep(self, params: dict[str, Any]) -> dict[str, Any]:
        conversation_id = params.get("conversation_id")
        items, active = self._conversations()
        selected = next((item for item in items if item["id"] == conversation_id), None)
        if selected is None:
            raise ValueError("conversation is unknown")
        selected["kept"] = not selected.get("kept", False)
        self.state.update(conversations=items)
        return {"active_id": active, "conversations": items}

    def conversation_forget(self, params: dict[str, Any]) -> dict[str, Any]:
        conversation_id = params.get("conversation_id")
        items, active = self._conversations()
        if not any(item["id"] == conversation_id for item in items):
            raise ValueError("conversation is unknown")
        items = [item for item in items if item["id"] != conversation_id]
        if active == conversation_id:
            active = None
        self.state.update(active_conversation_id=active, thread_id=None if active is None else next(item["thread_id"] for item in items if item["id"] == active), conversations=items)
        return {"active_id": active, "conversations": items}

    def ask_interrupt(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"interrupted": self._codex().interrupt()}

    def close(self) -> None:
        self._reset_codex()

    def initialize(self, _params: dict[str, Any]) -> dict[str, Any]:
        provider_error=None
        # Reloads must not resurrect an old provider during a reconnect or turn.
        if self.work_lock.acquire(blocking=False):
            try:
                provider = self.provider_state.load()
                if provider and not self._broker_healthy(provider):
                    running = self._start_provider_broker(provider)
                    self.provider_state.save(**self._provider_fields(running))
            except (OSError, ConnectionError, ValueError) as exc:
                provider_error=str(exc)
            finally:
                self.work_lock.release()
        result = {
            "product": {
                "name": "ASIP",
                "version": product_version(),
                "machine": platform.node(),
            },
            "desktop": self.state.load(),
            "turn_active": self.turn_active.is_set(),
            "provider_error": provider_error,
        }
        self._conversations()
        result["desktop"] = self.state.load()
        try:
            result["core"] = self.core_snapshot({})
        except (OSError, ConnectionError, ValueError) as exc:
            result["core"] = {"available": False, "message": str(exc)}
        return result

    def _start_change(self, intent: str) -> str:
        return self._mutate("change", action="start", argv=[intent])["change_id"]


    def select_tab(self, params: dict[str, Any]) -> dict[str, Any]:
        tab = params.get("tab")
        if tab not in {"ask", "changes", "computer", "settings"}:
            raise ValueError("unknown Desktop tab")
        return self.state.update(selected_tab=tab)

    def select_theme(self, params: dict[str, Any]) -> dict[str, Any]:
        theme = params.get("theme")
        if theme not in {"dark", "light"}:
            raise ValueError("unknown Desktop theme")
        return self.state.update(theme=theme)

    def core_snapshot(self, _params):
        result={'available':False,'errors':{}}
        queries={'summary':('summary',{}),'brief':('brief',{}),'health':('doctor',{}),
                 'changes':('change',{'action':'list','limit':20}),
                 'current':('change',{'action':'open','limit':100}),
                 'held':('change',{'action':'list','status':'held','limit':100}),
                 'questions':('ask',{'action':'list'}),'access':('access',{'action':'list'})}
        for name,(op,fields) in queries.items():
            try: result[name]=self._read(op,**fields)
            except (OSError,ConnectionError,ValueError) as exc: result['errors'][name]=str(exc)
        result['available']='brief' in result
        if not result['available']: result['message']=result['errors'].get('brief','Core unavailable')
        for key in ('changes','current'):
            page=result.get(key,{})
            result[key+'_before']=page.get('before')
            result[key]=page.get('changes',[])
        held=result.pop('held',{}).get('changes',[])
        result['current']=sorted(result['current']+held,
                                 key=lambda change:change.get('started_at',''),reverse=True)
        return result

    def change_list(self, params):
        return self._read('change',action='list',status=params.get('status','all'),
                          before=params.get('before'),limit=20)

    def operation_detail(self, params):
        return self._read('operation',argv=[params.get('operation_id','')])

    def operation_output(self, params):
        detail=self.operation_detail(params)
        record=detail.get('operation') or {}
        if record.get('capture')=='sensitive': return {'text':'Sensitive output was not retained.'}
        stream=params.get('stream','stdout')
        if stream not in ('stdout','stderr'): raise ValueError('Unknown output stream')
        digest=record.get(stream+'_blob')
        if not digest: return {'text':'No captured output.'}
        return self._read('blob',argv=[digest],offset=params.get('offset',0),limit=8192)

    def change_detail(self, params: dict[str, Any]) -> dict[str, Any]:
        change_id = params.get("change_id")
        if not isinstance(change_id, str) or not change_id:
            raise ValueError("change_id is required")
        return self._read("change", action="show", argv=[change_id])

    def verification_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return self._read("verify", action="list")

    def maintenance_detail(self, params: dict[str, Any]) -> dict[str, Any]:
        action = params.get("action", "list")
        if action not in {"list", "history", "open"}:
            raise ValueError("unknown maintenance view")
        return self._read("maintenance", action=action, limit=20)

    def recovery_detail(self, _params: dict[str, Any]) -> dict[str, Any]:
        return self._read("recovery")

    def health_detail(self, _params: dict[str, Any]) -> dict[str, Any]:
        return self._read("doctor")

    def question_answer(self, params: dict[str, Any]) -> dict[str, Any]:
        question_id = params.get("question_id")
        choice = params.get("choice")
        note = params.get("note", "")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError("question_id is required")
        if choice is not None and not isinstance(choice, str):
            raise ValueError("choice must be a string")
        if not isinstance(note, str) or len(note) > 2000:
            raise ValueError("answer note is invalid")
        fields: dict[str, Any] = {
            "action": "answer",
            "argv": [question_id],
            "note": note,
            "standalone_reason": "Operator answered through ASIP",
        }
        if choice is not None:
            fields["choice"] = choice
        return self._mutate("ask", **fields)

    def access_provision(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        label = params.get("label")
        env_var = params.get("env_var")
        value = params.get("value")
        if not all(isinstance(item, str) for item in (name, label, env_var, value)):
            raise ValueError("authority name, label, environment name, and value are required")
        if not name or not label.strip() or not env_var or not value:
            raise ValueError("authority fields must not be empty")
        return self._mutate(
            "access", action="provision", name=name, label=label,
            env_var=env_var, value=value,
            standalone_reason="Operator provisioned named authority through ASIP",
        )

    def access_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError("authority name is required")
        return self._mutate(
            "access", action="remove", name=name,
            standalone_reason="Operator removed named authority through ASIP",
        )

    def access_dismiss(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError("authority name is required")
        return self._mutate(
            "access", action="dismiss", name=name,
            standalone_reason="Operator dismissed an unrequested authority through ASIP",
        )
