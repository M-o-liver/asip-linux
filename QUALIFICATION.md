# ASIP 0.5.0 qualification

This report records deployed behavior, installed-device observations, and automated checks separately. Earlier Beacon and native plugin evidence is preserved in [the 0.4.1 report](docs/qualification-v0.4.1.md).

## Private cloud rollout — October 21, 2026

The actual site runs at **https://asip.ca**, with a permanent landing page, download destination, API guide, and private account workspace. Cloudflare Worker `asip-cloud` serves the custom domain; workers.dev and version preview URLs are disabled. The original publication Worker remains available for recovery. D1 `asip-cloud` indexes account-owned records and metadata. R2 `asip-cloud-records` stores canonical source records and derived activity indexes privately, with its public bucket domain disabled. All four database migrations are applied remotely.

Cloudflare Access admission is an administrator-managed email allowlist, initially containing two owner-approved addresses with 24-hour sessions. An anonymous request redirects to Access. The browser one-time PIN flow created a durable ASIP account and opened its hosted workspace. Google and GitHub local Beacon sign-in remain separate from this cloud approval; the web OAuth implementations require their own registrations before they can be enabled and live-qualified.

The release download deployment used Worker version `552bce3a-a96c-4259-a0ba-b24a5f4c41e1`, from website/service source `b4d7051`, serving the published `v0.5.0-alpha.1` downloads. The sign-in isolation qualification initially used Worker `94bb5f33-659a-4274-b109-368a84c702fd`, source `0a6abbf`. The installed pre-release Linux candidate was `5d3dda1`, tree `23e28330dedda65c07b5dc4bc566c0c679149610`; the initial Windows and Intel Mac update candidates were `0cd7c7a`, tree `5676e6ad1e7416bcf071433cb33c7015c7856d9f`. Both the quota-corrected [39689459638](https://github.com/M-o-liver/asip-linux/actions/runs/39689459638) and later [39692926209](https://github.com/M-o-liver/asip-linux/actions/runs/39692926209) native builds passed all four platforms. The final native receipt correction, source `4df4835`, passed all four platforms in [native build 39782528393](https://github.com/M-o-liver/asip-linux/actions/runs/39782528393), alongside the passing [cloud build 39782528308](https://github.com/M-o-liver/asip-linux/actions/runs/39782528308). A preceding Windows fixture cleanup failure was fixed by closing the restarted SQLite runtime before removing its temporary directory; all production assertions had already passed. Final published binaries and their installed upgrade checks are recorded below.

### Account sign-in isolation — October 22, 2026

Review found that a delegated preview assertion could also reach the original account sign-in endpoint. Before releasing cloud API access, the owner approved a distinct Access application for `asip.ca/auth/access`, with a path-scoped HttpOnly cookie and a separate audience. It shares the same reusable two-email, 24-hour policy as the domain preview application; Cloudflare readback confirms exactly two attached applications and no additional admission rules.

The Worker now rejects preview assertions at the owner sign-in endpoint, and fails closed if the sign-in audience is missing or reused. Signed-JWT regression checks cover preview versus sign-in audiences, stable subject preservation, expired tokens and organization-token rejection. The real browser signed in through the new path and returned to the existing `/users/bosslikedat` workspace containing its prior history. An anonymous request to that path redirects to the new sign-in audience. Existing Linux device synchronization continued through the domain preview gate.

### Automated qualification

The complete local suite passed **76 tests**, with **two Windows-only skips** and **zero failures**. Windows executes those checks in native CI. Tests run the actual Worker in Cloudflare's official emulator with D1 and R2, rather than mocking the storage protocol. Coverage includes:

- Access JWT signature, issuer, audience and expiry validation.
- A separate account sign-in audience: delegated preview assertions cannot create owner sessions; missing or reused audiences fail closed.
- Durable account isolation; project restrictions on HTTP and MCP history, sessions, projects and source reads.
- Strict bearer validation, read-only credentials, agent-bound writes and immediate revocation.
- Canonical source SHA-256, identical retries, conflicting-ID rejection and atomic D1 batches.
- Same-origin browser mutations; single-use PKCE device codes; encrypted, state-bound loopback handoff; credential persistence and restart.
- Two independent local stores, offline capture, resume, original session/project/evidence preservation, and Antigravity-to-Codex recall.
- Recorded-time history pagination during out-of-order backfill, bounded synchronization passes, metadata preservation and exclusion of provider secrets.
- Metered zero-write idle metadata, one-row changed-session updates, persistent native metadata acknowledgments, and quota-aware retry pauses across restart.
- Idempotent identical native tool-hook deliveries across approved plugin connections and restart, preserving distinct calls, agents, sessions, projects, evidence and explicit records.

All native jobs build installers and start the packaged app on Linux, Windows, Apple Silicon macOS and Intel macOS. They run the application tests, Go race checks, actual Codex and Claude plugin managers/MCP connection checks, and pinned Antigravity CLI qualification. Native CI does not imply a paid model turn or interactive provider sign-in.

### Actual cloud HTTP and MCP access

The owner approved a temporary read-only **ASIP cloud qualification** connection restricted to the ASIP project. The workspace's **Check connection** action exercised its actual bearer HTTP access, project allowlist, denied access to an unassigned project, event history, private R2 source download, MCP initialization, tool listing and recall. The check reported one accessible project, read-only access and a verified source hash.

Source record `2399eed9-d75d-4cf9-84f2-414e734c2425` had the same SHA-256 in native canonical SQLite data, D1 and returned R2 bytes: `5355c58fa3ca8bd4c8b0be9a536c5e2573f74c66f401dfdef8606730fa0afa02`. The connection was then revoked. Repeating the check returned the expired-or-revoked error. The token remained in the browser throughout; it was not copied into logs or the repository.

### Installed Linux

The real Linux installation was updated from alpha 3, connected through the approved browser device flow, and uploaded its existing history. The quota-corrected `0cd7c7a` update preserved **12,446 records before and after**. The final clean `5d3dda1` candidate preserved **12,863 records before and 12,865 after**, with two new hook records during activation, Google sign-in retained, and SQLite integrity `ok`. Its encrypted cloud connection reopened automatically. The preceding binary and a consistent SQLite backup were retained locally.

Installed quota-corrected AppImage SHA-256: `7045ae0fcd26e8fa6e4be69f5b2271d68f876016fbd54f12eb814e21473340e5`.

The original Chrome cross-site POST callback was blocked during real qualification. The implemented handoff instead encrypts the reply with ephemeral P-256 ECDH, HKDF-SHA-256 and AES-GCM, returns only ciphertext by normal loopback navigation, verifies state and PKCE, and redirects the browser back to the hosted workspace. Browser security settings were not changed.

### D1 quota incident and correction

The owner reported a D1 quota alert during the initial backfill. Inspection found **12,258 records**, **100,159,488 database bytes**, **118,192 daily row writes**, and **3,216,722 daily row reads**. Storage was below the free database size limit. The initial client unnecessarily replaced unchanged project/session/connection metadata every 30 seconds, while the request limiter wrote a D1 counter on every authenticated request. Those were implementation defects.

The correction persists per-entry metadata acknowledgments locally, sends only changed metadata, conditionally upserts on the server for compatibility with older clients, refreshes catalogue/account information at most every five minutes, and removes the event-table aggregation from device metadata reads. Workers rate-limit bindings replace the database counter. An unchanged emulator metadata pass writes zero D1 rows; changing one session writes one row. An idle native pass performs only the indexed cursor request. These checks also pass across restart.

Daily quota errors now return an explicit code and Retry-After. The installed app visibly retained local work and paused synchronization until `2026-10-22T00:01:00Z`; restarting did not clear the pause. Production browser reads remained available after deployment of the fix. The Cloudflare plan was not upgraded and no history was deleted.

At `2026-10-22T12:21Z`, live Cloudflare analytics reported **6,491 row writes** and **21,447 row reads** for the new UTC day; database size was **111,185,920 bytes**. The installed Linux app had resumed automatically, sent **937 records** since restart and synced at `12:21:19Z`, with no error or retry pause and eight recent records queued. After Windows and Mac pairing and initial history downloads, account-wide analytics at approximately `13:24Z` reported **14,975 row writes** and **1,705,769 row reads**, within the daily free allowances of 100,000 writes and 5 million reads. These are observed preview loads, not an unlimited-capacity claim.

### D1 read amplification correction — October 22, 2026

The owner reported that D1 was still rising quickly after publication. At approximately `19:19Z`, account analytics showed **4,486,106 daily row reads** and **20,356 row writes**. Database metadata reported **131,022,848 bytes**. Live query insights identified the inferred-relationship self-join at an average **308,426 rows read per call**. Session aggregation scanned roughly 15,641 rows per call, and the default Work view averaged 2,680 reads for a 30-record page. These repeated read costs were defects in the initial workspace implementation.

Source `63c45f3` replaced the three history aggregates with an account-owned R2 activity checkpoint. Every refresh checks the indexed account sequence and folds only new immutable D1 records into project/agent/session counts and time bounds. Conditional R2 writes protect concurrent updates. Account/project scopes are applied after authentication, including with an already populated checkpoint. Idle loads write neither D1 nor R2. Migration `0004_work_history.sql` adds a partial chronological index for Work records, leaving original records and evidence unchanged. Source `bf47679` also prevents overlapping Refresh requests. Existing Beacon installations require no update.

All **19 cloud integration tests** passed in the official emulator. The full local suite passed **80 tests with two Windows-only skips and zero failures**. A 15,000-record fixture compared counts and relationships with the original SQL and metered:

| Operation | D1 rows read |
| --- | ---: |
| One-time account checkpoint | 30,001 |
| Twenty warm aggregate loads | 20 total |
| Include one newly appended record | 3 |
| A 30-record Work page | 31 |

Aggregate operations wrote zero D1 rows. Tests cover duplicate uploads, backfilled original times, account/project isolation, cold reads, concurrent checkpoint conflicts, corrupt checkpoints, R2 failures and bounded relationship expansion. They do not substitute zero-cost mocks for the emulator's row counters.

The additive migration was applied to production. Initial Worker `466d8802-2b7e-4c9a-b4d4-c25c75f8751b` used clean source `63c45f3`; the refresh guard deployment `21672cf4-cec2-4536-ad10-54ecd8a25f49` used source `bf47679`. Five completed refreshes of the real signed-in workspace showed **28 projects, 15,225 project records, 100 sessions, 77 relationships and 30 visible history rows**, with no error. Production query insights subsequently confirmed **16 sequence checks reading 16 rows**, and **14 Work page requests reading 434 rows total (31 each)**. The observed incremental aggregation queries read 28 rows total across two requests. Daily analytics at approximately `19:37Z` reported **4,537,144 reads and 22,741 writes**; this includes the additive index build and initial checkpoint. Cumulative daily usage does not decrease after deployment.

The original source hashes, device credentials, admission policy and installed release remain intact. No plan upgrade or history deletion was used. Explicit full-text searches, other history filters, metadata downloads, and genuinely new records retain their normal database costs. See `cloud/README.md` for the checkpoint bounds and recovery procedure; future editing or deletion of source records must also invalidate the append-only derived index.

### Website observations

The landing page and hosted workspace were inspected in Chrome on the actual custom domain. The landing, workspace, download and API pages were checked in a 390-pixel viewport, with a 375-pixel content area after its scrollbar; all four pages reported content and scroll widths of 375 pixels, without horizontal overflow. The headline, actions and product image remained legible. The intent/result/evidence proof tabs were exercised.

The product image is captured from the real Beacon workspace in an isolated fixture account populated from public alpha 3 qualification evidence. It contains no installed user history or credentials. Its accompanying copy identifies the source as public release evidence.

## Installed cross-device qualification

Both existing guest installations were updated through their normal installers while their agent applications remained open. Windows NSIS retained Google sign-in, both connected agents and all **97 records**. Intel Mac DMG → Applications retained sign-in, both agents and all **84 records**. Each app shows its native cloud controls. A history checkpoint was saved on each before installation.

The installed candidate executables came from build 39689459638's clean merge revision `02c33f867fa55726d71c60362a7d3674130a5824`, whose source tree exactly matches `0cd7c7a`. Hashes were recomputed in each guest after transfer:

- Windows Setup EXE: `4ed28592ee178fe9e9997b20d5d8165dd086112cdb8e5381b61d46f65cd213e2`.
- Intel Mac DMG: `c3d4609649d5ff9fcbe16e06ea27ba170a77058793554df98cdae8661dd0fe59`.

Windows was then updated to the clean `f8b1f97` candidate (CI merge revision `d853dcdda6d2007bc9e8a6c871c7ade7a1266233`, matching tree `00e545835054b351570f5db932b0828e04ca075f`). Its downloaded Setup SHA-256 matched `007616725e2ba9a3984360bcf7cdc314452264675160b5931b72260dc29316a4` inside the guest. The normal per-user installer retained Google sign-in, two connected agents and **103 local records**. Browser approval identified the correct Windows computer and the same hosted owner, and the encrypted callback returned Edge to the hosted workspace.

At `2026-10-22T12:42:49Z`, Linux reported **103 received records**, zero pending uploads and no sync error. Its native Codex ASIP recall returned the original Antigravity result `c4fdcc48-e385-4789-afa1-c7c4909a6987`, recorded offline on Windows at `2026-10-21T23:37:21.752Z`, with native session `520c4ef0-fbb5-4d25-b0ae-8d8e4e92086a`, project `github.com/M-o-liver/asip` and the original evidence text intact. The original Windows tool arguments and result were inspected before pairing. Independently reconstructed canonical SHA-256, the received Linux SQLite row, and its verified cloud acknowledgment all match `a27735f8a641d4f2107854fedd2629ed28b2a5cbf933396048ce965cb6a5d5e7`.

The reverse installed-agent flow also passed. Windows Antigravity called its native `asip_asip/asip_recall` for the Linux handoff's evidence phrase, after a one-time tool approval. It returned the original Linux Codex record `0fbf0efa-ad9e-4f23-8c8b-2f59e1760066`, session `01a15f6a-1626-77a1-8de5-b79b170beba2`, `originPlatform: linux`, `originAgent: codex`, original source revision and `expectedResult: Durable cross-device project memory`. The prompt did not supply the record ID or its evidence fields. Windows Beacon showed 26 projects, 13,964 records and a successful `12:49:34Z` sync.

That Windows Antigravity reply was then captured automatically and synchronized back to Linux, without an explicit result-record request. Linux native recall returned Stop record `5b19711d-7fc0-433b-aaae-39e66309ac94`, at `2026-10-22T12:58:42.414Z`, in the original Windows session and qualification-folder project. Its evidence identifies `antigravity-transcript`, native transcript step 37 and source-row SHA-256 `37706148fb7450d6a82de3d1eb58306c99ebec7b09c92708028eca3a2b167982`. The returned reply includes the original Linux handoff ID and evidence. Thus ordinary agent completion, native capture, cloud transport and recall on the other system were observed together.

The owner completed Safari's first preview sign-in. Mac Beacon connected as `crosshair · darwin` at approximately `2026-10-22T13:12Z`, retained its 84 local records and two agents, and opened the existing hosted account. The hosted computers panel showed exactly the approved Linux, Windows and Mac devices, each with its own revocable 90-day credential.

Mac Antigravity then used its native `asip_asip/asip_recall` to retrieve the Windows evidence phrase. Its answer returned the original Windows record `c4fdcc48-e385-4789-afa1-c7c4909a6987`, original agent and native session, and exact evidence. The prompt supplied neither the record ID nor its session. The ordinary Mac answer was captured automatically as Stop record `2367367a-7fd2-4a95-a480-d87cd2a2c497`, at `2026-10-22T13:26:41.613Z`, in Mac session `61778954-87a7-467e-9b2e-61f5adf13aa8` and project `/Users/testpc/asip-qualification`. Its evidence identifies the Mac transcript, step 27 and source-row SHA-256 `df439107fedd1053bcf650cb69198f82a82eaaab3e991fb2187007e4ed931671`. Linux Codex's native recall returned that same Mac reply after synchronization, with all four original Windows evidence fields intact. No explicit result-record instruction was needed on the Mac.

Linux Codex handoff marker `ASIP-CLOUD-20261021-HANDOFF`, record `0fbf0efa-ad9e-4f23-8c8b-2f59e1760066`, is also visible in the hosted workspace with its original native session, project and evidence. These observations establish Linux-to-Windows, Windows-to-Linux, Windows-to-Mac and Mac-to-Linux continuity using installed applications and native agent tools. The environments are the Linux host and existing Windows and Intel Mac virtual machines. Emulator continuity is not substituted for these installed-device observations. After initial Mac synchronization, D1 reported **124,088,320 database bytes**, still below its 500 MB free database limit.

## Published release and final upgrades — October 22, 2026

[PR #7](https://github.com/M-o-liver/asip-linux/pull/7) merged the implementation into main as `b32b7b527f1c6c05ed7c69d7e71287596040e8ca`. [v0.5.0-alpha.1](https://github.com/M-o-liver/asip-linux/releases/tag/v0.5.0-alpha.1) identifies that exact revision and tree `7c7f3b0757fe2de851c5e47cf6c885996da5c4ec`. The [tag workflow](https://github.com/M-o-liver/asip-linux/actions/runs/39790881768) passed all four native platforms and published nine installers, four qualification JSON files and `SHA256SUMS`. The Intel Mac runner required one packaging retry because its temporary DMG could not eject while busy; the fresh-runner retry passed without changing source.

All 13 published asset digests match the checksum manifest. Each native qualification file identifies the same clean tag revision and source tree. The downloaded Linux, Windows and Intel Mac installers were independently hashed; the guest hashes were also recomputed before installation:

| Installed release artifact | SHA-256 |
| --- | --- |
| Linux AppImage | `6d99ca3b108934035ece9bb1779359a4f920e957e4f9115e8d9fedb982addcaf` |
| Windows Setup | `e7b5f16e6fe9b2088ffc4258db8b3bfc0c46dc65469103fef9490159375b4e47` |
| Intel Mac DMG | `15094b0f5d3bc6ebaca8b7c77e24759b21d6006c9a09763ba24594138c07d354` |

The published AppImage replaced the Linux candidate and retained **14,908 records before and after**, sign-in and its encrypted cloud connection. SQLite integrity remained `ok`; a consistent history checkpoint and the preceding binary were retained. The normal Windows per-user installer and Mac DMG → Applications replacement retained both connected agents and their existing hosted owner without another device authorization. Windows had a **14,748-record** checkpoint before installation and showed **15,002 records**, 28 projects and successful synchronization at `17:14:44Z` afterward. The Mac showed **14,941 records** immediately before quitting for replacement and **14,998 records**, 28 projects and successful synchronization at `17:14:25Z` afterward. History continued growing through ordinary cloud activity during these observations.

At approximately `17:15Z`, live D1 readback reported **129,282,048 database bytes**, **19,345 daily row writes** and **2,412,404 daily row reads**, within the free database and daily usage limits. Linux synchronization had no error, retry pause or reconnection requirement. No history was deleted and no Cloudflare plan was upgraded. The deployed website's download page visibly identifies this release and links directly to its Windows, Apple Silicon, Intel Mac and Linux packages.

The final landing and download pages were checked again at a 390-pixel viewport: both reported a 375-pixel content and scroll width, without horizontal overflow. Windows, both Mac and all Linux package links remained legible. The hosted device timestamp label was corrected to describe approximate upload activity; download-only synchronization intentionally does not generate heartbeat database writes.

## Scope and remaining checks

Project records, intent/results/failures, native agent and session IDs, recorded evidence, project catalogue/roots/relationships, session details and named API metadata synchronize. Provider credentials, local agent grants, repository working trees, complete transcript files, OS files and arbitrary attachments are not copied. Captured tool input/output and text excerpts already included in evidence do synchronize. Cloud storage is account-isolated and encrypted by the infrastructure; it is not end-to-end encryption.

Private-preview clients need both their scoped ASIP credential and a valid 24-hour Access session. Expired admission requires browser reconnection while local recording continues. A device credential lasts at most 90 days and can be revoked separately.

Remaining product work includes live web OAuth registrations, managed independent backup automation, account deletion, attachment uploads and unreferenced-object collection. Publisher signatures and macOS notarization are not present. Apple Silicon desktop behavior, launch-at-login through an actual guest login cycle, and an authenticated paid Claude complete turn remain unqualified. Existing native plugin observations are detailed in the historical report.
