# ASIP

ASIP keeps project history across Codex, Claude Code, and Antigravity.

This branch starts with an installable Beacon and native agent plugins. It replaces the earlier daemon-based prototype. It is an alpha, not a completed release.

[Download the alpha](https://github.com/M-o-liver/asip-linux/releases/tag/v0.3.1-alpha.2) · [Installation and test guide](ALPHA.md)

## Install and connect

1. Install **ASIP Beacon** for your operating system.
2. Open Beacon and sign in with Google or GitHub.
3. Save the plugin for your agent from Beacon, then install it through that agent's plugin manager.
4. Run the plugin's setup skill or ask your agent to connect ASIP. Click **Connect** in Beacon.

Recording starts after the plugin finishes connecting. Signing out or disconnecting a plugin stops its recording.

Codex also requires reviewing the ASIP hooks in `/hooks` before automatic recording starts. Its MCP memory tools can work before that review. This bundle uses Codex's native manifest because version 0.162.1 skips lifecycle hooks in portable Agent Plugins packages.

ASIP's Google desktop client and GitHub OAuth app are registered. Public client IDs live in `beacon/signin.json`. Google also requires its desktop client credential; use the registered client JSON as `ASIP_GOOGLE_DESKTOP_CLIENT_JSON` when running `node scripts/configure-signin.mjs` before packaging. The client JSON is excluded from Git. Google sign-in is disabled in builds missing it. Real Google sign-in, the installed Codex plugin's connection, and record/recall through Codex's MCP runtime have been verified. GitHub sign-in has fixture coverage but still needs a real login check.

## What is implemented

- A tray/menu-bar Beacon with an account window, plugin export, connection status, disconnect, and sign-out.
- A browser workspace with projects, a project map, sessions, intent/result filters, searchable history, API connections, and an evidence inspector. Map links represent actual sessions shared across projects.
- Starts at login by default using each platform's startup mechanism. You can turn this off in Beacon settings.
- A standalone compiled helper bundled with each plugin. Users do not install Python, Node, or Go.
- Native Codex and Claude Code plugin manifests, onboarding skills, MCP tools, and lifecycle hooks.
- An Antigravity plugin bundle using its own hook format and conversation metadata, installed and inspected through its native CLI on all three operating systems.
- Google authorization code sign-in with PKCE and verified identity tokens; GitHub device sign-in with a verified provider account.
- A connection handshake between the installed plugin and Beacon.
- Durable account-specific activity records: agent, native session, project, intent, tool input/result, failure, repository revision, worktree state, and trace reference.
- Project identity shared across SSH and HTTPS repository URLs, plus working-directory fallback.
- Search and manual intent/result/evidence records through the connected plugin.
- Activity-history recovery with up to ten saved checkpoints; restore saves current history before replacement.
- Named API connections for OpenAI, Anthropic, Gemini, GitHub, and custom HTTP APIs, with optional project assignments.
- GitHub repository authorization from Beacon; encrypted API credentials and request/result records linked to the calling agent's project and session.

## API connections

Open **API connections** in Beacon, choose a provider, and name the connection, for example `github.work`. GitHub offers browser authorization for public or private repositories. Other providers accept an API key or token. Assign the connection to recorded projects, or choose **All projects**.

Connected agents use `asip_connections` to find available connections and `asip_api_request` to call them. Requests use a path on the configured API, such as `/repos/M-o-liver/asip-linux/issues`. Responses include the HTTP status, JSON or text body, and an audit ID. Beacon records the connection, project, session, result, and provider request ID. Interrupted requests remain unresolved in the audit.

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

Launching ASIP or choosing **Open ASIP** opens the local project workspace in your browser. **Beacon settings** opens the small connection/settings window. Beacon starts in the background at login by default; an explicit opt-out is retained. An expired browser connection offers **Open ASIP** instead of displaying an empty project map.

If you used the earlier ASIP workspace, choose **Import previous history** in Beacon settings and select its `memory.sqlite3` file. The import restores the project catalogue, directories, relationships, events, session metadata, and intent outcomes into the signed-in account. It preserves the original database and saves the current history as a recovery record before importing. Repeating an import does not duplicate records. Projects with no activity remain visible in the map.

`npm start` runs Beacon from source after `npm run build:helper`. Use `--user-data-dir=/absolute/path` when exercising a separate development profile.

The CI workflow runs connection and OAuth fixture tests, installs the Codex and Claude plugins into disposable runner profiles, and builds native installers on Windows, Linux, and both Apple Silicon and Intel Macs. These checks do not verify a real provider login.

## Current limits

An actual Codex CLI session has automatically recorded prompts, tool calls/results, repository revision, worktree state, and its final result through the installed plugin. Session-end hooks have also been exercised. An actual Antigravity CLI session recorded tool events, repository identity and revision, and Stop events under its native conversation; its explicit result is present too. That session worked around missing native MCP tools using the local API, so Antigravity's normal MCP recall/record flow still needs qualification. Claude complete-turn capture still needs interactive qualification. Codex surfaces that do not run local plugin hooks need separate qualification; native MCP startup does not establish automatic capture on every surface.

GitHub repository authorization and a real API call through Codex's installed plugin have passed, including the stored request/result audit. Recall excludes ASIP's own tool-call audit rows, and hooks retain their hashes without copying memory responses back into memory. The project workspace has been exercised in Chrome against those actual records. Probabilistic project classification remains an investigated future integration. Recovery checkpoints contain ASIP activity history; they do not restore project files or the operating system. The old administration daemon is not a dependency of this implementation.

Windows and macOS installers currently lack publisher signatures and macOS notarization. Linux tray display depends on the desktop's status-indicator support. Antigravity bundles use the exported helper's absolute path; keep the exported directory in place.

Linux packages include `.deb`, `.rpm`, and AppImage. Use the native package on systems that restrict portable applications' user namespaces; the package registers Chromium's sandbox support through the platform installer.

Electron provides the desktop shell. Its installer footprint is substantial. On the development Linux machine, Beacon 0.2.0 with its account window open used approximately 322 MiB of proportional memory across seven processes and 0.3% of one CPU core in a ten-second idle sample. This is one measurement, not qualification across all operating systems.

## Integration references

- [Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
- [Antigravity plugins](https://antigravity.google/docs/plugins) and [hooks](https://antigravity.google/docs/hooks)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
