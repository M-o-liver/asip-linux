"""Small user-owned state for Desktop convenience, never machine truth."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


DEFAULT_STATE = {
    "schema_version": 1,
    "selected_tab": "ask",
    "thread_id": None,
    "theme": "light",
    "active_conversation_id": None,
    "conversations": [],
}

def private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True)
            handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def state_directory() -> Path:
    root = os.environ.get("XDG_STATE_HOME")
    if root:
        return Path(root) / "asip" / "desktop"
    return Path.home() / ".local" / "state" / "asip" / "desktop"


class DesktopState:
    def __init__(self, path: Path | None = None):
        self.path = path or state_directory() / "state.json"
        self.lock = threading.RLock()

    def load(self) -> dict[str, Any]:
        state = {**DEFAULT_STATE, 'conversations': []}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return state
        if not isinstance(value, dict) or value.get("schema_version") != 1:
            return state
        if value.get("selected_tab") in {"ask", "changes", "computer", "settings"}:
            state["selected_tab"] = value["selected_tab"]
        if isinstance(value.get("thread_id"), str) or value.get("thread_id") is None:
            state["thread_id"] = value.get("thread_id")
        if value.get("theme") in {"dark", "light"}:
            state["theme"] = value["theme"]
        if isinstance(value.get("active_conversation_id"), str) or value.get("active_conversation_id") is None:
            state["active_conversation_id"] = value.get("active_conversation_id")
        conversations = value.get("conversations")
        if isinstance(conversations, list):
            bounded = []
            for item in conversations:
                if not isinstance(item, dict):
                    continue
                conversation_id = item.get("id")
                thread_id = item.get("thread_id")
                if not isinstance(conversation_id, str) or not conversation_id or len(conversation_id) > 128:
                    continue
                if thread_id is not None and (not isinstance(thread_id, str) or not thread_id or len(thread_id) > 512):
                    continue
                messages=item.get('messages')
                if not isinstance(messages,list):
                    messages=[]
                bounded.append({
                    "id": conversation_id,
                    "thread_id": thread_id,
                    "title": item.get("title") if isinstance(item.get("title"), str) else "Quick Ask",
                    "kept": bool(item.get("kept", False)),
                    "created_at": item.get("created_at", ""),
                    "updated_at": item.get("updated_at", ""),
                    "turns": max(0, int(item.get("turns", 0))) if isinstance(item.get("turns", 0), int) else 0,
                    "harness": "codex",
                    # Existing conversations predate provider ownership.
                    "provider": item.get("provider") if item.get("provider") in {"chatgpt", "google", "compatible"} else "legacy",
                    "messages": [dict(role=m.get('role'), text=m.get('text','')[:32768], state=m.get('state',''))
                        for m in messages[-80:] if isinstance(m,dict)
                        and m.get('role') in ('user','assistant') and isinstance(m.get('text'),str)],
                })
            state["conversations"] = [i for i in bounded if i['kept']] + [i for i in bounded if not i['kept']][:32]
        if not any(i['id'] == state['active_conversation_id'] for i in state['conversations']):
            state['active_conversation_id'] = None
        return state
    def update(self, **fields: Any) -> dict[str, Any]:
        with self.lock:
            state = self.load()
            state.update(fields)
            private_json(self.path,state)
            return state
