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

Launch at login uses [Electron's native login-item APIs](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) on Windows and macOS and the [XDG autostart specification](https://specifications.freedesktop.org/autostart/latest/) on Linux. It is opt-in. A login launch keeps Beacon in the tray/menu bar.
