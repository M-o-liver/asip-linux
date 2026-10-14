# Qualification evidence

This report distinguishes portable implementation checks from native
desktop/account qualification. It is updated with the release's actual results.

## Local results, 2026-10-14

- Fedora 44 / Python 3.14: the portable suite passes 17 behavioral tests.
- 40 concurrent event writers preserve a valid transactional integrity chain.
- Duplicate hook retries resolve to one event; conflicting source keys fail.
- Repository aliases group correctly; nested repositories remain independent;
  unknown and multi-workspace associations abstain.
- Claude/Codex and native Antigravity hook fixtures preserve identity and
  explicit failures without retaining raw prompt/tool secrets.
- MCP stdio initialization, discovery, intention creation and recall pass.
- Loopback HTTP authentication, Host/Origin isolation and project registration
  pass against an actual local server.
- Credential grants deny unapproved projects, redact exact credential echoes,
  constrain API origins and survive finite child execution.
- Ten-checkpoint retention, checksum validation, restore and pre-restore
  preservation pass. A running Beacon prevents restore.
- Native configuration merges preserve unrelated hooks/servers and repeat
  without duplicate ASIP hooks.
- Claude Code 2.1.226 validates the native plugin manifest successfully.
- Codex CLI 0.162.1 is available locally for configuration qualification.
- The wheel builds and installs with Beacon/OS-vault dependencies from PyPI.
- Linux's real login session exposes Secret Service and libsecret through a
  keyring chain; the adapter selects a native backend.
- A disposable credential was written to the actual Secret Service vault,
  granted to a test project, used in a finite child, checked for output/audit
  redaction, and removed. Native storage and audit integrity passed.
- The installed user service is active and `asip-beacon --open` opens the
  existing managed process. A startup/open race found during actual use was
  corrected and exercised again successfully.
- The live browser workspace was inspected with actual registered projects,
  imported Linux evidence, native Claude session records and connection metadata.
  Browser review led to a readable grid map and corrected recency indicators.
- Codex recognizes the user-scoped stdio server; Claude reports it connected.
- [Cross-platform CI run 38599661959](https://github.com/M-o-liver/asip-linux/actions/runs/38599661959)
  passes all six Python/OS jobs on implementation commit `596e100` (17 tests
  per job). Windows and Linux passed initially; macOS exposed a test assertion
  that confused its legitimate `/private/var` path with a stripped credential.
  The corrected test verifies exact repository identity and credential removal.

## Platform and provider boundaries

GitHub Actions supplies Python 3.11/3.13 test jobs for Ubuntu, Windows and macOS.
Their results qualify persistence, portable APIs and configuration, not native
tray/menu-bar behavior or interactive OAuth consent.

The GNOME extension is installed and enabled in preferences, but the current
Wayland session does not discover a newly copied extension until the next login.
No session restart or reboot was performed. Windows/macOS native tray backends
and startup files are implemented; graphical interaction on those OSes remains
a distinct qualification item.

Antigravity's native contract was researched and its distinct config/payload
formats are fixture-tested. An installed Antigravity runtime is not available
on this machine, so end-to-end native discovery is not claimed.

GitHub device flow and Google Desktop PKCE are implemented. Live authorization
requires the operator's OAuth client/consent. OpenAI, Anthropic and Jev live API
calls require provisioned/granted authorities. Fixture tests do not establish
provider availability, billing, scope coverage or Jev classification accuracy.

The Linux administration layer is retained; portable recording does not require
a root-service update. Actual deployment facts and remaining native checks are
recorded in the release report and local ASIP change.
