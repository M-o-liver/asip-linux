#!/usr/bin/env python3
"""Regenerate platform plugin packages from ASIP's native configuration."""
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from memory.integrations import AGENTS, hooks


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2)+"\n")


for agent in AGENTS:
    root=ROOT/"integrations"/agent
    skill=root/"skills/asip-memory/SKILL.md"
    skill.parent.mkdir(parents=True,exist_ok=True)
    skill.write_text((ROOT/"integrations/skill.md").read_text())
    manifest={"name":"asip-memory","version":"3.0.0","description":"Shared project memory, intent, audit and named API access for your agents",
              "author":{"name":"M-o-liver"}}
    server={"command":"asip-memory","args":["mcp","--agent",agent]}
    config=hooks(agent)
    def portable(value,event=None):
        if isinstance(value,dict):
            if value.get("type")=="command":
                event=value["command"].split("--event ",1)[-1]
                return {**value,"command":"asip-memory hook --agent "+agent+" --event "+event}
            return {k:portable(v) for k,v in value.items()}
        if isinstance(value,list):
            return [portable(v) for v in value]
        return value
    if agent=="codex":
        manifest.update({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                         "extensions":{"com.openai":{"hooks":"./hooks/hooks.json"}}})
        write(root/"plugin.json",manifest)
        write(root/"mcp.json",{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"asip-memory":{"type":"stdio",**server}}})
        # Compatibility overlay for Codex CLI versions using the earlier local package layout.
        write(root/".codex-plugin/plugin.json",{"name":"asip-memory","version":"3.0.0","description":manifest["description"],"skills":"./skills/","mcpServers":"./.mcp.json","hooks":"./hooks/hooks.json"})
        write(root/".mcp.json",{"mcpServers":{"asip-memory":server}})
        write(root/"hooks/hooks.json",portable(config))
    elif agent=="claude-code":
        write(root/".claude-plugin/plugin.json",manifest)
        write(root/".mcp.json",{"mcpServers":{"asip-memory":server}})
        write(root/"hooks/hooks.json",portable(config))
    else:
        write(root/"plugin.json",{"$schema":"https://antigravity.google/schemas/v1/plugin.json","name":manifest["name"],"description":manifest["description"]})
        write(root/"mcp_config.json",{"mcpServers":{"asip-memory":server}})
        write(root/"hooks.json",portable(config))

write(ROOT/".claude-plugin/marketplace.json",{"name":"asip","owner":{"name":"M-o-liver"},"plugins":[
    {"name":"asip-memory","source":"./integrations/claude-code","description":"The memory of your agents","version":"3.0.0"}]})
