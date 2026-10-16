# ASIP alpha test

Download Beacon from the [0.4 alpha release](https://github.com/M-o-liver/asip-linux/releases/tag/v0.4.0-alpha.1). Windows users should choose **ASIP.Beacon.Setup.0.4.0.exe**. Mac users should choose the **arm64** DMG for Apple Silicon or the **x64** DMG for Intel. These installers do not yet have publisher signatures.

## Windows with Claude Code

1. Install and open Beacon. Sign in with Google or GitHub. Use your own account; no access to the developer's computer is needed.
2. Open **Agents** in Beacon and click **Install** for **Claude Code**. If its installer is not detected, use **Show plugin folder** to add the managed folder through Claude Code’s plugin manager.
3. Start a new Claude Code session. ASIP’s sign-in window should open automatically. Choose Google or GitHub, or click **Connect** if Beacon is already signed in.
4. Ask Claude Code to recall ASIP work, inspect a small test repository, and record its result. Check that the project, session, and evidence appear in ASIP.

The same flow applies to Codex and Antigravity. Codex additionally requires reviewing ASIP in **/hooks**. Beacon keeps all plugin sources in its application-data folder; users do not choose an export location.

## What has been verified

- A real Google sign-in and installed Codex plugin connection.
- Automatic capture of a real Codex CLI session: prompts, tool calls and results, Git revision, worktree state, final result, and session end.
- GitHub repository authorization and a real API request through the installed Codex plugin.
- The browser workspace against those records.
- Automated tests, native plugin installation, Codex/Claude MCP startup, packaging, and packaged application startup on Windows, macOS, and Linux. The release links to those build checks.

Claude Code still needs a complete interactive session check. A real Antigravity session recorded tool events, Git evidence, Stop events, and an explicit result, but the agent used the local API to work around missing native MCP tools. Its normal MCP workflow still needs verification. Installing a plugin or starting its MCP server does not establish that its hooks capture a complete session. The new native panels and complete Claude/Antigravity workflows still need interactive checks in addition to CI.

Activity stays on the computer where Beacon runs. Account linking and cross-device history synchronization are not implemented. Recovery keeps up to ten ASIP history checkpoints; it does not back up repository files.
