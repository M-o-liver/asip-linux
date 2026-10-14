"""Native MCP/skill/hook setup, with scoped merging and recoverable backups."""
from datetime import datetime, timezone
import importlib.resources
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

from .paths import atomic_json

AGENTS = ("codex","claude-code","antigravity")


def command(agent,event):
    argv = [sys.executable,"-m","memory","hook","--agent",agent,"--event",event]
    return subprocess.list2cmdline(argv) if os.name=="nt" else shlex.join(argv)


def hooks(agent):
    events = ["SessionStart","PreToolUse","PostToolUse","Stop"]
    if agent!="antigravity":
        events += ["UserPromptSubmit","SessionEnd"]
    if agent=="claude-code":
        events += ["PostToolUseFailure"]
    if agent=="codex":
        events += ["Interrupt","PreCompact","PostCompact","SubagentStart","SubagentStop"]
    result = {}
    for event in events:
        handler = {"type":"command","command":command(agent,event),"timeout":10}
        if agent=="antigravity" and event not in ("PreToolUse","PostToolUse"):
            result[event] = [handler]
        else:
            result[event] = [{"matcher":"", "hooks":[handler]}]
    return {"asip-memory":result} if agent=="antigravity" else {"hooks":result}


def plan(agent, home=None):
    if agent not in AGENTS:
        raise ValueError("unsupported agent")
    home = Path(home or Path.home())
    server = {"command":sys.executable,"args":["-m","memory","mcp","--agent",agent]}
    if agent=="codex":
        root = Path(os.environ.get("CODEX_HOME",str(home/".codex"))) if home==Path.home() else home/".codex"
        return {"agent":agent,"mcp_path":str(root/"config.toml"),"hook_path":str(root/"hooks.json"),
                "skill_path":str(home/".agents/skills/asip-memory/SKILL.md"),"server":server,"hooks":hooks(agent)}
    if agent=="claude-code":
        return {"agent":agent,"mcp_path":str(home/".claude.json"),"hook_path":str(home/".claude/settings.json"),
                "skill_path":str(home/".claude/skills/asip-memory/SKILL.md"),"server":server,"hooks":hooks(agent)}
    root = home/".gemini/config"
    return {"agent":agent,"mcp_path":str(root/"mcp_config.json"),"hook_path":str(root/"hooks.json"),
            "skill_path":str(root/"skills/asip-memory/SKILL.md"),"server":server,"hooks":hooks(agent)}


def backup(path):
    if path.exists():
        name = path.name+".asip-backup-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        target = path.with_name(name)
        shutil.copy2(path,target)
        target.chmod(0o600)
        return str(target)


def load(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_config(path,value,backups):
    previous = backup(path)
    if previous:
        backups.append(previous)
    # Resolve symlinks to preserve Stow ownership; back up the actual target too.
    if path.is_symlink():
        path = path.resolve()
        previous = backup(path)
        if previous:
            backups.append(previous)
    atomic_json(path,value)


def install(agent,home=None):
    proposal = plan(agent,home)
    mcp = Path(proposal["mcp_path"])
    hook_path = Path(proposal["hook_path"])
    backups = []
    # Validate every input before mutating any user configuration.
    old_hooks = load(hook_path)
    if agent=="codex":
        import tomllib
        content = mcp.read_text(encoding="utf-8") if mcp.exists() else ""
        parsed = tomllib.loads(content)
        existing = parsed.get("mcp_servers",{}).get("asip-memory")
        if existing and (existing.get("command"),existing.get("args")) != (proposal["server"]["command"],proposal["server"]["args"]):
            raise ValueError("An asip-memory server already exists; review it before replacement")
    else:
        config = load(mcp)
        existing = config.get("mcpServers",{}).get("asip-memory")
        if existing and existing!=proposal["server"]:
            raise ValueError("An asip-memory server already exists; review it before replacement")
    skill_path = Path(proposal["skill_path"])
    skill = importlib.resources.files("integrations").joinpath("skill.md").read_text(encoding="utf-8")
    if skill_path.exists() and skill_path.read_text()!=skill:
        raise ValueError("An ASIP skill already exists with different content; review it before replacement")
    if agent=="codex":
        if not existing:
            content += "\n[mcp_servers.asip-memory]\ncommand = "+json.dumps(sys.executable)+"\nargs = "+json.dumps(proposal["server"]["args"])+"\n"
            actual = mcp.resolve() if mcp.is_symlink() else mcp
            previous = backup(actual)
            if previous:
                backups.append(previous)
            actual.parent.mkdir(parents=True,exist_ok=True)
            from tempfile import NamedTemporaryFile
            with NamedTemporaryFile("w",encoding="utf-8",dir=actual.parent,delete=False) as handle:
                handle.write(content); handle.flush(); os.fsync(handle.fileno())
            os.replace(handle.name,actual)
    else:
        config.setdefault("mcpServers",{})["asip-memory"] = proposal["server"]
        write_config(mcp,config,backups)
    if agent=="antigravity":
        old_hooks["asip-memory"] = proposal["hooks"]["asip-memory"]
    else:
        current = old_hooks.setdefault("hooks",{})
        for event,groups in proposal["hooks"]["hooks"].items():
            kept = []
            for group in current.get(event,[]):
                remaining = [h for h in group.get("hooks",[]) if "-m memory hook --agent "+agent not in h.get("command","")]
                if remaining:
                    kept.append({**group,"hooks":remaining})
            current[event] = kept+groups
    write_config(hook_path,old_hooks,backups)
    skill_path.parent.mkdir(parents=True,exist_ok=True)
    skill_path.write_text(skill,encoding="utf-8")
    return {"agent":agent,"configured":[str(mcp),str(hook_path),str(skill_path)],"backups":backups,
            "next":"Restart the agent and review/trust ASIP hooks in its native interface. ASIP does not change permission settings."}
