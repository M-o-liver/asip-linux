# Install and verify ASIP

Choose an installer from [Downloads](https://asip.ca/download): Windows Setup
EXE, Apple Silicon arm64 DMG, Intel Mac x64 DMG, or Linux AppImage/DEB/RPM.
The installer identifies its version; source development uses the version in
[package.json](package.json). Published build observations and signing limits
are recorded in [qualification history](QUALIFICATION.md).

## Connect an agent

Install Beacon, sign in with Google or GitHub, and open **Agents**.

| Agent                   | Installation                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT desktop         | Choose **Open in ChatGPT**, install ASIP on its native plugin page, then open **ASIP → Hooks → Review** and enable the hooks.     |
| Codex CLI               | Choose **Install**, review ASIP in **/hooks**, then open a new session.                                                           |
| Claude desktop / Cowork | Choose **Get plugin ZIP**, then upload that ZIP through **Customize → Plugins → Upload a plugin**.                                |
| Claude Code CLI         | Add the managed `asip-claude-code` folder through Claude Code's native plugin manager. Beacon reveals its ZIP beside that folder. |
| Antigravity             | Choose **Install**, restart Antigravity, then open a new conversation. If the CLI is unavailable, use the managed plugin folder.  |

Beacon owns the managed bundles and ZIPs in its application-data folder.
**Show ZIP** and **Copy path** identify the Claude upload archive. Keep it zipped;
re-upload it after a Beacon update to update the installed copy. Other providers
use their native folder or marketplace flow. The setup UI and available actions
are implemented in [window.js](beacon/window.js) and
[agent-plugins.mjs](beacon/agent-plugins.mjs).

Claude's local MCP connector is used through Cowork or Claude Code. Uploading a
plugin alone establishes neither its connection nor automatic recording; check
support and account requirements in the agent application.

When the plugin starts, Beacon opens the connection request. Click **Connect**
if already signed in. Start a fresh agent conversation after installation or an
update so it loads the current tools. Review required hooks in the agent's
native interface.

## Verify recording and recall

In an empty test folder or small repository, ask the agent:

> Create hello-asip.txt containing "ASIP is connected". Read it back and report whether it matches.

Approve the agent's normal tool prompts. Choose **Open ASIP** in Beacon and check
the project, native session, tool activity, and final response. A successful MCP
connection alone establishes access to tools; inspect actual records to verify
hook capture on that agent surface.

Open another conversation in the same project and ask:

> Use ASIP to recall the work in this project. What happened with hello-asip.txt?

Check the recalled record against the saved work. Restart Beacon and verify the
history remains. Explicit intent/result/evidence records can supplement the
native hooks.

## Connect another computer

Local recording works without cloud. Choose **Connect cloud** in Beacon, sign
into the hosted account in the browser, and approve the computer. Repeat on the
other computer with the same hosted account. Local Google/GitHub sign-in and
hosted account approval are separate steps.

Check a newly recorded item on the other computer. Records, captured evidence,
session/project metadata, relationships, and named API metadata synchronize.
Provider credentials remain on their owning computer. Full transcript files,
repository working trees, and arbitrary referenced attachments are outside the
sync protocol; excerpts already captured in records travel with those records.

The [cloud guide](cloud/README.md) owns synchronization and admission behavior;
[accounts and billing](cloud/SAAS.md) describes hosted access. **Reconnect cloud**
renews expired authorization. Quota pauses and network failures preserve local
recording and show their status in Beacon.

## API connections and recovery

In **API connections**, add a named provider connection and assign its projects.
Use **Check** where supported. Ask the connected agent to list available
connections and make a read-only request by name. Inspect its HTTP result and
recorded audit. Credentials are entered in Beacon.

In **Recovery**, save or restore an activity-history checkpoint. Beacon retains
up to ten checkpoints and verifies the selected history before restoration.
Cloud history is retained. See [architecture](ARCHITECTURE.md) for API limits and
recovery boundaries.

## Update Beacon

In **Settings → Beacon updates**, check for a newer release, download it, then
open the verified installer. Complete your platform's installation flow. On Mac,
replace Beacon in Applications; for a Linux AppImage, replace the existing file.
Plugin uploads and native-manager updates remain separate.

## Diagnose a missing record

1. Confirm Beacon is signed in and the agent is connected.
2. Confirm the plugin is installed in the agent surface being used.
3. Review and enable required native hooks, then start a new conversation.
4. Check Beacon’s recent work first; then check cloud connection, pending records,
   and any authorization, entitlement, network, or quota message.
5. Compare the installed version and agent surface with the dated qualification
   observations before assuming the same capture coverage.

[Report a problem](https://github.com/M-o-liver/asip-linux/issues/new?template=alpha-feedback.yml)
with your OS, agent, installed Beacon version, attempted action, expected result,
and error message. Include a session/record ID when useful. Review screenshots
for credentials and private project content before sharing them publicly.
