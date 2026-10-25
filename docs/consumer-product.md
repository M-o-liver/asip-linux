# ASIP: a memory that moves with your work

## Product decision

The customer is buying less repeated explanation and fewer lost decisions. The
promise is **Pick up where you left off.** The category is a shared memory for AI
agents. Beacon is the desktop connector; the website is the place to understand,
activate and inspect that memory. The connector metaphor works when state is
truthful and setup ends in an observable result.

The VPN analogy is useful for connection, background operation and recovery. It
must not suggest that ASIP captures every conversation, guarantees complete model
context, or encrypts cloud records end to end. Agent installation, authorization,
hook approval, recording and cloud synchronization are distinct states.

## Customer audit, 24 October 2026

The public landing page exposed six workspace tabs, search, metrics and an
illustrated synchronization dashboard before account creation. It required
JavaScript even to explain the product. The signed-in home repeated marketing
copy and claimed “ALL SYSTEMS OPERATIONAL” after fetching data. Historical agent
activity was labelled connected. Neither proves current recording or sync.

A real signed-in owner workspace displayed 30 projects, 17,081 records and three
authorized devices during the audit. This session's recorded intention appeared
in that workspace through the installed plugin and cloud sync. The central
capability is real. Its usefulness was buried under tiny, truncated excerpts,
technical provenance language and a decorative diagram. Empty accounts lacked
a concrete first-memory exercise.

Beacon already had useful per-agent installation, connection approval, local
history and cloud state. The installed account was connected to cloud with no
sync error. Native plugin hooks and grants remain the authority for capture;
this release does not bypass native review or modify trust files.

The existing live plan is CAD 1200 monthly, independently checked through the
named Stripe connection. CAD 2000 for new subscriptions is the proposed consumer
price. Production price creation requires explicit approval; until received,
public copy and Checkout stay at CAD 1200. Existing subscribers and founder
access must retain their entitlement. An explicit legacy-price allowlist is
supported and tested for that transition. No existing subscription is repriced.

## Comparable experiences and interpretation

- [Tailscale quickstart](https://tailscale.com/docs/how-to/quickstart): installation
  and connecting devices turn infrastructure into a usable personal utility.
  ASIP's analogous activation is a saved decision recalled in a later session.
- [Mullvad pricing](https://mullvad.net/en/pricing): a flat monthly price makes
  the commercial relationship legible. ASIP should sell one understandable
  benefit and state the billing interval plainly.
- [1Password for individuals](https://1password.com/personal-family-security):
  leads with everyday outcomes and demonstrates a familiar task. ASIP's concrete
  demonstration is a project handoff, not an abstract memory graph.

These are design interpretations, not conversion evidence or user research.
No claim is made that the redesign has yet improved paid conversion.

## Implemented experience

1. A static, readable public page explains the benefit without JavaScript. It
   shows an explicitly labelled example handoff, supported agents, setup,
   privacy boundaries, early-access installer limitations and honest trial terms.
2. The account home prioritizes the latest project and readable saved work.
   Projects, Memory and Agents & computers are the primary navigation. API
   connections and recovery remain available in the account menu.
3. Empty-account setup confirms a valid device grant, observed native-agent
   history and a saved record from cloud responses. Clicking a download does
   not count as activation. No-record accounts show the setup path without
   duplicate empty dashboards.
4. Copy continuation prompt supplies the exact project identity. Copy handoff
   notes exports up to eight visible historical records with source IDs and an
   explicit reminder to verify current state; it does not invent a summary.
5. Cloud status describes saved memory and refresh time. Beacon supplies local
   service, account, agent, local-only, syncing and cloud-attention states,
   with a relevant next action. A grant is not labelled an online heartbeat.
6. Download, connection approval, privacy and API pages share the same typography,
   colors and readable surfaces as the public product. Beacon retains a native
   dark surface with the same restrained green identity.

## Validation and release boundaries

The full native/service suite passed 89 tests with two platform skips and no
failures in the host environment. Targeted billing and continuity checks passed
8 tests, including legacy-price recognition, expired/revoked device handling,
local-only operation, reconnect, pending sync and error states. Formatting and
Worker bundling passed. Browser checks use labelled disposable sample data for
empty/established accounts before production deployment.

Production and native artifact qualification is recorded in QUALIFICATION.md.
The UI preview fixtures are local-only and are not shipped as customer data.
The trial remains the existing seven-day no-card trial. OAuth, account isolation,
record integrity and sync protocols are preserved. No production payment is
submitted as a test.

## Next evidence to collect

Measure time from account creation to first synced agent record and to the first
successful recall in a different native session. The second event is the stronger
activation signal. Do not add invasive telemetry to infer it. In an opt-in user
study, observe setup without coaching, ask the customer what travels to cloud,
and have them resume a project the following day. Test whether the saved decision
actually reduces explanation before expanding acquisition spend.

Remaining product limits: unsigned desktop installers, manual native hook review,
separate local/cloud identity linking, no general account-deletion workflow, and
no guarantee that a model will use all recalled evidence correctly. These are
explicitly documented limits, not capabilities added by this visual release.
