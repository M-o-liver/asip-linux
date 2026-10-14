# ASIP

**The memory of your agents.**

ASIP gives Codex, Claude Code and Google Antigravity a shared local record of their projects, intentions, activity, results and API access. Open its project workspace to understand what happened, what evidence supports it, and what still needs follow-through.

ASIP 3 adds portable, user-owned agent memory and Beacon to the existing Linux administration layer. Routine recording works without root. Linux privileged operations, their journal, named credentials and recovery remain on separate sockets and MCP adapters.

## Start here

Python 3.11+ and Git are required. On Linux, macOS or Windows:

```sh
git clone https://github.com/M-o-liver/asip-linux.git
cd asip-linux
python -m venv .venv
```

Activate it (`. .venv/bin/activate` on Linux/macOS; `.venv\Scripts\Activate.ps1` in Windows PowerShell), then:

```sh
python -m pip install '.[beacon]'
asip-memory integrate all --apply
asip-beacon --tray --open
```

Restart your agents and review ASIP hooks in their native interfaces. Configuration preserves other servers/hooks and creates backups. `asip-memory integrate codex` previews the exact plan. Native [plugin packages and setup details](docs/INTEGRATIONS.md) are also included.

Beacon opens a private loopback application. On GNOME, use the bundled [top-bar extension](integrations/gnome-beacon) instead of a traditional tray. `asip-memory startup` writes per-user startup registration and prints its activation command: a user systemd service on Linux, a LaunchAgent on macOS, or a Startup launcher on Windows.

## What ASIP remembers

- **Projects:** repository identity, local roots and explicit relationships. Different checkouts of the same remote share a project. Unknown work stays unresolved until there is reliable evidence.
- **Sessions:** native conversation IDs, agent/model labels, observed activity and the owning OS account. Sessions can span projects.
- **Intentions:** intended work, open/held/finished/failed states, outcomes and supporting evidence.
- **Events:** tool metadata, input/output hashes, trace pointers, Git HEAD/status, test results and Linux journal references.
- **API connections:** stable authority names, providers and project grants. Values remain in the OS vault or existing Linux authority store.
- **Recovery:** at most ten verified memory checkpoints, alongside separate Linux recovery information.

Hooks collect metadata even when Beacon is closed. The skill and MCP tools add meaningful intentions and outcomes during normal work. Hooks do not copy raw tool arguments, outputs, prompts or transcript contents. Completion alone does not prove success. Activity recency is an observation, not a guaranteed live connection.

**Projects** is the landing view: relationship map, repository roots, sessions, intentions, history and evidence. **Activity** searches across the record. **API connections** manages grants. **Agents** shows setup and observations. **Recovery** manages checkpoints. **This computer** retains Linux health, attention and change views.

## API access

Supported providers are GitHub, Google OAuth, Google Gemini, OpenAI, Anthropic and TypeSafe Jev. Add a connection in the application or provision it interactively:

```sh
asip-memory access configure openai.api_key openai
asip-memory access configure anthropic.api_key anthropic
asip-memory access configure typesafe.jev typesafe
asip-memory access grant openai.api_key PROJECT_ID
```

Values never enter connection lists or audit records. Native storage uses Linux Secret Service/libsecret, macOS Keychain or Windows Credential Manager. Unsupported/plaintext vault backends fail closed.

Browser sign-in uses your registered OAuth application:

```sh
asip-memory access github-login github.oauth --client-id YOUR_CLIENT_ID --scopes read:user
asip-memory access google-login google.oauth --client-id YOUR_CLIENT_ID --scopes 'openid email profile'
```

Enable Device Flow on the GitHub app. Use a Google Desktop OAuth client; ASIP verifies state, uses a loopback callback with PKCE and stores refresh material in the OS vault. Choose scopes appropriate to your project. OpenAI/Anthropic subscription sign-ins remain with Codex/Claude; ASIP does not extract their login stores.

Agents use `access_call` for a provider-relative API request or `access_use` for finite user argv. Both require an open intention and an operator grant to that project. Requests stay on a fixed provider HTTPS origin and reject redirects. Child execution has deadlines and bounded output. Authorized children can still misuse credentials: ASIP is not a sandbox.

Existing Linux named credentials remain available through the administration MCP's `access_list`, `access_request` and `access_use`, under their original authority and audit rules. The workspace displays their metadata without copying their values.

## Project organization and Jev

Git identity and actual cwd are the default. Register durable non-Git work and import existing Linux metadata:

```sh
asip-memory project research /absolute/path/to/research --description 'Research workspace'
asip-memory sync-system --limit 200
```

Import is read-only, deduplicated and bounded; the original Linux journal remains authoritative. ASIP does not crawl your home directory.

Jev is opt-in and outside the recording path:

```sh
asip-memory classify 'Sanitized description of ambiguous activity' --intent-id INTENT_ID
```

A granted `typesafe.jev` authority sends a bounded classification request. ASIP validates the typed distribution and records a review suggestion with confidence and abstention. It never silently overrides repository evidence or reassigns history. Included tests qualify the adapter, not live model accuracy.

## Recovery and durable state

Portable state lives in `~/.local/state/asip/memory` on Linux, `~/Library/Application Support/ASIP` on macOS and `%LOCALAPPDATA%\ASIP` on Windows. `ASIP_HOME` selects another private directory. SQLite WAL/FULL transactions preserve records; an event hash chain detects local corruption. The owning user/root can rewrite the store, so it is not tamper-proof.

```sh
asip-memory doctor
asip-memory checkpoint 'Before changing integrations'
asip-memory checkpoint
# Stop Beacon and all agents before replacing memory:
asip-memory restore RECOVERY_ID --agents-stopped
```

At most ten memory checkpoints are retained. Restore validates checksums and SQLite integrity, refuses a running Beacon and makes a pre-restore checkpoint. Credentials and project files are outside memory recovery. Back up private state separately for off-machine continuity; never commit it to this repository.

## Linux administration

The existing Linux layer requires systemd and a trusted root installation:

```sh
./install.sh --system --operator YOUR_LOGIN
./install.sh --user mcp
```

Read `install.sh`, `scripts/install_system.sh` and [SECURITY.md](SECURITY.md) before granting access. Membership in `asip` or access to `/run/asip/sock` grants arbitrary root authority. ASIP serializes and audits operations; it is not a command allowlist. The separate `/run/asip/read.sock` can inspect but cannot execute or mutate the journal.

Attach `~/.local/bin/asip-mcp-inspect` and, when authorized, `~/.local/bin/asip-mcp-admin` as separate stdio servers. Read `/etc/asip/MACHINE.md`, start explicit changes for coherent system work and pass their IDs on mutations. Portable intention IDs and administrative change IDs serve different records.

System history remains at `/var/lib/asip/journal.jsonl`, with captured evidence under `/var/lib/asip/blobs`. Snapper recovery uses ASIP operation handles, not raw snapshot numbers. Installation backups and the independent `asip-restore` helper remain. Coordinate root-daemon updates with other callers; Beacon updates need no root-daemon restart.

The older GTK/Codex administration application remains available via `./install.sh --user desktop` and `asip-desktop`.

## Development and qualification

```sh
python -m unittest discover -s tests -v
python -m compileall -q memory core desktop asip_mcp.py
python scripts/build_plugins.py
claude plugin validate integrations/claude-code
```

CI tests portable behavior on Linux, Windows and macOS with Python 3.11/3.13. Native tray/menu-bar interaction, OS vault integration, OAuth consent and native agent discovery/trust need separate checks. See [architecture](docs/NEXT_ARCHITECTURE.md), [integration contracts](docs/INTEGRATIONS.md) and [qualification evidence](docs/QUALIFICATION.md).

This is software the author uses, published as-is under [Apache-2.0](LICENSE). No distro or platform support guarantee is implied.
