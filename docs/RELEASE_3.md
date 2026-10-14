# ASIP 3.0.0 implementation report

ASIP is now a project-centered agent memory product alongside its retained
Linux administration layer. The implementation is reviewed in
[PR #2](https://github.com/M-o-liver/asip-linux/pull/2).

## Built

The portable runtime has SQLite persistence, native session IDs, explicit
intentions and outcomes, event/evidence search, repository grouping, project
relationships, corruption checks, and ten verified recovery checkpoints.
Recording works while Beacon is closed. Platform hooks retain metadata/hashes
and references to agent-owned evidence; explicit MCP tools make results useful.

Codex, Claude Code and Antigravity have separate native configuration installers
and plugin packages. Native session IDs connect hooks to intentions. The
installer preserves unrelated configuration and execution permissions. The
existing Linux MCP servers retain their separate root/read authority.

Named portable API connections use native OS vaults, project grants and open
intentions. Fixed-origin HTTPS requests and bounded credential children preserve
authority names in history without retaining values. GitHub device OAuth and
Google Desktop PKCE/refresh are implemented. Native agent subscription logins
remain with their owners. Original Linux named authorities remain available.

Jev is an explicit, optional ambiguity resolver. Responses are validated,
confidence/margin policy can abstain, and suggestions require review. It does
not block collection or silently rewrite associations.

Beacon provides the loopback browser application, native tray backends, a GNOME
top-bar extension and per-user platform startup registration. Projects are the
landing view, with roots, sessions, intentions, history, hashes, grants and
recovery. Original Linux journal metadata can be imported read-only.

## What works and what was learned

The local portable suite and all six Linux/Windows/macOS CI jobs pass. The
package builds/installs; native Linux vault storage and a credential-bound child
were exercised with a disposable entry and cleaned up. Codex recognizes its
server, Claude connects, and the installed Beacon service opens a working local
browser workspace. Detailed evidence is in [Qualification](QUALIFICATION.md).

Separating memory from elevation makes normal collection portable and removes
root from routine project work. Agent platforms share MCP/skills concepts but
their hook schemas are not interchangeable: Antigravity uses distinct
configuration and camelCase tool/session payloads. A completion must not become
a fabricated success. Repository evidence is a stronger default association
than a probabilistic model, which belongs on an explicit review path.

Actual use found a service/open startup race, keyring-chain compatibility issue,
session-attribution gap, and crowded project map. Those were corrected. CI
found a macOS-specific test assumption. Synthetic tests alone would have missed
the native service and vault integration issues.

## Portability and remaining qualification

The product uses standard platform state directories, detected executable
locations and native agent configuration. It does not depend on a particular
computer's repositories, dotfiles, hardware or machine policy. Beacon startup
uses the platform's user service mechanism. The optional Linux administration
adapter and its machine policy remain separate from portable recording.

Per-machine installation and recovery notes belong to private local state.
The public repository contains software, portable tests and documented contracts.

Codex hooks still require native review/trust after agent restart. Antigravity
is contract/fixture-qualified because its executable is not installed locally.
Interactive Google/GitHub consent requires the operator's registered OAuth
client. Live OpenAI/Anthropic/Jev API behavior requires provisioned authorities;
Jev model accuracy was not measured. Native Windows/macOS tray interaction needs
those desktop environments. GNOME's installed indicator appears after extension
discovery at the next login; the browser application works in the current session.

These remaining checks are explicit qualification limits, not hidden claims of
tested provider or desktop behavior. They are also recorded locally for follow-up.
