---
name: asip-memory
description: Recall and maintain ASIP's shared project memory when continuing work across agent sessions, recording intended changes and evidence, or using named API connections.
---

ASIP is local shared memory for Codex, Claude Code and Antigravity. Its memory
MCP tools run as the login user and do not grant administrative authority.

Use `memory_context` with the actual working directory and the session ID
provided by ASIP's SessionStart hook to recall a project's
recent evidence and unresolved intentions. Treat historical observations as
history, and verify current facts before acting. A session may touch several
projects; use the appropriate cwd/project on each record.

For coherent work, use `intent_start` with a concrete summary and cwd. Keep its
ID. Record significant actions or externally observed effects with
`memory_record`; include relevant file paths, commits, test results or journal
references as evidence. Use `intent_close` to record finished, failed or held
work and what remains unresolved. Hooks capture activity metadata automatically;
they do not prove success or replace a clear outcome.

`access_list` shows authority names, never values. API calls and credential
children require an open intent and the operator's grant to that project.
Use `access_call` for a provider-relative API path, or `access_use` for finite
user argv. Configure/grant connections in the local ASIP application. Never
request credential values in conversation. A denied grant requires local
operator action and is not permission to extract another agent's login.

The separate Linux administration MCP remains root-equivalent. For system
work, follow its machine policy, explicit change IDs and typed tools. Reference
its change/operation IDs in project memory when useful. A memory intent ID is
not a Linux administrative change ID. Holds stay unresolved until explicitly
resolved; opening the application does not release them.
