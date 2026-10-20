# ASIP alpha test

Download an installer from [Releases](https://github.com/M-o-liver/asip-linux/releases). Choose the Windows Setup EXE, the arm64 DMG for Apple Silicon, the x64 DMG for Intel Mac, or the Linux AppImage/DEB/RPM. The application version is 0.4.1. Installers are unsigned; macOS builds are not notarized.

## Connect an agent

Install Beacon and sign in with Google or GitHub. Open **Agents** in Beacon, then use the matching flow:

| Agent           | Installation                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT desktop | Click **Open in ChatGPT**, then install ASIP on the native plugin page. Open **ASIP → Hooks → Review** and enable its hooks.                                  |
| Codex CLI       | Click **Install**. Review ASIP in the CLI's **/hooks**, then start a new session.                                                                             |
| Claude Code     | Click **Install**. If the CLI is unavailable to Beacon, choose **Use plugin folder** and add that managed folder through Claude Code's native plugin manager. |
| Antigravity     | Click **Install**, restart Antigravity, then open a new conversation.                                                                                         |

Beacon stores all three managed bundles in its application-data folder. The folder button opens the appropriate bundle when a native manager needs its path. ASIP does not ask you to choose an export directory.

When the plugin starts, Beacon presents its connection request. Click **Connect** if already signed in. Start a fresh conversation after installing or updating a plugin; an existing conversation may retain its previous tool list.

## Check the complete workflow

Use an empty test folder or a small repository. Ask your agent:

> Use ASIP to recall this project. Record what you intend to do, create a small test file, read it back, and record the result with evidence.

Approve the agent's normal tool prompts. Open **ASIP** from Beacon and check the project, session, result, and evidence. Start a different conversation in the same project and ask what ASIP remembers. Restart Beacon and check that the history remains.

For APIs, open **API connections**, add a named connection, select the projects that may use it, and use **Check** where available. Ask your connected agent to list the project's connections and make a read-only request by name. HTTP failures should remain visible in the connection and activity records.

The [qualification report](QUALIFICATION.md) identifies which workflows were observed in the desktop applications and which have automated coverage only. A working MCP connection does not by itself verify automatic hook capture. ChatGPT desktop and Codex CLI require native hook review. After enabling hooks, start a fresh chat and check that its tool activity appears in ASIP.

Activity is stored on the computer running Beacon. Account linking and cross-device history synchronization are not implemented. Recovery retains up to ten ASIP history checkpoints; it does not back up repository files.

## Send feedback

[Report a problem](https://github.com/M-o-liver/asip-linux/issues/new?template=alpha-feedback.yml), or send the same details to the person who shared ASIP with you:

- Your operating system, agent, and the ASIP version shown in **Settings**.
- What you tried, what you expected, and what happened.
- Any error message and a screenshot of the affected screen.
- Whether restarting Beacon or starting a fresh agent conversation changed the result.

Before posting a screenshot publicly, check it for credentials or private project content. Include a session or record ID when relevant; the full conversation is usually unnecessary.
