# ASIP

ASIP keeps project history across Codex, Claude Code, and Antigravity.

Beacon runs on your computer. Its native plugins record agent activity and let agents recall project work and use named API connections. Open ASIP from Beacon to browse that history.

[Download ASIP](https://github.com/M-o-liver/asip-linux/releases) · [Installation and test guide](ALPHA.md).

## Install and connect

1. Install **ASIP Beacon** for your operating system.
2. Open **Agents**. Choose **Open in ChatGPT** for its desktop app, or **Install** for an available agent CLI and Antigravity.
3. Open a new agent session. ASIP opens its sign-in window automatically. Choose Google or GitHub, or click **Connect** if Beacon is already signed in.
4. In ChatGPT, open **Plugins → ASIP → Hooks → Review** and enable ASIP’s hooks. In Codex CLI, review ASIP in **/hooks**. Restart Antigravity after installation.

Beacon keeps all three plugin bundles in its own application-data folder. **Show plugin folder** opens the relevant bundle if you prefer installing through your agent’s plugin manager. ChatGPT opens its native ASIP installation page directly. Claude Code uses its native plugin manager; **Show plugin folder** is available when its CLI is not found. Antigravity can be installed for its desktop app without a CLI. There is no export destination to choose.

On Windows, the Install button runs the same native commands as on macOS and Linux, with arguments passed directly to the provider’s executable. Claude Code uses `claude plugin marketplace add <managed-folder>` followed by `claude plugin install asip@asip`. Codex uses `codex plugin marketplace add <managed-folder>` and `codex plugin add asip@asip`. Antigravity uses `agy plugin install <managed-folder>` when available and verifies the native desktop registration at `~/.gemini/config/plugins/asip`. Without the CLI, Beacon registers its managed bundle there directly. Windows uses a real plugin directory because Antigravity’s desktop discovery skips junctions; Beacon refreshes that directory on upgrades.

Linux opens Beacon as a full desktop application. Windows and macOS open a nearly square panel anchored to the tray or menu-bar icon, with an **Open full window** control. If tray placement is unavailable, Beacon opens the full application. **Open ASIP** opens the project workspace in your browser.

Recording starts after the plugin finishes connecting. Disconnecting a plugin stops its recording and does not trigger another automatic connection prompt. Use the plugin’s setup command or ask it to connect ASIP to reconnect. Codex’s native hook review remains necessary; MCP startup alone does not establish automatic capture.

ASIP's Google desktop client and GitHub OAuth app are registered. Public client IDs live in `beacon/signin.json`. Google also requires its desktop client credential; use the registered client JSON as `ASIP_GOOGLE_DESKTOP_CLIENT_JSON` when running `node scripts/configure-signin.mjs` before packaging. The client JSON is excluded from Git. Google sign-in is disabled in builds missing it. Real Google sign-in, the installed Codex plugin's connection, and record/recall through Codex's MCP runtime have been verified. GitHub sign-in has fixture coverage but still needs a real login check.

## What is implemented

- A full Linux desktop Beacon and anchored Windows/macOS panels, with SVG controls, recent work, managed plugin installation, API connections, recovery, and account settings.
- A browser workspace with projects, a project map, sessions, intent/result filters, searchable history, API connections, and an evidence inspector. Older sessions are paginated and the displayed total includes all recorded sessions. Map links represent actual sessions shared across projects; focusing a project highlights its relationships.
- Starts at login by default using each platform's startup mechanism. You can turn this off in Beacon settings.
- A standalone compiled helper bundled with each plugin. Users do not install Python, Node, or Go.
- Native Codex and Claude Code plugin manifests, onboarding skills, MCP tools, and lifecycle hooks. First MCP startup opens the account connection without a model request.
- An Antigravity plugin bundle using its own hook format and conversation metadata, installed and inspected through its native CLI on all three operating systems, with desktop registration checked separately.
- Automatic Antigravity final-response capture from its native conversation transcript, including source-row evidence. Completed replies appear in recent work without an explicit ASIP request.
- Google authorization code sign-in with PKCE and verified identity tokens; GitHub device sign-in with a verified provider account.
- A connection handshake between the installed plugin and Beacon.
- Durable account-specific activity records: agent, native session, project, intent, tool input/result, failure, repository revision, worktree state, and trace reference.
- Project identity shared across SSH and HTTPS repository URLs, plus working-directory fallback.
- Search and manual intent/result/evidence records through the connected plugin.
- Activity-history recovery with up to ten saved checkpoints; restore saves current history before replacement.
- Named API connections for OpenAI, Anthropic, Gemini, GitHub, Cloudflare, Brave, Exa, fal, Marginalia, Stripe, X, Google Maps, and custom HTTP APIs, with optional project assignments.
- Connection imports preserve names and environment-variable metadata, verify encrypted round trips, and refuse duplicate names. Signing secrets can be retained alongside API credentials.
- Read-only connection checks for supported providers, with the last HTTP result visible in Beacon and the project workspace.
- GitHub repository authorization from Beacon; encrypted API credentials and request/result records linked to the calling agent's project and session.

## API connections

Open **API connections** in Beacon, choose a provider, and name the connection, for example `github.work`. GitHub offers browser authorization for public or private repositories. Other providers accept an API key or token. Assign the connection to recorded projects, or choose **All projects**. The **Check** button makes a read-only request for providers that support it. HTTP 401 or 403 identifies a credential or access problem; editing the credential clears the previous check result.

Connected agents use `asip_connections` to find available connections and `asip_api_request` to call them. Requests use a path on the configured API, such as `/repos/M-o-liver/asip-linux/issues`. Responses include the HTTP status, JSON or text body, and an audit ID. Beacon records the connection, project, session, result, and provider request ID. Interrupted requests remain unresolved in the audit.

Use **Import connections** to load a JSON list of connection objects. Each object needs `name`, `provider`, and `credential`; `projects`, `label`, and `envVar` are optional. Importing never replaces an existing name. The command `ASIP-Beacon.AppImage --import-connections /absolute/path/connections.json` provides the same operation on Linux; the installed executable accepts it on Windows and macOS too. A private local FIFO is supported on Unix. Signing secrets are stored but are not HTTP connections.

API requests currently support JSON bodies up to 64 KiB and responses up to 64 KiB. Larger responses return `truncated: true` without a body; use the provider's pagination or filtering. Streaming and file uploads are not implemented. Google API access currently uses Gemini keys; Google account sign-in does not authorize other Google APIs.

The account is identified by the Google or GitHub provider's stable subject. Account linking, hosted account management, and cross-device synchronization are not implemented.

[Implementation notes](ARCHITECTURE.md) describe record attribution, project association, API behavior, platform qualification, and the Jev investigation.

## Build

Node 24 and Go 1.26 are development requirements. Each operating system builds its own Beacon installer.

```sh
npm ci
npm test
npm run package
```

`npm run build:all-helpers` also compiles helpers for Windows, Linux, and macOS on x64 and arm64. Installer builds include only their own platform's helper and plugins.

Launching Beacon opens its desktop interface. `--open` opens the project workspace instead. Choosing **Open ASIP** opens the local project workspace in your browser. Beacon starts in the background at login by default; an explicit opt-out is retained. Unsigned Mac alpha builds use a per-user LaunchAgent when native login-item registration is unavailable. An expired browser connection offers **Open ASIP** instead of displaying an empty project map.

If you used the earlier ASIP workspace, choose **Import previous history** in Beacon settings and select its `memory.sqlite3` file. The import restores the project catalogue, directories, relationships, events, session metadata, and intent outcomes into the signed-in account. It preserves the original database and saves the current history as a recovery record before importing. Repeating an import does not duplicate records. Projects with no activity remain visible in the map.

`npm start` runs Beacon from source after `npm run build:helper`. Use `--user-data-dir=/absolute/path` when exercising a separate development profile.

The CI workflow runs connection and OAuth fixture tests, installs the Codex and Claude plugins into disposable runner profiles, and builds native installers on Windows, Linux, and both Apple Silicon and Intel Macs. These checks do not verify a real provider login.

Alpha tags matching the application version, such as `v0.4.1-alpha.3`, also publish the installers, native qualification records, and SHA-256 checksums after all four native jobs pass. Release publishing uses the build's repository token; it does not require a personal API credential.

## Qualification and current limits

See [qualification results](QUALIFICATION.md) for the tested builds, native checks, desktop observations, and remaining checks.

Actual Codex CLI sessions have automatically recorded prompts, tool calls/results, repository revision, worktree state, and final results. ChatGPT and Antigravity completed native file-verification and memory workflows in the Windows and Intel Mac VMs. Fresh ChatGPT conversations recalled Antigravity's saved verification without reading the project files; Mac Antigravity also retrieved ChatGPT's saved evidence. After native hook review, ChatGPT automatically recorded the prompt and final response on both systems. Windows path reconciliation merged the agents' earlier duplicate project entries and retained all records. Linux Antigravity completed a native MCP workflow, and Codex retrieved its result. Claude complete-turn capture still needs an authenticated paid account.

Antigravity also passed ordinary reply capture on Linux, Windows, and Intel Mac: the native reply appeared automatically in Beacon's recent work and the project workspace with its transcript source. Codex retrieved the Linux reply through ASIP. Existing generic Stop records are preserved; the change applies to new completed turns.

GitHub repository authorization and a real API call through Codex's installed plugin have passed, including the stored request/result audit. Recall excludes ASIP's own tool-call audit rows, and hooks retain their hashes without copying memory responses back into memory. The project workspace has been exercised in Chrome against those actual records. Probabilistic project classification remains an investigated future integration. Recovery checkpoints contain ASIP activity history; they do not restore project files or the operating system. The old administration daemon is not a dependency of this implementation.

Windows and macOS installers currently lack publisher signatures and macOS notarization. Linux tray display depends on the desktop's status-indicator support. Antigravity uses the managed helper's absolute path; Beacon maintains that directory. The Windows installer and Intel Mac DMG have been updated in the existing VMs, retained Google sign-in and agent history, and opened their native panels and local browser workspaces. Apple Silicon has native CI coverage; its desktop experience and launch-at-login through a guest login cycle remain unqualified.

Linux packages include `.deb`, `.rpm`, and AppImage. Use the native package on systems that restrict portable applications' user namespaces; the package registers Chromium's sandbox support through the platform installer.

Electron provides the desktop shell. Its installer footprint is substantial. On the development Linux machine, Beacon 0.2.0 with its account window open used approximately 322 MiB of proportional memory across seven processes and 0.3% of one CPU core in a ten-second idle sample. This is one measurement, not qualification across all operating systems.

## Integration references

- [Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
- [Antigravity plugins](https://antigravity.google/docs/plugins) and [hooks](https://antigravity.google/docs/hooks)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
