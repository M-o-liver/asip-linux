# ASIP

ASIP keeps project history across Codex, Claude Code, and Antigravity.

This branch starts with an installable Beacon and native agent plugins. It replaces the earlier daemon-based prototype. It is a development preview, not a completed release.

## Install and connect

1. Install **ASIP Beacon** for your operating system.
2. Open Beacon and sign in with Google or GitHub.
3. Save the plugin for your agent from Beacon, then install it through that agent's plugin manager.
4. Run the plugin's setup skill or ask your agent to connect ASIP. Click **Connect** in Beacon.

Recording starts after the plugin finishes connecting. Signing out or disconnecting a plugin stops its recording.

ASIP's Google desktop client and GitHub OAuth app are registered. Public client IDs live in `beacon/signin.json`. Google also requires its desktop client credential; use the registered client JSON as `ASIP_GOOGLE_DESKTOP_CLIENT_JSON` when running `node scripts/configure-signin.mjs` before packaging. The client JSON is excluded from Git. Google sign-in is disabled in builds missing it. Real Google sign-in, the installed Codex plugin's connection, and record/recall through Codex's MCP runtime have been verified. GitHub sign-in has fixture coverage but still needs a real login check.

## What is implemented

- A tray/menu-bar Beacon with an account window, plugin export, connection status, disconnect, and sign-out.
- A standalone compiled helper bundled with each plugin. Users do not install Python, Node, or Go.
- Native Codex and Claude Code plugin manifests, onboarding skills, MCP tools, and lifecycle hooks.
- An Antigravity plugin bundle using its own hook format and conversation metadata. Native installation remains unqualified.
- Google authorization code sign-in with PKCE and verified identity tokens; GitHub device sign-in with a verified provider account.
- A connection handshake between the installed plugin and Beacon.
- Durable account-specific activity records: agent, native session, project, intent, tool input/result, failure, repository revision, worktree state, and trace reference.
- Project identity shared across SSH and HTTPS repository URLs, plus working-directory fallback.
- Search and manual intent/result/evidence records through the connected plugin.

The account is identified by the Google or GitHub provider's stable subject. Account linking, hosted account management, and cross-device synchronization are not implemented.

## Build

Node 24 and Go 1.26 are development requirements. Each operating system builds its own Beacon installer.

```sh
npm ci
npm test
npm run package
```

`npm run build:all-helpers` also compiles helpers for Windows, Linux, and macOS on x64 and arm64. Installer builds include only their own platform's helper and plugins.

`npm start` runs Beacon from source after `npm run build:helper`. Use `--user-data-dir=/absolute/path` when exercising a separate development profile.

The CI workflow runs connection and OAuth fixture tests, installs the Codex and Claude plugins into disposable runner profiles, and builds native installers on Windows, macOS, and Linux. These checks do not verify a real provider login.

## Current limits

The next milestone is automatic capture of a normal agent turn through an installed plugin. Manual record/recall through the installed Codex plugin has passed with a real account. The project workspace, named API connections, recovery records, and probabilistic project classification remain pending. The old administration daemon is not a dependency of this implementation.

Windows and macOS installers currently lack publisher signatures and macOS notarization. Linux tray display depends on the desktop's status-indicator support. Antigravity bundles use the exported helper's absolute path; keep the exported directory in place.

Linux packages include `.deb`, `.rpm`, and AppImage. Use the native package on systems that restrict portable applications' user namespaces; the package registers Chromium's sandbox support through the platform installer.

Electron provides the desktop shell. Its installer footprint is substantial; this preview has not yet been qualified for memory use or idle CPU cost.

## Integration references

- [Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
- [Antigravity plugins](https://antigravity.google/docs/plugins) and [hooks](https://antigravity.google/docs/hooks)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
