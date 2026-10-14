# Native agent integrations

Install the portable runtime first. Use either the native configuration
installer or a plugin package for each agent, to avoid duplicate hooks.

```sh
python -m pip install '.[beacon]'
asip-memory integrate all             # inspect the exact configuration plan
asip-memory integrate all --apply     # apply scoped merges and retain backups
```

The installer uses the runtime's absolute Python path rather than depending on
an agent's PATH. It preserves other MCP servers, hooks, agent permissions and
Stow symlinks. A conflicting existing ASIP server/skill fails for review.
Restart the agent after setup. Codex hooks require native review/trust; ASIP
does not silently trust hooks or broaden execution permissions.

| Agent | MCP configuration | Hook configuration | Skill |
|---|---|---|---|
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex`) | `$CODEX_HOME/hooks.json` | `~/.agents/skills/asip-memory` |
| Claude Code | `~/.claude.json` user `mcpServers` | `~/.claude/settings.json` | `~/.claude/skills/asip-memory` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/hooks.json` | `~/.gemini/config/skills/asip-memory` |

ASIP's SessionStart hook provides the native conversation ID. The skill uses it
in `memory_context`, `intent_start` and `memory_record`, tying explicit outcomes
to automatically collected activity. MCP's `initialize.clientInfo` is retained
as provenance; it is not an authenticated model identity.

## Plugin packages

The repository includes installable platform packages under `integrations/`.
They require `asip-memory` on the agent's PATH. The direct installer above uses
an absolute executable and is the most predictable local setup.

Claude Code:

```text
/plugin marketplace add M-o-liver/asip-linux
/plugin install asip-memory@asip
```

Validate the package with `claude plugin validate integrations/claude-code`.
The repository root `.claude-plugin/marketplace.json` points to this package.

Codex includes both portable `plugin.json` / `mcp.json` and the compatibility
`.codex-plugin` / `.mcp.json` layout. Use its local plugin import interface with
`integrations/codex`, or the direct configuration installer. Lifecycle-hook
plugins are local/desktop integrations, not eligible for the public universal
directory under the current OpenAI submission rules.

Antigravity:

```sh
agy plugin install /absolute/path/to/asip-linux/integrations/antigravity
```

Its plugin has native `plugin.json`, `mcp_config.json`, `hooks.json` and skills.
The direct installer supports the current shared global paths used by the app,
CLI and IDE. Older Antigravity versions may use legacy paths: check the native
MCP manager rather than silently writing several conflicting configurations.

## Linux administration

The existing separate inspection and administration MCP servers remain
available. They grant different authority from portable memory. Install them
with `./install.sh --user mcp`; attach only the roles the agent needs. Follow
`/etc/asip/MACHINE.md`, start explicit administrative changes and reference
those journal IDs from project intentions. Never pass a memory intention ID to
a Linux system mutation as its change ID.

## Native presence and startup

`asip-beacon --tray --open` runs the browser workspace and a native tray/menu bar
where supported. `asip-memory startup` writes per-user startup registration and
prints its activation command. Running `asip-beacon --open` while Beacon is
already active opens the existing service; it does not start a competing writer.

For GNOME 48–50, copy `integrations/gnome-beacon/` into
`~/.local/share/gnome-shell/extensions/asip-beacon@asip.local/`, log out/in if
required for discovery, and enable `asip-beacon@asip.local` with GNOME Extensions.
The indicator reads only Beacon's private status file. Clicking it opens ASIP.
GNOME extension APIs and shell versions require their own native qualification.

## Sources researched on 2026-10-14

- [OpenAI plugin packaging and lifecycle hooks](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude plugin manifests](https://code.claude.com/docs/en/plugins-reference)
- [Antigravity MCP](https://antigravity.google/docs/mcp)
- [Antigravity hooks](https://antigravity.google/docs/hooks)
- [Antigravity plugins](https://antigravity.google/docs/plugins)
- [GitHub OAuth and device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [TypeSafe API OpenAPI contract](https://api.typesafe.ai/openapi.json)

These are the primary contracts used for the adapters. Hosted plugin
distribution, provider consent, subscription authentication and native desktop
support are distinct from local configuration and MCP protocol correctness.
