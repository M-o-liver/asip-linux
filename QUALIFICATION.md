# ASIP 0.4.1 qualification

This page separates native build checks from observed desktop behavior. Installation, MCP startup, and a complete agent session are different checks.

## Automatic Antigravity summaries — October 21

Source `21d4f9c` passed all four native jobs in [build 39525991704](https://github.com/M-o-liver/asip-linux/actions/runs/39525991704). The installed Linux AppImage, Windows EXE, and Intel Mac DMG came from that run's clean merge tree `9e090e4513d44e10f52c3fceef6d3b23adae74b4` (build revision `539d89ee`). This tree matches the source branch exactly.

The helper now reads the completed response at Antigravity's idle Stop from the conversation-specific native JSONL transcript. It records the response and source path, row SHA-256, step index, and native timestamp. Regression checks cover both native transcript filenames, Unicode, bounded reads, later user messages, incomplete responses, tool calls, errors, partial records, direct-message priority, and appearance in recent work. Unknown or unavailable transcripts retain the existing Stop metadata. Existing history is not rewritten.

All three actual agent tests used the ordinary prompt **Reply exactly: Automatic turn summary verified.** without requesting any ASIP tool or record. Linux additionally specified no tools. Each native app returned that text; Beacon recorded it automatically.

| Environment                    | Observed result                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux, Antigravity CLI 1.4.2   | Same conversation before and after upgrading Beacon: the earlier response produced generic Stop metadata; the new response produced the exact final text and source evidence. Recomputed the native row hash and matched it to the stored hash. Codex retrieved the new automatic record through `asip_recall`.                                                 |
| Windows, Antigravity desktop   | Updated Beacon while Antigravity and ChatGPT remained open. Sign-in, both agents, one project, and six sessions remained. The response appeared in Beacon's recent work and Edge's project activity. The evidence inspector showed its native transcript path, row hash, step 17, and timestamp. Total activity reached 89 records.                             |
| Intel Mac, Antigravity desktop | Updated through DMG → Applications while both agents remained open. Sign-in, both agents, all 62 prior events, and three sessions remained. The response appeared in the menu-bar panel's recent work and Safari's correct project/session. Its evidence showed transcript source, hash, step 11, timestamp, and final text; total activity reached 63 records. |

Linux automatic record: `34558e14-b60b-4b24-8715-521bc46d175b`; native session `5d49d953-c68a-4c4d-adc3-c23956e7385f`. Source row SHA-256: `66b61c466d58c7b9f71340558f9ae9ffb94857acc0be0a49f69925b0010ea9f1`.

Windows automatic record: `3a6feb8b-4069-43ea-9f12-0d5828aa4dd1`; native session `520c4ef0-fbb5-4d25-b0ae-8d8e4e92086a`.

Mac automatic record: `20c89226-53c8-42f4-ab38-d1264098820e`; native session `61778954-87a7-467e-9b2e-61f5adf13aa8`.

The Linux installed upgrade also retained encrypted credential files byte-for-byte and passed SQLite integrity checking with 9,986 events at upgrade. The application suite passed 54 cases with two Windows-only skips locally; Windows runs those platform checks in native CI. Go race tests passed. This follow-up changes automatic Antigravity capture, not account linking or history synchronization.

## Native builds

[Release build 39518756248](https://github.com/M-o-liver/asip-linux/actions/runs/39518756248) passed for source `0706e85` (`v0.4.1-alpha.2`) on Windows, Linux, Apple Silicon macOS, and Intel macOS. Each job runs the application tests, Go race checks, native plugin-manager installation, Codex/Claude MCP connection, installer packaging, and packaged application startup.

The local application suite has 56 cases: 54 passed and two Windows-specific skips. Windows CI also runs the upgrade regression with a real executable image mapped and the native plugin directory held as a process working directory. Native qualification uses Codex 0.162.1, Claude Code 2.1.299, and the pinned Antigravity CLI releases and hashes in `scripts/antigravity-releases.json`. It uses disposable identities and profiles; no model subscription or live provider login is implied by a CI pass.

The regression checks cover:

- An approval completed after the discovering MCP process has exited, subsequent retrieval of the saved connection, and duplicate discovery prompts.
- Disconnect cancelling unfinished approval requests.
- A secondary packaged launch forwarding its import action without deleting saved sign-in.
- Credential imports, duplicate-name refusal, encrypted round-trip verification, provider authentication formats, and retained HTTP outcomes.
- Empty FIFO timeouts followed by a successful import.
- Older-session pagination, project scoping, history import, and the ten-checkpoint recovery limit.
- Windows path aliases across agents, migration of existing project history/catalogue/relationships, workspace filters, and retained API project grants.
- ChatGPT local-marketplace URLs containing paths with spaces and punctuation.
- Replacing Windows plugin bundles while an executable is still running and the native directory is a process working directory, repeated upgrades with the old image retained, recovery of earlier `.previous` leftovers, and cleanup after process exit.

The Linux AppImage built from `000a57c` also passed the packaged secondary-launch check locally. Its test selects the application version explicitly; earlier artifacts in the same build directory are excluded.

## Desktop observations

The VMs initially received source `2a50c4a` from [build 39035520339](https://github.com/M-o-liver/asip-linux/actions/runs/39035520339). Both VMs were subsequently updated to `66fc80d`, `000a57c`, and `218fcf7`. Their sign-in, connected agent identities, and saved records survived the installer updates. The final Windows-path correction is source `218fcf7`; the installed EXE and Intel DMG came from [build 39428897890](https://github.com/M-o-liver/asip-linux/actions/runs/39428897890).

| Experience                              | Linux                                  | Windows VM                                             | Intel Mac VM                                              |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Install/update retaining Google sign-in | Observed                               | Observed through NSIS                                  | Observed through DMG → Applications                       |
| Beacon window/panel                     | Full application                       | Tray panel and full taskbar window                     | Menu-bar panel                                            |
| Open local Projects workspace           | Observed                               | Observed in Edge                                       | Observed in Safari                                        |
| ChatGPT/Codex native record and recall  | Observed with existing integration     | Completed file verification and fresh-chat retrieval   | Completed cross-agent recall and file verification        |
| Packaged Open in ChatGPT button         | Native CLI installed                   | Opened installed ASIP plugin page                      | Opened installed ASIP plugin page                         |
| Antigravity native MCP workflow         | Completed native MCP file verification | Completed native intent, file verification, and result | Completed intent, file verification, result, and evidence |
| Claude complete interactive turn        | No paid authenticated account          | No paid authenticated account                          | No paid authenticated account                             |

### Windows ChatGPT

Installed ASIP through the native plugin page, connected it in Beacon, and ran `asip_status`, `asip_recall`, and `asip_record` from ChatGPT in an empty qualification folder. The agent created `win-codex.txt`, read back the expected text, and saved the result with the path, command exit code, read-back content, and SHA-256 hash. The workspace showed the correct local project and native Codex session. After the Beacon update, a fresh ChatGPT conversation retrieved that result and its evidence without reading the file.

Result record: `94487dbc-bf26-4516-bda7-23b7b3a85479`. Native session: `01a1509e-29a2-7e60-9849-82e7f3b45f76`.

The workspace initially contained the explicit result only because hooks had not been reviewed. ChatGPT desktop exposes hook review on **Plugins → ASIP → Hooks → Review**; `/hooks` is the CLI interface. Enabled the nine ASIP hooks through that native Windows panel and started a fresh conversation after the `218fcf7` Beacon update.

That conversation recalled Antigravity's saved text and SHA-256 without reading project files, then ran `Write-Output ASIP-hook-check` successfully. The workspace automatically gained 13 events, including the original prompt and final response, reaching 50 events across three sessions in one project. No explicit `asip_record` request was part of this test. Native session: `01a15a84-a7f8-7e42-8594-3a44b7085398`. Automatic final result: `34dd16d1-19ca-4ade-a19f-bf61219bc4bf`. The evidence inspector showed the normalized project identity and matching native session.

### Linux Antigravity

An interactive Antigravity 1.4.2 CLI session used native MCP discovery, recalled its project, saved an intent, created and read back `linux-agy.txt`, and saved the result. Codex then retrieved that result through its own ASIP integration. Native session: `4ccc60a8-cfdc-442f-bb95-2310cebe981b`. Result: `6ca8d83c-cee1-43d4-80f4-f89d08caf800`.

This run also exposed Antigravity's `call_mcp_tool` wrapper in automatic traces. The helper now classifies wrapped ASIP calls correctly, and recall and workspace queries exclude previously stored wrappers from ordinary work views. The audit retains those events without recursively copying recalled memory into new records.

### Intel Mac ChatGPT

Beacon's **Open in ChatGPT** opened the native ASIP plugin page. The previous installation still referenced a 0.4.0 cache; reinstalling through ChatGPT's plugin manager refreshed the hook commands to the 0.4.1 cache. Enabled the nine ASIP hooks through the native **Hooks → Review** panel, then started a fresh Codex conversation in the existing qualification project.

ChatGPT recalled Antigravity's earlier result without reading `mac-agy.txt`, recorded an intent, created and read back `mac-codex.txt` containing `ASIP Mac ChatGPT verified`, and saved its result with read-back and SHA-256 evidence. Native Codex session: `01a15594-706c-7d91-aea0-20528dcb25a1`. Beacon's native menu showed 54 recorded events afterward, up from the 33 Antigravity records. Safari’s workspace showed one project with the Antigravity and Codex native sessions. It displayed the automatically captured original prompt, the separate explicit intent, and the final assistant result. Automatic result record: `4b2c9923-2c54-4b41-90ff-136eeff33f32`.

### Windows Antigravity discovery and hook corrections

The first desktop attempt exposed a gap in native installation checks: the global ASIP junction existed, but Antigravity's Installed tab showed zero plugins. Replacing it with a real directory made ASIP appear immediately. The installer now creates and refreshes an owned real directory on Windows, migrates earlier junctions, and refuses unrelated folders. Native CI now checks the directory entry type.

After restarting, Antigravity requested its Beacon connection and connected successfully. Its first tool call then exposed quoted-executable corruption in the Windows hook launcher. Windows hooks now invoke a quote-free PowerShell command with the actual helper invocation encoded as UTF-16; JSON input is explicitly forwarded as UTF-8. Native Windows tests execute the generated command against the connected helper, preserve Unicode payloads and paths with spaces/apostrophes, and verify that activity reaches Beacon. The updated installer completed a native desktop turn: ASIP status and project discovery, recall, explicit intent, creation/read-back of `win-agy.txt`, SHA-256 verification, and a saved result containing that evidence. Native session: `d480c109-d276-4d10-ae2c-d76519399fb5`. Result: `1069f266-25bb-42f7-befa-034ee335005d`.

That turn also exposed a project-identity defect: Antigravity supplied `c:/Users/...` while the earlier Codex record used `C:\Users\...`. Exact-string lookup missed the earlier work until the agent discovered the catalogue identity. Windows directory identities now normalize case and separators at recording, recall, workspace filtering, historical import, and API-grant comparison. An account migration reconciles earlier variants while preserving event IDs, raw evidence, catalogue notes, roots, and links. Tests cover migration, both agents sharing a project, and retained encrypted credentials. Installing the `218fcf7` NSIS update merged the two displayed projects into one and retained all 37 events, both sessions, and both connected agents. Edge showed the Antigravity and Codex sessions together under the same project.

### Windows upgrades with an active agent

Final tray inspection exposed an upgrade cleanup error: Windows refused deletion of `asip-antigravity.previous` while an agent still had its executable image mapped. The new managed bundle was already in place and recording continued, but preparation stopped before refreshing the native registration and Beacon showed **Needs attention**. Replaced bundles now retire under unique names; Windows file-lock errors defer their deletion until a later launch. Preparation also retries the fixed-name leftovers from older builds. The native Windows regression holds a real executable open through repeated replacements, checks the native registration, then verifies cleanup after exit.

The next installed build exposed a second independent Windows lock: Antigravity held its native plugin directory open, preventing the directory itself from being renamed. Updates now refresh ASIP-owned native directories in place using atomic file replacements, preserve the directory identity, and keep the executable in the separate managed bundle. The native Windows regression holds both locks during repeated upgrades.

The installed `efbd4b7` build then exposed temporary-plugin discovery: Antigravity watched `.asip-stage-*` inside its plugin root and Windows returned `ENOTEMPTY` during cleanup. Source `1767ef0` stages outside that discovery directory on the same volume, retries transient removal errors, and defers locked leftovers. The local regression verifies that a cleanup failure cannot abort refreshed registration and that a subsequent preparation removes the leftovers. The installed update retained Google sign-in, two agents, and all 70 Windows records before this final cleanup correction.

After fully restarting Antigravity against the refreshed `efbd4b7` native registration, a fresh conversation recalled ChatGPT's saved `ASIP-hook-check` result, including the verified text, SHA-256, and successful command output, without reading project files. This exercised the managed helper after removal of the redundant native executable copy.

Installing the corrected `1767ef0` NSIS build with both agents still open completed without a plugin setup error. Google sign-in and both connections remained. Edge showed one project, six sessions, and all 86 events, including 16 automatically captured events from the fresh Antigravity recall. This installed build has the same application/helper/test source as the tagged release; only documentation changed before the tag.

The Windows workspace's **Open Beacon** opens a normal taskbar window. Tray clicks retain the compact panel. Windows may keep the browser in the foreground; selecting Beacon on the taskbar brings up the full window.

### Intel Mac Antigravity

Beacon registered the managed plugin without requiring a CLI. Antigravity showed ASIP in Customizations with its skills, MCP server, and hooks. A new conversation in the already running app did not expose the MCP tools. Fully restarting Antigravity did: Beacon presented its connection request and the next conversation used the native `asip_asip` server. Setup text now tells users to restart the app.

The native run recalled its project, saved an intent, created and read back `mac-agy.txt`, then saved a result and evidence. Safari's Projects workspace showed one correctly attributed project, its native session, and 33 records, including an automatic Stop event with working directory, model, transcript path, and project-association evidence.

Native session: `cdb83669-f436-438d-a19d-00229940af99`. Result: `350d137f-9943-4a46-9ce9-a1329e4260e4`. Evidence: `4e415aa8-39d2-4d1f-a906-51d51e7c3f9e`.

The Mac is an experimental Intel Sequoia 15.8.1 guest on an AMD host, without accelerated graphics. It cannot qualify an Apple Silicon desktop experience. The Apple Silicon installer has native CI checks only. The updated installer placed the menu-bar panel correctly on first launch and retained both connected agents and all 33 records. Its **Open in ChatGPT** button opened the native installed ASIP plugin page.

After the `000a57c` Mac update, Beacon retained both agents and all 54 events. Safari showed one project and both native sessions. A restarted Antigravity conversation retrieved ChatGPT’s saved file verification, read-back text, exit code, and SHA-256 evidence through native ASIP MCP. The client wrote the long MCP response to its own output artifact; the agent summarized that artifact after clarification without reading project files.

The subsequent `218fcf7`, `c272e00`, and `efbd4b7` DMG updates retained Google sign-in, both agents, and all 62 events. **Open ASIP** opened Safari with one project and three sessions. The workspace's **Open Beacon** control returned to the native menu-bar panel.

## Published alpha

[ASIP 0.4.1 alpha 2](https://github.com/M-o-liver/asip-linux/releases/tag/v0.4.1-alpha.2) contains nine installers, four native qualification records, and `SHA256SUMS`. All 13 asset digests matched the checksum manifest; each qualification record names the exact clean tagged revision and tree. The Windows EXE returned HTTP 200 without authentication after publication. Both earlier implementation PRs are merged.

## Existing records and API connections

The October 20 Linux upgrade to the `000a57c` AppImage passed the packaged secondary-launch check, preserved the encrypted credential file byte-for-byte, and passed SQLite integrity checking. The running native Codex plugin listed all 14 connections afterward. The subsequent clean `2341594` and `d8840b8` AppImages restored the saved sign-in and retained the encrypted credential files unchanged. The final integrity check returned `ok` with 9,096 recorded events; activity continues to grow during this work.

The final Linux update installed the published, checksum-verified `0706e85` AppImage. Saved sign-in resumed, encrypted credential files remained byte-for-byte unchanged, and SQLite integrity checking returned `ok` with 9,760 events. Native Codex tools then listed all 14 connections and 25 projects, including the 24 historical projects and the new Linux qualification project.

The earlier Linux upgrade retained 14 named connections, including 13 migrated credentials and signing secrets, and 24 projects. The workspace displayed the full total of 505 sessions and navigated to older sessions. The final archived administration journal contains 3,895 operations; reconciliation added three missing operations, updated the final entry, and corrected 810 lifecycle/verification classifications using the archive's actual action and result fields. Original archives remain unchanged. A checkpoint preceded each reconciliation; five recovery records remained afterward.

Real read-only calls through the installed Codex plugin returned:

| Connection                | Result   |
| ------------------------- | -------- |
| Gemini models             | HTTP 200 |
| Stripe test account       | HTTP 200 |
| Stripe live account       | HTTP 200 |
| Existing Cloudflare token | HTTP 401 |
| Existing `github.work`    | HTTP 401 |

The rejected credentials need replacement or renewed authorization. Their names and stored values were retained; a successful import is not a claim that a provider still accepts a credential. Other provider presets have fixture coverage unless a real check is explicitly recorded above.

## Qualification limits

- Earlier Antigravity turn-ending entries retain “Stop”. New completed turns capture the native final response when its supported transcript is available; missing or unsupported transcripts retain metadata only.
- Verify launch-at-login across an actual guest login cycle.
- Complete a Claude turn when an authenticated paid account is available.
- Verify real GitHub identity sign-in in an isolated account/profile. Google sign-in and GitHub API authorization have been exercised; these are separate flows.

Installers remain unsigned and macOS builds are not notarized. Cross-device history synchronization, account linking, streaming API responses, file uploads, and raw signing-secret injection are not implemented. Recovery restores ASIP activity history, not repository files or operating-system state.
