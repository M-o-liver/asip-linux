# Implementation notes

## Beacon and installed plugins

Beacon owns the local account, connection approvals, API credentials, and activity database. The same application and service code run on Windows, macOS, and Linux. The Go executable in each native plugin talks to Beacon over loopback. There is no dependency on the previous Linux administration daemon.

An installed plugin has no project memory or API access until the user signs into Beacon and connects it. Beacon attributes requests to that connection's agent and account. Disconnect and sign-out stop new recording and cancel outstanding API requests.

The provider's stable subject identifies the local ASIP account. Google email addresses and GitHub handles are display fields. This preview does not provide account linking or cross-device synchronization.

## Records

Each event has an immutable ID, timestamp, agent, native conversation ID, project, kind, summary, and structured evidence. SQLite uses WAL and full synchronous writes. Tool traces retain native identifiers, bounded input/output, explicit outcomes, Git revision/worktree state, and a transcript reference and hash when supplied. A trace reference is not a copied transcript.

Codex supplies conversation metadata on MCP calls. The calling thread takes precedence over the root session, which is retained as evidence. Other clients receive their native context through lifecycle hook output. ASIP never borrows a different conversation's most recent session or project.

Native hook discovery, MCP startup, and complete turn capture are separate checks. CI installs plugins with the actual managers. Codex hook trust remains in its native hook manager. Complete turn capture must be qualified on each supported agent surface; a working MCP connection alone does not establish that.

## Project association

Hooks resolve the working directory to a Git root and canonical origin repository. SSH and HTTPS origins resolve to the same repository identity. Repositories without a usable origin retain their local root; other work retains its working directory. Multi-workspace activity without a specific directory remains unassigned. Each hook record includes the association method and original directory evidence.

This keeps the evidence needed to reconsider associations later. A project correction should append a decision referring to the original events, rather than rewriting the tool trace.

### Jev investigation — 2026-10-14

[TypeSafe's Choice primitive](https://docs.typesafe.ai/primitives/choice) returns a selected option, option probabilities, and confidence. The [HTTP API](https://docs.typesafe.ai/api) accepts structured state and typed questions at `POST /v1/systemone`. Its [confidence documentation](https://docs.typesafe.ai/confidence) distinguishes confidence from the probabilities assigned to options. The vendor also documents [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), including irrelevant context and indirect descriptions.

For ASIP, the useful experiment is classification of otherwise unassigned activity among a small set of recorded projects, with an explicit unresolved option. Input should contain the native directory evidence, repository candidates, and a bounded activity excerpt. Store the input hash, candidate set, model version, returned distribution, and subsequent user correction. Measure accuracy on labelled ASIP traces before choosing an automatic assignment threshold. A suggestion must not replace a direct repository observation or invent an outcome.

No live Jev calls have been made, and no probabilistic assignments are currently applied. It can use a named custom API connection without introducing another credential mechanism or making recording depend on a remote model.

## API requests

Connection names are stable within an account. Each connection specifies a provider origin, authentication method, credential, and optional project assignments. OS keychain encryption protects the stored connection file. Plugins receive connection metadata and responses, rather than a credential lookup capability.

Beacon records the request before dispatch, then records its HTTP result with the provider request ID and response hash. It does not put response bodies, query strings, authentication headers, or request bodies into API audit rows. Network interruption is unresolved because the provider may already have performed the operation. Clients must inspect the audit or provider state before retrying writes.

Requests currently use JSON with bounded bodies and responses. HTTP errors are returned with their status and recorded as failed results. Responses too large to return are marked truncated. Streaming, uploads, provider-specific SDK wrappers, and Google API OAuth scopes are future work.

## Platform qualification

CI builds and starts native installers on all three operating systems, and compiles x64/arm64 plugin executables. Codex and Claude versions and Antigravity release hashes are pinned for reproducible qualification. Provider login remains an interactive check. Unsigned installers do not establish publisher trust or macOS notarization.

Launch at login uses [Electron's native login-item APIs](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) on Windows and macOS and the [XDG autostart specification](https://specifications.freedesktop.org/autostart/latest/) on Linux. It is enabled by default; an explicit opt-out is retained. A login launch keeps Beacon in the background. Unsigned macOS builds fall back to a per-user LaunchAgent if native login-item registration is unavailable.

## Managed installations and desktop shell

Beacon stages all three platform-native bundles under its application-data `plugins` directory. Stable per-agent paths survive upgrades. Its Install action invokes the provider’s plugin manager; when Codex CLI is absent, **Open in ChatGPT** opens the documented local-marketplace installation link. Antigravity desktop registration uses its native global plugin directory and also works without the CLI. For CLI-managed copies, Beacon verifies that their manifest, MCP configuration, and hooks match its managed bundle; those managers own installed copies, enabled state, and hook review. No provider configuration or trust files are edited by Beacon. Installing the managed ASIP marketplace replaces only an earlier `asip@asip-local` plugin after the new installation succeeds. Windows npm wrappers receive argument data through a fixed PowerShell invocation; paths are not compiled into shell commands.

A fresh helper starts a bounded background account connection after MCP initialization. That helper survives a discovery transport closing while the user approves Beacon. Per-agent leases avoid duplicate prompts from concurrent discovery processes; stale leases expire. Disconnect cancels pending approvals as well as issued connections. Beacon can receive that request before an account is signed in; completing Google/GitHub sign-in completes the pending connection. Existing-account connections require Connect. Proof verification and account binding remain in the runtime. Multiple agents queue their requests. An existing token does not trigger automatic reauthorization after a disconnect.

Linux uses a full desktop window, independent of status-indicator extensions. Windows and macOS use tray bounds and display work areas to position a nearly square panel. Right-click retains the native menu. The panel hides on focus loss, stays present during sign-in or a native dialog, and can expand into the full window. Missing tray placement falls back to a full window. macOS uses a monochrome template icon with a retina asset.

## Build identity and release evidence

Packaged Beacon includes its version, Git revision, source-tree hash, dirty flag, target platform, and build time. Plugin status reports its version and revision. PR builds may identify the generated merge commit; compare the source-tree hash with the branch when qualifying those installers. Native qualification reports accompany release checksums.

Secondary-launch qualification verifies that the primary receives an import action and that the secondary process cannot erase saved sign-in. Linux AppImage verification selects the current application version explicitly, so old artifacts in a developer build directory cannot be mistaken for the candidate.
