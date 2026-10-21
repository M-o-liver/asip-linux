# ASIP cloud

ASIP's permanent website, private account workspaces, synchronization service,
and agent API run in one Cloudflare Worker. The source lives beside Beacon so
the local and hosted record protocol can be reviewed and released together.

## Resources

- Worker: `asip-cloud`; `workers.dev` and version preview URLs are disabled.
- Website: `https://asip.ca`, with a redirect from `www.asip.ca` when attached.
- D1: `asip-cloud`, ID `256ab73a-fef4-48e2-91a3-2f2b324fea07`.
- Private R2 bucket: `asip-cloud-records`; no public bucket domain is required.
- Existing publication Worker: `asip-publication`, retained for recovery.
- Zero Trust organization: `damp-pond-2f61.cloudflareaccess.com`.

Resource creation is recorded in Beacon. Deployment and admission status are
reported separately in `QUALIFICATION.md`; a configuration file is not proof
that a resource is serving traffic.

## Develop and qualify

```sh
npm ci
node --test tests/cloud.test.mjs
npx wrangler d1 migrations apply asip-cloud --local --config cloud/wrangler.jsonc
npx wrangler dev --config cloud/wrangler.jsonc --var ORIGIN:http://127.0.0.1:8787
```

The cloud tests bundle the actual Worker and run it in Cloudflare's emulator
with D1 and R2. All account, credential, and event fixtures are disposable. They
do not contact identity providers or use installed user credentials.

`scripts/capture-product.cjs` captures the real local workspace using a separate
sample account populated from public alpha 3 qualification evidence. It never
reads the installed account. The image is illustrative release evidence in the
actual product, rather than a live cloud synchronization claim.

## Admission and account identity

The private preview uses a Cloudflare Access self-hosted application covering
`asip.ca` and `*.asip.ca`. Its Allow policy contains administrator-selected
email addresses. One-time PIN verifies those addresses. An unlisted visitor
cannot enter. Add and remove testers in Zero Trust → Access → Applications →
ASIP private preview → the allowlist policy. Do not add an Everyone rule while
the preview is private.

The Worker verifies Access JWT signatures, issuer, audience, type, and expiry
at `/auth/access`. The stable Access subject creates a durable ASIP account.
Handles such as `/users/mikethirtythirty` are editable addresses, not database
identities or authorization boundaries. Two accounts never share records on the
basis of a matching handle or email address.

ASIP browser sessions are opaque, hashed in D1, expire after 30 days, and use
Secure, HttpOnly, host-only cookies. The Access gate independently governs
whether a preview request can reach the service. Browser mutations verify
Origin and reject cross-site requests.

Google and GitHub web OAuth routes support explicit identity linking. They
require separate web application registrations before those website buttons
appear. Set Worker secrets `GOOGLE_WEB_CLIENT_SECRET` and
`GITHUB_CLIENT_SECRET`, and configure `GOOGLE_WEB_CLIENT_ID` and
`GITHUB_CLIENT_ID`. Register these exact callbacks:

- `https://asip.ca/auth/google/callback`
- `https://asip.ca/auth/github/callback`

Google uses PKCE, state, nonce, and verified ID tokens. GitHub verifies the
authenticated profile and primary verified email. Both consume one-time state
bound to the browser. Linking requires the original signed-in account and
rejects an identity already belonging to another account. No automatic account
merge is performed. Existing Beacon Google/GitHub sign-in continues to own the
local store; browser approval connects it to the selected hosted account.

### Open the website for launch

Keep the same Access application and audience. Change its covered domains to
only `asip.ca/auth/access`, remove the wildcard, and change its admission policy
to the intended public sign-in audience. Landing, downloads and ASIP token API
then become publicly reachable; `/auth/access` remains the managed sign-in
entry. Account authorization remains enforced by ASIP. Provider web OAuth is
optional when continuing to use Access for sign-in. No website rewrite, data
migration, or release is required to lift the full-domain preview gate.

## Device connection

Beacon opens a browser approval page containing a SHA-256 proof challenge,
random state, computer name, and a temporary loopback callback. The owner sees
the cloud account and the local account, and explicitly approves synchronization
of existing and future history. The callback accepts POST only from the ASIP
origin, with the correct state and loopback Host. It does not put credentials
in URL parameters, fragments, logs, or browser history.

The browser returns a two-minute, single-use code and its preview Access
assertion to Beacon. Redeeming the code requires the original proof verifier.
D1 consumes the code atomically. The resulting device token is random, hashed
on the server, expires after 90 days, and is revocable in the workspace.

Beacon encrypts the device token and Access session using the existing OS
keychain mechanism. A permanently retained local account binding prevents a
local store from subsequently uploading another cloud owner's downloaded
history. The device's token never identifies an account using caller input.

The preview Access session expires according to the gate policy. Beacon shows
an actionable reconnection message and keeps recording locally. Reconnect in
the browser to renew admission. API clients need their scoped ASIP token and,
during private preview, a valid Access cookie.

## Synchronization and integrity

- Local SQLite recording remains the first durable write. It works offline.
- Pushes contain at most 40 records and 512 KiB. Server D1 work stays within
  free-tier per-invocation query limits. Backlogs advance in bounded passes.
- The canonical protocol hashes exactly `id`, `at`, `agent`, `session`, `kind`,
  `project`, `summary`, and `data`, with sorted JSON object keys.
- Private R2 stores the canonical source object under the owning account and
  its content hash. D1 indexes the complete searchable record and source hash.
- Identical retries are idempotent. A different record using the same account
  and ID returns 409. A D1 trigger also protects concurrent conflicting writes;
  the D1 event batch is atomic.
- R2 writes precede D1. Failed batches may leave unreferenced private objects;
  they do not expose a partially committed batch. A later maintenance process
  can collect these objects after proving they are unreferenced.
- Pull uses a monotonically increasing server sequence, independent of device
  clocks. Every record is checked against its hash before a local transaction
  inserts it and advances the durable cursor. Original native times remain
  unchanged. Search pagination follows server ingestion sequence.
- Event IDs, agents, native session IDs, project associations, intent, results,
  failures, and recorded evidence synchronize. Explicit project metadata,
  paths, relationships, and session details also synchronize. Metadata uses
  resumable 30-entry chunks and a conservative local merge. A partial metadata
  refresh is repaired on the next successful pass.
- Named connection metadata synchronizes. Provider credentials, local plugin
  grants, full transcript files, repository contents, OS files, and arbitrary
  referenced attachments are not uploaded.
- A local recovery operation does not delete cloud history. Restoring a local
  checkpoint pauses synchronization and then rescans cloud records. Cloud
  records cannot silently rewrite different local evidence.

History can contain paths and sensitive work. Existing trace redaction remains
in Beacon; it is a best-effort filter, not end-to-end encryption. Cloudflare
infrastructure encryption protects storage in transit and at rest. The account
owner explicitly chooses to synchronize the existing store.

## API and MCP

See the website's `/api` page for request examples. `POST /mcp` implements
stateless Streamable HTTP JSON-RPC with status, project listing, recall, named
connection metadata, and append-only recording tools. GET/SSE is not required
for these tools. Native plugins keep their existing recording and recall paths;
downloaded cloud records become immediately available to their local recall.

Only browser owners can issue or revoke device and API credentials. API
credentials default to read access, can be restricted to a project list, bind
new records to a named agent, and expire after 90 days. Every read endpoint,
source download, relationship query, session query, and MCP call enforces that
account and project scope. Tokens are shown once and stored only as hashes.

## Operations

Apply migrations before the corresponding Worker deployment:

```sh
npx wrangler d1 migrations apply asip-cloud --remote --config cloud/wrangler.jsonc
npx wrangler deploy --config cloud/wrangler.jsonc
```

Use a supported Wrangler login or CI credentials; do not export Beacon's vault.
Worker request logging is disabled because callback and authentication requests
are sensitive. No analytics or advertising tracker is enabled. The landing
page's headline, proof panel and primary CTA are explicit components suitable
for later controlled experiments; record conversion events only after defining
the measurement and privacy policy.

Use D1 Time Travel for database recovery, and export D1 plus private R2 objects
for independent backups. Never delete R2 objects before their D1 references
have been verified. Account deletion, attachment uploads, a garbage collector,
managed backup automation and multi-region database sharding are follow-up work.
The current design uses one D1 database with indexed account boundaries.

## Primary references

- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [D1 transactions through batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
