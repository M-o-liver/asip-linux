# ASIP alpha test

Download Beacon from the [alpha release](https://github.com/M-o-liver/asip-linux/releases/tag/v0.3.0-alpha.1). Windows users should choose **ASIP.Beacon.Setup.0.3.0.exe**. The ZIP is also available. These installers do not yet have publisher signatures.

## Windows with Claude Code

1. Install and open Beacon. Sign in with Google or GitHub. Use your own account; no access to the developer's computer is needed.
2. Choose **Claude Code** in Beacon and save its plugin folder somewhere permanent, such as `C:\Users\YourName\ASIP\claude-code`.
3. Copy the installation commands shown by Beacon into PowerShell. They use Claude Code's plugin manager. Claude Code must already be installed.
4. Start a new Claude Code session in a Git repository. Ask it to connect ASIP, then click **Connect** in Beacon.
5. Ask: “Use ASIP to recall this project, inspect git status, and record the result.” Close that session when it finishes.
6. Click ASIP in the tray. Open the project and check that its intention, tool activity, result, and session belong to the correct repository. Select a record to inspect its evidence.
7. Restart Beacon, open a new Claude Code session, and ask it to recall the result. The earlier work should still be available.

For an API check, add `github.work` under **API connections**, choose GitHub, and authorize repository access. Ask the connected agent to use that connection to read a repository's GitHub metadata. Check the HTTP result and request evidence in ASIP.

Record the Windows version, Beacon version, agent version, the step that failed, and the error text. Do not include credentials. Screenshots of the affected view help.

## Codex and Antigravity

The same Beacon exports their plugins and shows their native installation commands. Connect each plugin from a fresh agent session. Codex also requires reviewing ASIP's hooks in `/hooks`. Keep the exported Antigravity folder in place because its commands refer to that location.

## What has been verified

- A real Google sign-in and installed Codex plugin connection.
- Automatic capture of a real Codex CLI session: prompts, tool calls and results, Git revision, worktree state, final result, and session end.
- GitHub repository authorization and a real API request through the installed Codex plugin.
- The browser workspace against those records.
- Automated tests, native plugin installation, Codex/Claude MCP startup, packaging, and packaged application startup on Windows, macOS, and Linux. The release links to those build checks.

Claude Code and Antigravity still need a complete interactive session check. Installing a plugin or starting its MCP server does not establish that its hooks capture a complete session. The Windows installer also needs this first human installation and sign-in check.

Activity stays on the computer where Beacon runs. Account linking and cross-device history synchronization are not implemented. Recovery keeps up to ten ASIP history checkpoints; it does not back up repository files.
