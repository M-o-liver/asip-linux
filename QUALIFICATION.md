# Qualification history

Dated evidence for the source revisions, installed builds, and environments named
in each entry. Historical limits and deployment states apply to their recorded
date; current behavior and configuration are described in [README.md](README.md),
[architecture](ARCHITECTURE.md), and the [cloud guide](cloud/README.md).
The desktop source version is owned by [package.json](package.json); each release
receipt identifies the actual artifact tested.

## Consumer continuity release — 2026-10-25

The consumer website and authenticated workspace are deployed at `https://asip.ca`.
Initial Worker `4f611527-70ed-4daa-a7f7-08363b48566b` served source `d5735b9`.
Worker `dd064c8a-2634-4f78-bfac-4beadaadf9c9` serves source `1ea3a21`, including
saved decisions in default Work history. Additive migration
`0006_decision_history.sql` is applied; the preceding index remains for rollback.
No record contents or account credentials were migrated.

Full local qualification: 89 passed, two platform skips, zero failures. After the
live workflow exposed missing decision rows, cloud regression qualification passed
26 tests and local workspace/continuity qualification passed six tests. Formatting
passed and the Linux unpacked desktop candidate built successfully.

Browser qualification covered the real public landing at phone width, empty-account
setup with disposable fixtures, populated home, native mobile navigation, and prompt
copying. In the production owner account, search found decision
`8b9e747a-6530-4681-ab97-6cfae19c3904`, Copy handoff notes succeeded, and Verify source
reported that SHA-256 matched the original cloud record. The same decision was
retrieved through the native ASIP recall tool. This is not a claim of a newly
performed cross-device installation or paid transaction.

[PR #14](https://github.com/M-o-liver/asip-linux/pull/14) contains the implementation.
The `v0.6.0-alpha.1` tag identifies source `1ea3a21`; its
[native release workflow](https://github.com/M-o-liver/asip-linux/actions/runs/40147974447)
is the authority for installer publication. At this entry's creation, that workflow
was still running and the website retained the verified 0.5.1 download links.
The tagged native workflow subsequently passed Windows, Linux, Apple Silicon and
Intel Mac, including native plugin qualification, packaging and startup checks.
The prerelease was published at 2026-10-25T00:52:45Z. All four qualification
receipts identify source `1ea3a21`, tree `4dc7d70aa0213e43202bbc711b47d798b2d97a4f`,
and a clean build. Freshly downloaded Windows and Linux payloads were independently
verified against both SHA256SUMS and GitHub's asset digests:

- Windows EXE: `325e0eb07f7a47fd07942356ac1db7f642716cc7cf977db1ec43712192d82cd0`
- Linux AppImage: `e7e7829fda8228fe4a1682fc0e31dd34280f52f2bf817d62e0cfe11e42abb547`

The website download links now identify this release. A separate Ubuntu PR run
hit `write EPIPE` in the helper test process; only its failed job was retried.
The successful tagged native build remains the published binary qualification.
This session did not replace the user's installed Beacon or re-run a new-device
OAuth approval. Final visual-contrast Worker `d4324101-ee42-47b2-a217-b005de322fe8`
served website source `2e10d19` before the download-link update.

Production pricing remains CA$12/month. Creating the proposed CA$20 live price was
blocked by automatic approval review and is awaiting explicit owner approval.
Current setup and product boundaries are documented in [the setup guide](ALPHA.md)
and [architecture](ARCHITECTURE.md). The earlier design/audit note was retired
during documentation consolidation.

This report records deployed behavior, installed-device observations, and automated checks separately. Earlier Beacon and native plugin evidence is preserved in [the 0.4.1 section below](#beacon-041-desktop-qualification--october-2026).

## Plugin archive update — October 24, 2026

Beacon 0.5.1 packages native plugin ZIPs and reveals the actual upload file in Claude’s setup flow. Claude’s helper is declared under `libexec/` in MCP and hooks; its hosted uploader rejects top-level `bin/` executables. ZIP manifests stay at the archive root, executable permissions are retained, and managed archives refresh after source updates. Codex and Antigravity keep their existing native installation paths.

The actual Windows Claude application accepted the corrected archive, completed Upload, and displayed **“Asip is installed and ready to use.”** The installed plugin is enabled with two skills, one connector and ten hooks. The artifact remains in the test user’s Windows Downloads folder. The temporary read-only transfer CD was restored to its original media after copying. This interactive installation check used the 0.5.0 packaging fix merged in [PR #11](https://github.com/M-o-liver/asip-linux/pull/11); 0.5.1 gives the new installer and plugin manifests a distinct update version.

The packaging fix passed all four native platform builds and cloud CI. Its complete local suite passed 87 tests with two platform skips and zero failures. Independent ZIP CRC, root-manifest, Windows PE helper and no-top-level-bin checks passed. Each tagged release separately rebuilds and qualifies the current version, and publishes platform qualification receipts and SHA256SUMS alongside installers.

Cowork model-turn connection and automatic recording remain pending at the owner’s request; their friend will test separately. Installation acceptance is not substituted for runtime evidence. Existing native CLI/MCP fixture qualification remains part of every platform build.

## Public SaaS launch — October 22, 2026

This entry supersedes the private-preview admission and missing web-provider facts below. **https://asip.ca** now serves the reference-based obsidian, antique-gold and sage login surface and authenticated application. The overview reconstructs the supplied composition with a continuity globe, translucent status strip, agent cards, activity stream, project list and spotlight, device diagram, and evidence panels. Projects, Agents, Connections, Evidence, Recovery, Account/API access and Billing use real account-owned cloud data. Raster art has no baked-in application labels or fabricated data; [the SaaS operations guide](cloud/SAAS.md) describes current interface and configuration.

Provider, trial and Checkout qualification used Worker `3f717e39-2d09-4f01-ae41-4c5ba9456471`, from application source `456eaab`, with additive migration `0005_saas.sql` applied. Final visual qualification also made the login hero grow to its card content, preventing panel overlap on wide screens; the launch completion record identifies the final deployment. Existing owners retain founder access. The public apex returns HTTP 200 without cookies, `/privacy` returns 200, anonymous `/api/v1/me` returns 401, and an anonymous owner-workspace request redirects to sign-in. After explicit owner approval, the former domain admission application was narrowed to `*.asip.ca`, preserving its allowlist. The independent restricted `/auth/access` application and its distinct audience remain; anonymous admission there still redirects to Access. Google Auth Platform visibly reports **In production**.

GitHub's requested read-only profile/email permissions were approved. Both GitHub and Google identities were explicitly linked from the existing owner account; subsequent sign-out and independent sign-in round trips through each provider returned to the same `/users/bosslikedat` workspace. Its existing history remained visible: 28 projects, over 15,800 records, three agents, three devices and 14 named API connections during qualification. Counts continue to change as Beacon records work. This observation does not imply every retained provider credential is valid.

A separate owner-controlled Google identity completed first-time signup at `2026-10-22T23:01:01.730Z`. It received an isolated, empty workspace and a no-card trial ending exactly seven days later, `2026-10-29T23:01:01.730Z`. From that app, Subscribe opened **live Stripe Checkout** for **CA$12/month**, with the October 29 first-charge date; Manage subscription opened the real billing portal with no payment method and no invoices. The deployed authenticated billing refresh independently returned `providerVerified: true` for the configured live CAD 1200/month price. The unpaid qualification Checkout was expired through Stripe without submitting payment, creating a subscription or charging a card. The separate trial account remains available with its original expiry; the owner history stays in the founder account.

The live Stripe webhook endpoint is enabled for Checkout completion and subscription creation/update/deletion. An unsigned production request is rejected with HTTP 400. Automated checks exercise raw-body signatures, tampering, timestamp tolerance, duplicate event receipts, live/test mode, account/customer/price binding, current subscription reconciliation, access expiry, management access after expiry and portal/Checkout behavior. No live financial transaction was performed; real paid activation, renewal and cancellation events remain unobserved. Configuration details and rollback constraints are in [cloud/SAAS.md](cloud/SAAS.md).

Live qualification exposed an unsupported Workers fetch option during provider token exchange. Both OAuth and Stripe now use manual redirects and reject non-success responses. A full GitHub callback and Stripe verification run inside the actual Worker emulator, including redirect rejection, rather than only Node fetch mocks. The final cloud suite passes **25 tests**, with zero failures. Formatting and Worker bundling pass. The final complete suite passes **86 tests**, with **two platform-specific skips** and **zero failures**; CI results are recorded with the launch completion evidence.

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

| Operation                         | D1 rows read |
| --------------------------------- | -----------: |
| One-time account checkpoint       |       30,001 |
| Twenty warm aggregate loads       |     20 total |
| Include one newly appended record |            3 |
| A 30-record Work page             |           31 |

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

| Installed release artifact | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| Linux AppImage             | `6d99ca3b108934035ece9bb1779359a4f920e957e4f9115e8d9fedb982addcaf` |
| Windows Setup              | `e7b5f16e6fe9b2088ffc4258db8b3bfc0c46dc65469103fef9490159375b4e47` |
| Intel Mac DMG              | `15094b0f5d3bc6ebaca8b7c77e24759b21d6006c9a09763ba24594138c07d354` |

The published AppImage replaced the Linux candidate and retained **14,908 records before and after**, sign-in and its encrypted cloud connection. SQLite integrity remained `ok`; a consistent history checkpoint and the preceding binary were retained. The normal Windows per-user installer and Mac DMG → Applications replacement retained both connected agents and their existing hosted owner without another device authorization. Windows had a **14,748-record** checkpoint before installation and showed **15,002 records**, 28 projects and successful synchronization at `17:14:44Z` afterward. The Mac showed **14,941 records** immediately before quitting for replacement and **14,998 records**, 28 projects and successful synchronization at `17:14:25Z` afterward. History continued growing through ordinary cloud activity during these observations.

At approximately `17:15Z`, live D1 readback reported **129,282,048 database bytes**, **19,345 daily row writes** and **2,412,404 daily row reads**, within the free database and daily usage limits. Linux synchronization had no error, retry pause or reconnection requirement. No history was deleted and no Cloudflare plan was upgraded. The deployed website's download page visibly identifies this release and links directly to its Windows, Apple Silicon, Intel Mac and Linux packages.

The final landing and download pages were checked again at a 390-pixel viewport: both reported a 375-pixel content and scroll width, without horizontal overflow. Windows, both Mac and all Linux package links remained legible. The hosted device timestamp label was corrected to describe approximate upload activity; download-only synchronization intentionally does not generate heartbeat database writes.

## Scope and remaining checks

Project records, intent/results/failures, native agent and session IDs, recorded evidence, project catalogue/roots/relationships, session details and named API metadata synchronize. Provider credentials, local agent grants, repository working trees, complete transcript files, OS files and arbitrary attachments are not copied. Captured tool input/output and text excerpts already included in evidence do synchronize. Cloud storage is account-isolated and encrypted by the infrastructure; it is not end-to-end encryption.

Private-preview clients need both their scoped ASIP credential and a valid 24-hour Access session. Expired admission requires browser reconnection while local recording continues. A device credential lasts at most 90 days and can be revoked separately.

Remaining product work includes live web OAuth registrations, managed independent backup automation, account deletion, attachment uploads and unreferenced-object collection. Publisher signatures and macOS notarization are not present. Apple Silicon desktop behavior, launch-at-login through an actual guest login cycle, and an authenticated paid Claude complete turn remain unqualified. Existing native plugin observations are detailed in the historical report.

## Beacon 0.4.1 desktop qualification — October 2026

This historical local-only release predates cloud storage. Later dated entries
above supersede its product limits and credential observations.

This page separates native build checks from observed desktop behavior. Installation, MCP startup, and a complete agent session are different checks.

### Automatic Antigravity summaries — October 21

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

After capture, native ChatGPT on both Windows and Intel Mac used `asip_status` and `asip_recall` to retrieve the new Antigravity response without reading project files. Both returned the exact saved text, native session, and source step (Windows 17, Mac 11). The Mac answer also identified the matching record ID. This completes cross-agent retrieval of the automatic response on all three tested systems.

The Linux installed upgrade also retained encrypted credential files byte-for-byte and passed SQLite integrity checking with 9,986 events at upgrade. The application suite passed 54 cases with two Windows-only skips locally; Windows runs those platform checks in native CI. Go race tests passed. This follow-up changes automatic Antigravity capture, not account linking or history synchronization.

### Native builds

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

### Desktop observations

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

### Published alpha

[ASIP 0.4.1 alpha 3](https://github.com/M-o-liver/asip-linux/releases/tag/v0.4.1-alpha.3) publishes source `57f5c7c`, with the same application/helper code exercised above; only README and qualification notes changed from candidate `21d4f9c`. [Tagged build 39608084047](https://github.com/M-o-liver/asip-linux/actions/runs/39608084047) passed all four native jobs and the release job. The nine installers and four qualification records matched all 13 digests in `SHA256SUMS`; every qualification record names the exact clean tagged revision and tree. The Windows installer returned HTTP 200 without authentication. PR #6 is merged. Windows EXE SHA-256: `1f81b67bc2e1bade143ec84abcb726911baf52092ecaa90eb9cc564d7bc69d4e`.

[ASIP 0.4.1 alpha 2](https://github.com/M-o-liver/asip-linux/releases/tag/v0.4.1-alpha.2) contains nine installers, four native qualification records, and `SHA256SUMS`. All 13 asset digests matched the checksum manifest; each qualification record names the exact clean tagged revision and tree. The Windows EXE returned HTTP 200 without authentication after publication. Both earlier implementation PRs are merged.

### Existing records and API connections

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

### Qualification limits

- Earlier Antigravity turn-ending entries retain “Stop”. New completed turns capture the native final response when its supported transcript is available; missing or unsupported transcripts retain metadata only.
- Verify launch-at-login across an actual guest login cycle.
- Complete a Claude turn when an authenticated paid account is available.
- Verify real GitHub identity sign-in in an isolated account/profile. Google sign-in and GitHub API authorization have been exercised; these are separate flows.

Installers remain unsigned and macOS builds are not notarized. Cross-device history synchronization, account linking, streaming API responses, file uploads, and raw signing-secret injection are not implemented. Recovery restores ASIP activity history, not repository files or operating-system state.
