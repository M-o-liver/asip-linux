# Accounts, billing, and web interface

[Cloud architecture](README.md) owns identity/session mechanics, synchronization,
API scope, and deployment. This guide covers hosted entitlement and the customer
interface implemented by [billing.mjs](src/billing.mjs),
[worker.mjs](src/worker.mjs), and [public/](public/).

## Configuration

[wrangler.jsonc](wrangler.jsonc) owns public client IDs, `ORIGIN`,
`BILLING_ENFORCED`, the configured Stripe price and portal, and the download
`RELEASE_TAG`. Google desktop sign-in is a separate registration from Google web
sign-in. Worker secrets are:

| Provider   | Public variable                                                     | Secret                                       | Callback                                   |
| ---------- | ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| Google web | `GOOGLE_WEB_CLIENT_ID`                                              | `GOOGLE_WEB_CLIENT_SECRET`                   | `https://asip.ca/auth/google/callback`     |
| GitHub web | `GITHUB_CLIENT_ID`                                                  | `GITHUB_CLIENT_SECRET`                       | `https://asip.ca/auth/github/callback`     |
| Stripe     | `STRIPE_PRICE_ID`, `STRIPE_LIVEMODE`, `STRIPE_PORTAL_CONFIGURATION` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `POST https://asip.ca/api/billing/webhook` |

`GET /api/config` reports configured provider availability, billing availability,
trial duration, and the price used by the UI. The repository's configured price
and code validation require **CA$12 per month** (`1200` CAD minor units).
Changing a Stripe environment value alone cannot change the accepted amount:
checkout validation, configuration responses, and customer copy must agree.
Production configuration and payment authorization are separate from a source edit.

## Entitlements

`ensureTrial` creates one seven-day trial per new hosted account. Repeated
sign-in preserves its dates. Migration [0005_saas.sql](migrations/0005_saas.sql)
preserves existing accounts as founders.

Access is allowed for founders, an unexpired trial without a subscription, or a
current `active`/`trialing` subscription whose period has not ended. With billing
enforcement enabled, expiry blocks hosted memory, MCP, and sync. Account details,
billing management, device listing, and credential revocation remain reachable.
History is retained; local Beacon recording continues.

Explicitly linked provider identities share the hosted account's entitlement.
Matching emails alone establish no link. Local sign-in and cloud account linking
remain separate operations.

## Checkout and reconciliation

Checkout uses the server-configured price and account-bound Stripe customer.
It validates the upstream currency, amount, monthly interval, and live/test mode.
Customer creation is idempotent; pending Checkout sessions are reused. Existing
subscriptions are managed through the portal. Trial carryover observes Stripe's
minimum Checkout trial duration, which can extend the final two days to at least
48 hours. The portal supports payment details, invoices, and period-end cancellation.

A success redirect grants no entitlement. Signed webhooks or authenticated
billing refresh retrieve current Stripe subscriptions and reconcile account,
customer, price, mode, status, and period end. The recognized prices include the
configured price and optional `STRIPE_LEGACY_PRICE_IDS`; an allowlist preserves
recognized existing subscriptions rather than creating a new checkout plan.
Provider requests use Stripe API version `2025-08-27.basil`.

The webhook handles `checkout.session.completed` and subscription
`created`, `updated`, and `deleted` events. It verifies HMAC-SHA-256 over the
original body with five-minute timestamp tolerance and records processed event
IDs. Retrieving current subscription state protects against out-of-order events.

[billing.test.mjs](../tests/billing.test.mjs) covers trials, founders, expiry,
Checkout reuse, entitlement reconciliation, and webhook integrity/replay. Fixture
success and an unpaid live Checkout do not establish a completed paid transaction;
actual observations are dated in [qualification history](../QUALIFICATION.md).

## Web interface

The static [landing page](public/index.html) explains the product without
JavaScript. The authenticated [workspace](public/workspace.html) loads
[interface.js](public/assets/interface.js), with shared rendering in
[shell.js](public/assets/shell.js). Projects, Memory, and Agents & computers are
primary views; account actions expose API connections, evidence, recovery, and
billing. The current consumer styles are in
[app-consumer.css](public/assets/app-consumer.css).

The workspace prioritizes saved work and continuing a project. Empty accounts
show setup steps based on observed device grants and records. Download clicks
establish neither capture nor activation. Copy continuation prompt includes the
project identity. Copy handoff notes exports up to eight visible records with
source IDs and a reminder to verify current state.

Recent activity and valid device grants describe observed history and
authorization, rather than a device heartbeat. Explicit refresh and page-local
request caching control repeated cloud reads. Beacon owns uploads and reports
its local/connected/syncing/attention state through
[continuity.js](../beacon/continuity.js). Source evidence can be downloaded and
checked against its hash. Cloud recovery directs users to local Beacon checkpoints.

For verification, run `npm run test:cloud`, `npm run check:format`, and
`npm run cloud:build` from the product root. See the cloud guide for migration,
deployment, and rollback procedures. [Qualification history](../QUALIFICATION.md)
keeps dated browser, native-device, provider, and release evidence.
