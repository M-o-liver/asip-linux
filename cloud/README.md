# Cloud architecture and operations

The `asip-cloud` Worker serves the website, hosted account workspace, device
synchronization, HTTP API, and remote MCP endpoint. Local recording remains in
Beacon. [Setup](../ALPHA.md) owns onboarding; [accounts and billing](SAAS.md) owns
entitlements and provider configuration.

## Code and configuration

| Component        | Source                                                                         | Responsibility                                                          |
| ---------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Routes           | [worker.mjs](src/worker.mjs)                                                   | Website, device approval, HTTP/MCP dispatch, authorization              |
| Identity         | [auth.mjs](src/auth.mjs), [oauth.mjs](src/oauth.mjs)                           | Browser sessions, bearer credentials, Access fallback, provider linking |
| Record storage   | [memory.mjs](src/memory.mjs), [activity.mjs](src/activity.mjs)                 | Record integrity, scoped queries, incremental aggregate index           |
| Request controls | [http.mjs](src/http.mjs)                                                       | Origin checks, body limits, throttling, quota responses                 |
| Native sync      | [cloud.mjs](../beacon/cloud.mjs), [device-link.mjs](../beacon/device-link.mjs) | Local/cloud binding, encrypted approval callback, retries               |
| Shared protocol  | [cloud-protocol.mjs](../beacon/cloud-protocol.mjs)                             | Canonical event representation and hashing                              |
| Web interface    | [public/](public/)                                                             | Static landing, authenticated workspace, download/privacy/API pages     |
| Deployment       | [wrangler.jsonc](wrangler.jsonc), [migrations/](migrations/)                   | Worker bindings, flags, release tag, additive database schema           |

The checked-in configuration attaches `asip.ca`, D1 `asip-cloud`, and private R2
`asip-cloud-records`. It disables `workers.dev`, preview URLs, and Worker request
logging. `PRIVATE_PREVIEW=false` selects public entry; `BILLING_ENFORCED=true`
enables hosted entitlements. Dashboard-managed variables can be retained through
`keep_vars`; inspect deployment configuration separately when operating the
service. A checked-in setting establishes configuration intent, not live state.

## Identity and admission

Public sign-in uses Google or GitHub web OAuth. Browser-bound single-use state
and PKCE protect both flows; Google also verifies nonce and the signed ID token.
Provider subject identifies the account. Handles are editable addresses.
Identity linking requires the original signed-in owner and rejects an identity
already linked elsewhere. Matching email addresses do not merge accounts.

Browser sessions are opaque tokens, hashed in D1, expire after 30 days, and use
Secure, HttpOnly, host-only cookies. Browser mutations enforce Origin.

The optional private-preview path is controlled by `PRIVATE_PREVIEW` and an
Access audience. `/auth/access` is a separate restricted owner fallback with
`ACCESS_SIGNIN_AUD`; it must differ from `ACCESS_AUD`. Delegated preview admission
cannot mint an owner browser session. Public provider sign-in works independently
of this fallback. Cloudflare Access applications and allowlists are external
configuration; verify them directly before changing admission.

## Device approval

Beacon opens `/connect` with a proof challenge, random state, ephemeral P-256
public key, computer label, and temporary loopback callback. The owner approves
the selected hosted account. The reply uses ephemeral ECDH, HKDF-SHA-256, and
AES-256-GCM, bound to the challenge and state. Browser navigation returns
ciphertext rather than plaintext credentials.

Beacon verifies callback Host, decrypts the reply, checks state, and redeems a
two-minute single-use code with the original proof verifier. D1 consumes the code
atomically. Device credentials expire after 90 days and can be revoked. Beacon
encrypts the connection with its OS-backed storage and permanently binds that
local account's history to its first cloud owner. Another owner's history needs
a separate local account.

## Synchronization and integrity

1. Beacon writes local SQLite history first. Offline recording continues.
2. Upload passes send at most 40 records within a 512 KiB request. Recent pending
   work precedes older backfill.
3. Canonical hashing covers `id`, `at`, `agent`, `session`, `kind`, `project`,
   `summary`, and `data`, with sorted JSON keys. Private R2 stores source objects;
   D1 stores searchable records and source hashes within the owning account.
4. Identical retries are idempotent. Conflicting content under the same account
   and record ID returns 409. R2 writes precede the atomic D1 event batch; failed
   batches can leave unreferenced private objects.
5. Pull follows the server sequence, verifies each source hash, and advances the
   local cursor transactionally. Display keeps original timestamps and stable
   pagination. Native duplicate-delivery receipts preserve distinct observations.
6. Project/session metadata, paths, relationships, and named connection metadata
   synchronize in resumable 30-entry chunks. Credentials and plugin grants remain
   local. Full transcript files, working trees, and referenced attachments are
   outside sync; evidence already captured in a record synchronizes with it.
7. Local recovery retains cloud history and resets the local sync scan. Different
   local evidence cannot be silently overwritten by a cloud record.

Trace redaction is best effort. Cloud storage uses infrastructure transport and
at-rest encryption; this is not end-to-end encryption of synchronized evidence.

## Quotas and query cost

Native event checks normally run every 30 seconds. Metadata hashes suppress
unchanged uploads; catalogue/account refreshes occur at most every five minutes.
Conditional server upserts protect against unchanged writes from older clients.
Workers rate-limit bindings avoid a database counter write on every request.
Their limits are approximate per Cloudflare location.

Projects, session counts, and inferred relationships use an incremental R2
checkpoint at `<account>/indexes/activity-v1.json`. D1 remains authoritative.
Requests check the indexed sequence and fold in newer records. Conditional R2
writes protect concurrent updates. Account/project scope applies to every view.
The index bounds are 50,000 groups and 8 MiB; corrupt or unavailable checkpoints
fail without repeatedly scanning full history or publishing truncated counts.
Relationship expansion is limited to the first 100 ordered pairs.

Daily D1 quota pauses persist across Beacon restarts until the UTC reset. Other
network failures back off from 30 seconds to 15 minutes; storage exhaustion uses
an hourly retry. Local recording continues. Monitor actual D1 row reads/writes,
database bytes, and R2 usage; these controls preserve budgets rather than
increasing the platform allowance. Metered fixtures live in
[cloud.test.mjs](../tests/cloud.test.mjs); historical production observations
remain in [qualification history](../QUALIFICATION.md).

## HTTP and MCP access

`/api/v1/` exposes account-scoped history, projects, sessions, relationships,
source evidence, device management, and named connection metadata. The
[API page](public/api.html) owns request examples. Browser owners issue scoped,
revocable API credentials; tokens are shown once, stored as hashes, and expire
after 90 days. Credentials can restrict project access and bind appended records
to an agent. Entitlements are enforced separately from token validity.

`POST /mcp` serves stateless JSON-RPC tools for status, projects, recall,
connection metadata, and append-only recording. GET/SSE is unsupported. The
remote endpoint has no provider API execution tool: provider credentials remain
with Beacon, whose native helper exposes `asip_api_request`.

## Develop, deploy, recover

Run from the product root:

```sh
npm ci
npm run test:cloud
npx wrangler d1 migrations apply asip-cloud --local --config cloud/wrangler.jsonc
npm run cloud:dev -- --var ORIGIN:http://127.0.0.1:8787
npm run cloud:build
```

Tests run the actual bundled Worker against disposable emulator D1/R2 bindings.
Fixtures establish protocol and isolation checks; real provider authorization,
payments, and deployed-device behavior require separate observations.

Apply additive migrations before the corresponding deployment:

```sh
npx wrangler d1 migrations apply asip-cloud --remote --config cloud/wrangler.jsonc
npx wrangler deploy --config cloud/wrangler.jsonc
```

Use supported Wrangler or CI credentials. Secrets belong in Worker secret storage;
local Beacon vault and sign-in files remain with Beacon. Keep a previous compatible
Worker version for rollback. A pre-SaaS Worker predates current OAuth schema and
entitlement enforcement; review that downgrade separately.

Use D1 Time Travel and independent D1/R2 backups for recovery. Rebuilding an
account's derived activity checkpoint incurs a one-time scan; remove only the
derived index when explicitly rebuilding it. Preserve canonical event objects
and database history. Account deletion, attachment uploads, automatic object
garbage collection, and managed backup automation are outside this implementation.
