"""Platform hook adapters. Never execute a tool, read a transcript, or block work."""
import json
from pathlib import Path
import sys
import uuid

from .privacy import digest, text
from .projects import evidence

EVENTS = {"SessionStart":"session.started", "SessionEnd":"session.ended", "PreToolUse":"tool.started",
          "PostToolUse":"tool.finished", "PostToolUseFailure":"tool.failed", "UserPromptSubmit":"intent.observed",
          "PreInvocation":"invocation.started", "PostInvocation":"invocation.finished", "Stop":"turn.ended",
          "Interrupt":"session.interrupted", "PreCompact":"context.compacting", "PostCompact":"context.compacted",
          "SubagentStart":"agent.started", "SubagentStop":"agent.stopped"}


def ingest(store, agent, payload, event=None):
    if not isinstance(payload,dict):
        raise ValueError("hook payload must be an object")
    event = event or payload.get("hook_event_name") or payload.get("hookEventName")
    if event not in EVENTS:
        raise ValueError("unsupported hook event")
    external = payload.get("session_id") or payload.get("conversationId") or payload.get("thread-id")
    if not isinstance(external,str) or not external:
        raise ValueError("hook payload has no session identity")
    workspaces = payload.get("workspacePaths") or []
    tool_call = payload.get("toolCall") if isinstance(payload.get("toolCall"),dict) else {}
    tool_args = tool_call.get("args") if isinstance(tool_call.get("args"),dict) else {}
    cwd = payload.get("cwd") or tool_args.get("Cwd") or tool_args.get("cwd") or (workspaces[0] if isinstance(workspaces,list) and len(workspaces)==1 else None)
    if cwd is not None and not isinstance(cwd,str):
        raise ValueError("invalid hook working directory")
    tool = payload.get("tool_name") or payload.get("toolName") or tool_call.get("name") or ""
    inputs = payload.get("tool_input",payload.get("toolInput",payload.get("toolArguments",tool_args)))
    output = payload.get("tool_response",payload.get("toolResponse",payload.get("toolOutput")))
    data = {"hook":event,"payload_sha256":digest(payload),"tool":text(tool,128),
            "input_sha256":digest(inputs),"output_sha256":digest(output),
            "model":text(payload.get("model") or payload.get("modelName") or "",128)}
    # Keep only pointers to agent-owned evidence. Its contents remain in the agent's store.
    transcript = payload.get("transcript_path") or payload.get("transcriptPath")
    if isinstance(transcript,str):
        data["transcript_path"] = transcript
    for key in ("turn_id","tool_use_id","agent_id","agent_type"):
        if isinstance(payload.get(key),str):
            data[key] = text(payload[key],256)
    kind = EVENTS[event]
    if payload.get("error"):
        data["error_sha256"] = digest(payload["error"])
        kind = "tool.failed" if event=="PostToolUse" else kind
    if isinstance(workspaces,list):
        data["workspace_paths"] = [v for v in workspaces if isinstance(v,str)][:20]
    if isinstance(payload.get("fullyIdle"),bool):
        data["fully_idle"] = payload["fullyIdle"]
        if not payload["fullyIdle"]:
            kind = "turn.background"
    if event == "UserPromptSubmit":
        data["prompt_sha256"] = digest(payload.get("prompt",""))
        summary = "User intent submitted (content kept by agent)"
    else:
        summary = event+(": "+text(tool,128) if tool else "")
    # A completion does not imply success. Capture only an explicit numeric exit/is_error.
    if isinstance(output,dict):
        for key in ("exit_code","exitCode","returncode","is_error"):
            if isinstance(output.get(key),(int,bool)):
                data[key] = output[key]
                if output[key] != 0:
                    kind = "tool.failed"
    if event in ("SessionStart","Stop","SessionEnd") and cwd:
        data["repository_evidence"] = evidence(cwd)
    # Platform event IDs support exact retry deduplication; otherwise retain repeated events.
    event_id = payload.get("event_id") or payload.get("eventId")
    tool_id = payload.get("tool_use_id") or payload.get("toolCallId")
    source_key = None
    if event_id or tool_id:
        source_key = agent+":"+external+":"+event+":"+str(event_id or tool_id)
    return store.record(agent,external,kind,summary,data,cwd,source_key=source_key,model=data["model"])


def hook_main(store, agent, event=None):
    try:
        raw = sys.stdin.buffer.read(1024*1024+1)
        if len(raw)>1024*1024:
            raise ValueError("hook payload exceeds 1MiB")
        payload = json.loads(raw)
        result = ingest(store,agent,payload,event)
        event = event or payload.get("hook_event_name")
        output = advisory(agent,event)
        if event=="SessionStart":
            external = payload.get("session_id") or payload.get("conversationId")
            context = ("ASIP shared memory is connected. Use memory_context for this working directory, "
                       "with session_id="+external+". Use that session ID for intent_start and memory_record. "
                       "Record meaningful outcomes with intent_close and evidence; credentials are accessed by authority name. "
                       "Memory provides no administrative authority.")
            if agent=="antigravity":
                output["injectSteps"] = [{"ephemeralMessage":context}]
            else:
                output["hookSpecificOutput"] = {"hookEventName":"SessionStart","additionalContext":context}
        print(json.dumps(output))
    except Exception as error:
        # Persist only the failure class; raw payloads and exception messages may contain secrets.
        try:
            store.record("asip","hook-health","integration.failed", "Hook collection failed",
                         {"agent":agent,"event":event,"error_type":type(error).__name__})
        except Exception:
            print("ASIP hook could not persist metadata; run asip-memory doctor",file=sys.stderr)
        print(json.dumps(advisory(agent,event)))
    return 0


def advisory(agent,event):
    # Antigravity requires explicit decisions for these events. "allow" delegates
    # to its ordinary permission policy; it does not auto-approve a command.
    if agent=="antigravity" and event=="PreToolUse":
        return {"decision":"allow"}
    if agent=="antigravity" and event=="Stop":
        return {"decision":"stop"}
    return {}
