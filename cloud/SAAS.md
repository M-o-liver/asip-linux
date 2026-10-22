# ASIP Cloud SaaS

The public front door, authenticated workspace, device protocol, and billing run
in the existing `asip-cloud` Worker at **https://asip.ca**. D1 and private R2 keep
the existing account and evidence boundaries. No history is replaced by the UI.

## Access

New provider accounts receive one seven-day trial at first account creation,
without a card. Repeated sign-in does not reset it. Accounts present when
`0005_saas.sql` is applied retain founder access. Account handles are addresses,
not authorization identities. Google and GitHub identities are linked explicitly
in Account & API access; matching email addresses never silently merge accounts.

After expiry, HTTP memory access, MCP, and device synchronization require an
active subscription. Account information, subscription management, device listing,
and credential revocation remain reachable. Records are retained. Beacon keeps
recording locally. A subscription does not change source hashes or local history.

The apex `asip.ca` is public. The Access application named **ASIP private
subdomains** still covers `*.asip.ca` with its original allowlist. The separate
restricted Access application at `/auth/access` remains for existing preview
owners, with its independent audience and original admission policy. Public
sign-in uses the provider OAuth routes, not a public Everyone rule on this owner
fallback.

## Identity configuration

Public IDs are in `wrangler.jsonc`; secrets stay in Cloudflare:

| Provider          | Worker ID variable     | Worker secret              | Registered callback                    |
| ----------------- | ---------------------- | -------------------------- | -------------------------------------- |
| GitHub            | `GITHUB_CLIENT_ID`     | `GITHUB_CLIENT_SECRET`     | `https://asip.ca/auth/github/callback` |
| Google web client | `GOOGLE_WEB_CLIENT_ID` | `GOOGLE_WEB_CLIENT_SECRET` | `https://asip.ca/auth/google/callback` |

The Google desktop client is a separate Beacon registration. It cannot replace
the web client. The web origin is `https://asip.ca`; its authorized domain is
`asip.ca`. Google app branding links to `/privacy`. OAuth uses browser-bound,
single-use state and PKCE for both providers. Google also verifies nonce and the
signed ID token. Explicit linking requires the same owner browser session at
both ends. Provider access tokens are used for identity lookup and not retained.
Provider requests use `redirect: "manual"` and reject non-success status codes.
Workers does not support `redirect: "error"`; the runtime integration test
exercises a full GitHub callback and Stripe price request, including redirected
provider responses. Unexpected OAuth errors log only the provider, error class,
and stack frames, excluding credentials, codes, response bodies, and messages.

Wrangler `keep_vars` preserves dashboard-managed configuration. Do not copy
Beacon's connection vault or local sign-in files into deployment scripts.

## Billing

The approved plan is **CA$12/month** (`1200` minor units, CAD).

- Product: `asip_cloud`.
- Live price: `price_1UTSI8KdcVQu3gvV4Hk3WBja`.
- Live webhook: `we_1UTSVVKdcVQu3gvVTYLvXY3q`.
- Portal configuration: `bpc_1UTSVlKdcVQu3gvVLnMDJ4K8`.
- Worker secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Public callback: `POST https://asip.ca/api/billing/webhook`.
- Events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`.
- Stripe request version: `2025-08-27.basil`.

Checkout uses only the configured server-side price and account-bound customer.
Before checkout, ASIP verifies the live price is exactly CAD 1200 per month.
An explicit billing refresh also checks the upstream connection and plan.
Pending Checkout sessions are reused, customer creation is idempotent, and an
existing live subscription must be managed in the portal. Trial time carries
into an early subscription checkout; Stripe's minimum Checkout trial duration
can extend the final two days to at least 48 hours. Stripe shows the exact first
charge date before subscription confirmation. The portal supports payment method
updates, invoices, and cancellation at the end of the current period.

A success redirect grants no access. Billing state comes from a signed webhook
or an authenticated refresh that retrieves current Stripe subscriptions. The
current customer, account metadata, price, live/test mode, status, and period end
must match. Reading current state avoids out-of-order cancellation/update events
overwriting a newer subscription. Webhooks verify HMAC-SHA-256 over the original
body with a five-minute timestamp tolerance and persist processed event IDs.

The launch qualification opened live Checkout and the portal from a real new
trial account. The unpaid Checkout was expired without creating a subscription
or charging a card. See `QUALIFICATION.md` for the distinction between those live
observations and automated paid-state/webhook fixtures.

## Interface

`assets/interface.js` and `shell.js` serve the login and authenticated surfaces.
Overview, Projects, Agents, Connections, Evidence, Recovery, Account, and Billing
share the obsidian/gold/sage system in `interface.css`. Dynamic user content uses
text nodes. The supplied visual reference informed the exact three-column hero,
continuity globe, status strip, activity rail, lower panels, and device diagram.
Raster art contains no application text or fabricated statistics.

The globe and atmospheric assets were created with the built-in image generation
tool from the owner's reference, then extracted and optimized as
`assets/continuity.webp` and `assets/nebula.webp`. Prompt: reconstruct only the
central obsidian terrestrial globe, antique gold rim and orbital paths, pale sage
nodes, dark mineral nebula, and fine gold dust; no text, labels, icons, cards, or
controls. All interface text and data are real HTML.

Overview uses the existing incremental R2 activity index. No background polling
is added. Page-local request caching and explicit refresh avoid repeated reads.
“Refresh memory” retrieves cloud state; Beacon controls device uploads. Recent
agent activity is marked Recent or Recorded rather than claiming a heartbeat.
Evidence can be downloaded and independently checked against its source hash.
Recovery directs local checkpoint restoration to Beacon; it does not claim to
restore working trees or operating systems from cloud history.

## Qualify and deploy

```sh
npm run test:cloud
npm run check:format
npm run cloud:build
npx wrangler d1 migrations apply asip-cloud --remote --config cloud/wrangler.jsonc
npx wrangler deploy --config cloud/wrangler.jsonc
```

The integration suite covers preserved founders, non-resetting trial dates,
expiry on HTTP/MCP/sync, management access, CSRF, both PKCE starts, account-bound
Checkout, duplicate session reuse, current subscription reconciliation, and
webhook forgery, mutation, mode, and replay handling. Existing isolation, evidence,
device continuity, and D1 read-budget tests remain required.

Keep prior Worker versions for rollback within this SaaS series. A rollback to
the legacy preview app needs a separate review: its positional OAuth state insert
predates the added return column, and it does not enforce subscription access.
Pause new public signups and Checkout before such a downgrade. Do not roll back
by deleting account, billing, event, or R2 history. Check actual provider sign-ins, a real Checkout destination, and public
anonymous reachability separately from emulator and dry-run results. Never claim
a live payment was charged when only Checkout and test fixtures were exercised.
