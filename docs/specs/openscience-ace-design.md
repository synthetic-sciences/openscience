# OpenScience account, traces, and Ace PAYG contract

Status: implementation contract
Prepared: 2026-08-23

## Product in one paragraph

OpenScience requires a free Synthetic Sciences account, but not a paid plan. The installation signs in once and keeps a revocable local account credential so normal launches do not repeat authentication. Users can run their own provider keys, eligible ChatGPT/Codex access, and local models without Ace charges. Ace is a pay-as-you-go managed route: add 20 credits for $20 plus the card-processing fee shown by Stripe, use curated models through OpenRouter, and spend the same Wallet balance on enhanced search. Auto-reload adds 20 credits when Wallet falls below 5 by default. There is no Ace subscription, Ace+, scheduled monthly top-up, hosted Synthetic Scientists entitlement, or resold compute.

## Locked product rules

1. **One free account, one installation credential.** Authentication is required before starting or continuing agent execution. The browser/device sign-in exchanges for a revocable installation-scoped credential cached locally. Ordinary launches reuse it, including while temporarily offline.
2. **One trace per research session.** When **Use my data** is on, OpenScience uploads prompts, assistant and model responses, model requests, tool calls and results, searches, artifacts, retries, errors, and lifecycle events as one linked trace. Credentials are redacted on the client and again at ingestion.
3. **One data toggle.** **Use my data** is on by default after authentication. Turning it off stops queueing and uploading immediately and deletes pending upload rows. Local session history remains available. Account-data deletion removes retained cloud trace rows.
4. **Ace is optional PAYG.** Users purchase 20 Wallet credits at a time. Stripe processing is shown separately and never becomes Wallet credit. No subscription is needed to use Ace.
5. **Auto-reload should disappear into the background.** The first purchase saves the card and, with the checkout consent action, enables a 20-credit reload below 5 credits. Users can change the trigger, amount, and monthly safety limit, or disable reload. No monthly scheduled top-ups are created.
6. **Managed inference is OpenRouter only.** Every Ace model call follows `OpenScience -> Synthetic Sciences Gateway -> OpenRouter`. There is no hidden direct OpenAI, Anthropic, Meta, or other shared-key fallback. Direct provider keys added later are separate user-funded routes unless a new managed-price contract explicitly introduces them.
7. **Credits cover model and enhanced-search spend.** One credit represents one dollar of funded managed spend. Internal settlement uses sub-cent precision. Ace debits actual landed service cost grossed up to a 2% gross margin.
8. **Free search keeps working.** If the managed search route is unavailable, unaffordable, disabled, or not selected, OpenScience uses the community/basic search path. Firecrawl improves eligible searches but is never required for basic product function.
9. **Never resell compute.** Atlas owns no compute marketplace, lease, volume, credential, or execution product. OpenScience still runs local kernels and direct user-owned SSH, scheduler, and Modal workflows without routing credentials or charges through Atlas.
10. **Atlas is not a general LLM job host.** Remove Atlas-owned agent chat, runner, proposal, spawn, Oracle, internal research, managed execution, and unrelated LLM dispatch jobs. Preserve deterministic research maps, repository capture, logs, library indexing/read/search, web search/fetch, and billing/trace infrastructure used by OpenScience.

## Account and routing matrix

| Route                               | Account required | Request path                                  | Billing                    |
| ----------------------------------- | ---------------- | --------------------------------------------- | -------------------------- |
| BYOK                                | Yes              | OpenScience directly to the selected provider | Provider bills the user    |
| ChatGPT/Codex                       | Yes              | Eligible local OAuth route                    | Existing subscription      |
| Local model                         | Yes              | Local OpenAI-compatible endpoint              | User-owned hardware        |
| Ace managed                         | Yes              | Gateway to OpenRouter                         | Ace Wallet                 |
| Community search                    | Yes              | Free/basic search adapters                    | No Wallet debit            |
| Enhanced search                     | Yes              | Gateway-managed provider such as Firecrawl    | Ace Wallet                 |
| Local/SSH/scheduler/Modal execution | Yes              | Direct from OpenScience                       | User-owned compute account |

The account is identity and trace ownership, not an inference proxy. A disabled data toggle does not disable BYOK, ChatGPT/Codex, local, Ace, search, or compute execution.

## Credit and fee accounting

### Public meaning

- `1 credit = $1.00` of funded managed spend.
- A standard purchase adds exactly 20 credits.
- Stripe card-processing cost is a separate checkout line item.
- The initial and auto-reload purchase use the same immutable offer version.
- Wallet means purchased credits only. Promotional balances, when retained for a legacy transition, remain separate and may expire under their original terms.

### Stripe checkout

For the current public schedule:

- Wallet credit: `$20.00`
- Processing schedule: `4.4% + $0.30`, grossed up so the Wallet receives the full funded amount
- Displayed processing fee: `$1.23`
- Checkout total: `$21.23`

The server calculates and returns the offer. The client displays it before checkout and refuses to redirect when the checkout response does not match the reviewed amount or schedule version. Webhooks grant only `wallet_credit_cents`, never `amount_total`.

### Usage settlement

Use integer microcredits internally rather than whole cents. For each authoritative provider operation:

1. Read actual landed cost, including OpenRouter credit-purchase overhead allocated by the active cost schedule.
2. Convert the landed cost to microcredits.
3. Calculate the customer debit as `ceil(landed_cost / 0.98)` at microcredit precision.
4. Settle one idempotent hold against the exact provider operation id.
5. Store landed cost, customer debit, margin, route, model/service, schedule version, and source request id in the immutable usage audit.

Sub-cent usage is accumulated precisely. No successful call becomes free because it rounded below one cent. Failed or unbilled upstream operations release their hold and do not debit Wallet.

## Search behavior

Search has two quality levels, not two product modes the user must manage:

1. OpenScience attempts enhanced search when the signed-in account has enough Wallet balance and the managed provider is healthy.
2. The Gateway reserves a bounded hold before the paid provider call and settles actual landed cost afterward.
3. If admission fails before a paid call, OpenScience transparently uses community search.
4. If a paid call begins, retries use the same durable operation id so one user action cannot be charged twice.
5. Basic scientific connectors and direct fetches remain available without Firecrawl.

Public copy says the Wallet covers managed models and enhanced search. It does not promise a separate search-credit quota.

## Trace contract

### Consent

Consent version: `openscience-trace-v2-2026-08-23`.

The account API exposes one effective boolean. For compatibility, it stores both `analytics_enabled` and `research_content_enabled` with identical values after an explicit v2 choice. Existing explicit analytics opt-outs remain off. Existing analytics-only opt-ins are not silently reinterpreted as permission to retain prompts and responses; they remain off for v2 traces until the user sees and chooses the new setting. New authenticated accounts receive the disclosed default-on v2 setting. Installation opt-out records remain content-free and prevent a stale sender from silently resuming.

### Event envelope

Every v2 event includes:

- `event_id`, `schema_version: 2`, `event_type`, and `occurred_at`
- `trace_id`, `span_id`, and optional `parent_span_id`
- installation, session, and run identifiers where available
- app, platform, model route, provider, and model identifiers where relevant
- a recursively structured `payload` containing the trajectory content

Supported event families are session start/end, user and assistant messages, model request/response, tool start/completion/failure/cancellation, search start/completion/failure, artifact completion, retry, and error.

The client never supplies `account_id`. Atlas authenticates the request and binds every event to the current account. Event ids are idempotent within that account. Raw events currently expire after 30 days; account deletion removes raw events and aggregates immediately and leaves a durable opt-out.

### Redaction and bounds

- Redact authorization headers, cookies, API keys, tokens, passwords, private keys, and recognized credential strings on both client and server.
- Preserve ordinary prompts, outputs, paths, tool arguments, tool results, and error text.
- Reject unknown top-level fields, unknown event types, invalid identifiers, oversized batches, malformed compression, and account identity supplied by the client.
- Never use trace data as an authoritative billing source.

## PAYG API contract

### `GET /api/credits/wallet-offer`

Returns one authenticated, versioned offer:

```json
{
  "product": "ace",
  "product_version": "ace-payg-2026-08-23",
  "currency": "usd",
  "credit_unit_cents": 100,
  "wallet_credit_cents": 2000,
  "processing_fee_cents": 123,
  "total_cents": 2123,
  "processing_fee": {
    "rate_bps": 440,
    "fixed_cents": 30,
    "formula": "gross_up_round_half_up",
    "schedule_version": "ace-payg-processing-2026-08-23"
  },
  "auto_reload": {
    "enabled_by_default": true,
    "threshold_cents": 500,
    "amount_cents": 2000,
    "monthly_cap_cents": 10000,
    "currency": "usd",
    "terms_version": "ace-auto-reload-2026-08-23"
  },
  "legacy_subscription": null
}
```

An account with an old active subscription receives a compact `legacy_subscription` descriptor so Billing can offer Stripe management without advertising a second checkout.

### `POST /api/credits/purchase`

Accepts the versioned auto-reload consent and the standard 2,000-cent Wallet amount. Checkout is card-only, saves the payment method for later off-session reloads, and returns to `/billing?topup=success` or `/billing?topup=cancelled`.

The response repeats the exact Wallet amount, processing fee, total, and schedule version. The browser verifies those values before redirecting.

### Compatibility endpoints

- New calls to `/api/credits/subscribe` return `410 Gone` with a PAYG migration code.
- `/api/credits/plans` remains readable for older clients during the transition but advertises no new subscription sale.
- `/api/cli/topup` and `/api/cli/topup-subscriptions` are retired. Historical
  schedule rows remain available only to audited operator reconciliation.
- The Stripe portal remains available for legacy subscriptions and payment-method management.

## Legacy transition

The transition is additive and auditable:

1. Stop all new Ace, Ace+, Pro, and Max subscription checkout creation.
2. Inventory current Stripe subscriptions in dry-run mode and reconcile each to its account.
3. Schedule recognized legacy subscriptions to cancel at period end. Do not silently reprice, refund, or recreate them.
4. Honor the already-paid period and preserve purchased Wallet credits.
5. Keep the Stripe customer and saved payment method so an eligible existing auto-reload policy can continue under its recorded consent; otherwise ask for consent on the next 20-credit purchase.
6. Stop renewal grants and promotional quota after the recorded period ends.
7. Record every planned/applied transition with account, subscription, prior state, target period end, actor, and idempotency key.

No production mutation happens from a schema migration. Stripe transition uses an explicit plan/apply operator action with exact-release verification.

## Removal boundaries

### Remove from Atlas

- compute providers, leases, volumes, provider credentials, billing, and operator surfaces
- managed execution APIs and `exec:*` CLI commands
- hosted agent sessions, proposals, spawns, runners, internal agent telemetry, Oracle, PM, deep-research LLM jobs, run-audit LLM jobs, and unrelated LLM dispatch
- frontend navigation, stores, pages, docs, release checks, and environment variables that imply Atlas resells compute or hosts general LLM jobs

Historical database tables are not dropped in this release. Add decommission markers, stop all writes, remove live routes/workers, and retain rows for audit and rollback.

### Preserve in Atlas

- accounts, API keys, Wallet and billing, OpenRouter proxy, enhanced search, and session-trace ingest
- research graph CRUD, private ownership/access, repo capture, logs, evidence, deterministic map operations
- library source indexing/read/grep/tree/search and basic web search/fetch

### Preserve in OpenScience

- persistent local Python/R kernels
- local jobs and direct user-owned SSH, Slurm/scheduler, and Modal execution
- BYOK, ChatGPT/Codex, local models, scientific tools, and basic search

Remove only the obsolete managed-compute purchase/billing toggle and any wording that sends compute credentials or charges through Atlas.

## Release gates

Before push:

- migrations pass on clean SQLite and PostgreSQL parity checks
- PAYG purchase, webhook idempotency, auto-reload, processing fee, microcredit settlement, and legacy transition tests pass
- managed model tests prove OpenRouter is the only shared-key route
- free and enhanced search tests prove graceful fallback and exact-once settlement
- telemetry tests prove authentication, default-on consent, opt-out purge, full trajectory preservation, double redaction, replay handling, retention, and deletion
- account-gate tests cover first sign-in, cached relaunch, offline cached use, revoked credentials, SPA routes, HTTP execution, and websockets
- source searches find no live Atlas compute, managed execution, internal agent/Oracle, Ace+, subscription-sale, or Synthetic Scientists entitlement surface
- OpenScience local kernel and direct user-owned compute suites remain green
- frontend typecheck/build, backend full tests, CLI tests, docs build, formatting, and migration parity are green

Production rollout order:

1. Deploy additive database changes and trace v2 ingest behind exact-release checks.
2. Deploy Atlas PAYG routes and OpenRouter/search accounting with new subscription sales disabled.
3. Deploy the OpenScience account gate and trace client.
4. Run Stripe legacy-transition plan, review counts, then apply explicitly.
5. Verify one BYOK session, one ChatGPT/Codex session, one local-model session, one Ace model call, one free-search fallback, one enhanced search, one reload, one data opt-out, and one direct user-owned compute job.
6. Remove compatibility readers only after supported installed clients have moved to PAYG.
