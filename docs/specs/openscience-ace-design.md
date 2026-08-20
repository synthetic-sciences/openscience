# OpenScience Ace and Gateway implementation plan

Status: approved implementation contract; release candidate
Prepared: 2026-08-20
OpenScience implementation base: `bf29162b8628f29257d90c134308e571ec31d589`
Gateway baseline: `1f23dcb50254d002176a7ff95a58da7b179155d1`

## Simple explanation

OpenScience remains useful without a subscription: desktop, local models, BYOK, ChatGPT/Codex subscription routes, scientific databases, direct file downloads, and the current basic search path keep working.

Ace and Ace+ add an optional managed Gateway. The Gateway holds provider keys, runs managed search, meters included allowances, charges managed model or hosted-research spend against a wallet, and exposes reliable account/admin data. It does not become a dependency for local or user-funded work.

The public product is called **Gateway**. The OpenScience landing page becomes shorter and adds clear Free, Ace, Ace+, and Teams pricing. The application keeps **Install** and private **Graphs** as its primary product surfaces; Compute and public graph discovery remain implemented but unavailable until intentionally launched.

## 1. Locked product principles

1. **Paid plans add managed services; they do not remove existing capabilities.** A Gateway outage, canceled subscription, exhausted search allowance, or empty wallet must not break local models, BYOK, ChatGPT/Codex subscription routes, scientific connectors, or `WebFetch`.
2. **Inference route and subscription are independent.** An Ace user can use managed models, BYOK, ChatGPT/Codex, or local models and still use their managed-search allowance.
3. **Only the Gateway can create billable usage.** Client telemetry, local token counts, BYOK activity, and ChatGPT/Codex activity are analytics only and can never debit a wallet.
4. **One visible search meter.** Customers see completed managed searches, not Firecrawl credits, page-read counters, paper-operation counters, or “research units.”
5. **Content-free analytics by default.** Structural usage sharing is on by default and disableable. Research content sharing is a separate opt-in that is off by default.
6. **Gateway is the only public service name.** Legacy route, package, database, and executable identifiers remain temporarily where renaming would break installed clients, but they do not appear in product copy.
7. **Unshipped benefits are labeled.** Managed web, team collaboration, and compliance claims remain “coming soon” until the actual capability and operational contract exist.
8. **No destructive production cleanup.** Reconcile, archive, migrate, and verify first. Delete only after ownership and retention rules are proven.

## 2. Plans and entitlements

| Plan  |      Price |                                                        Credits |                                                                      Managed search | Included access                                                                                                                                                            |
| ----- | ---------: | -------------------------------------------------------------: | ----------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free  |         $0 |                                                           None | Preserve the current community/basic path with its existing availability and limits | Open-source desktop/local runtime, BYOK, ChatGPT/Codex routes, local models, scientific connectors, `WebFetch`, local traces, and owned/private graphs when signed in      |
| Ace   |  $20/month |                   20 purchased credits each successful renewal |                            1,000 completed managed searches per subscription period | Hosted Synthetic Scientists access, one hosted run at a time, Gateway search, standard support, managed web when shipped                                                   |
| Ace+  | $100/month | 150 advertised monthly credits: 100 purchased + 50 promotional |                            5,000 completed managed searches per subscription period | Hosted Synthetic Scientists access, three hosted runs at a time, priority support, early access, higher managed-service limits, collaboration and managed web when shipped |
| Teams |   Contract |                                                     Contracted |                                                                          Contracted | Organization billing, SSO/admin, multi-user controls, contracted ZDR provider routes, private/on-prem data and cluster integrations, dedicated support and SLA options     |

### 2.1 Credit semantics

- One credit represents `$1` of managed-spend value.
- Purchased credits are non-expiring while the account remains legally operable, non-transferable, non-withdrawable, and consumed after promotional credits.
- Ace+'s 50 promotional credits expire at the end of the subscription period, do not roll over, and may be restricted to approved Gateway services. Pricing copy must say this plainly.
- Search allowances reset on the Stripe subscription period, do not roll over, and cannot be converted to wallet value.
- Managed model and hosted-research spend is provider cost plus a disclosed 5% service fee. Stripe processing is absorbed by Synthetic Sciences and adds no checkout fee.
- Hosted Synthetic Scientists membership is an entitlement, not unlimited compute. Provider/model/compute spend still consumes wallet credits. Local or user-funded execution remains independent of the paid entitlement.
- Canceling ends plan entitlements and unused search allowance at period end. Purchased wallet credits remain available for eligible managed usage; promotional credits expire under their stated terms.

### 2.2 Education and legacy subscribers

- A verified `.edu` account receives 50% off the first month only: Ace `$10`, Ace+ `$50`.
- Verify mailbox ownership server-side and allow one education redemption per person, billing customer, and payment instrument. Log manual overrides.
- The discounted first month grants the normal plan deposit and allowance; record the difference as a marketing subsidy.
- Public plan identifiers become `ace` and `ace_plus`.
- The compatibility resolver continues accepting existing `starter` and `pro` identifiers, checkout links, subscription metadata, and webhooks.
- Extend the current Billing client, `account.ts` checkout types, `credits.py` plan lookup, and webhook price resolver to accept `ace|ace_plus`. Map every Stripe Price ID to an immutable catalog version; resolve `starter|pro` as legacy aliases rather than repricing them.
- Existing `$50` Pro subscriptions are grandfathered. Do not silently reprice or recreate them. They keep their recorded benefits until the customer explicitly changes plan.
- New subscriptions use new versioned Stripe Prices. Never mutate a live Stripe Price in place.

## 3. Non-subscriber compatibility contract

| Capability                         | Free / no active plan                        | Ace / Ace+                                     |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Desktop and local runtime          | Unchanged                                    | Unchanged                                      |
| BYOK providers                     | Unchanged; no Gateway wallet charge          | Unchanged; no Gateway wallet charge            |
| ChatGPT/Codex subscription routes  | Unchanged; no Gateway wallet charge          | Unchanged; no Gateway wallet charge            |
| Local models                       | Unchanged                                    | Unchanged                                      |
| `science_search` / `science_fetch` | Unchanged                                    | Unchanged                                      |
| `WebFetch` and workspace downloads | Unchanged                                    | Unchanged                                      |
| Web search                         | Preserved community/basic implementation     | Managed Gateway search with included allowance |
| Local run history                  | Full local trace                             | Full local trace                               |
| Shared analytics                   | Default on, disableable                      | Default on, disableable                        |
| Graphs                             | Owned and explicitly shared private graphs   | Same                                           |
| Hosted Synthetic Scientists        | Not included; local/user-funded paths remain | Membership entitlement; spend still metered    |

Compatibility rules:

- Register one canonical `research_search` capability independent of the selected model provider.
- Advertise only `research_search` to new model contexts. Resolve persisted `websearch` calls through `ToolRegistry.compatibility`, normalize legacy arguments before deduplication/metering, and categorize both IDs as search during migration.
- Preserve the existing `websearch` permission identity initially so current allow/deny rules remain effective; introduce a permission alias/migration before changing that stored permission name.
- An entitled account routes `research_search` through the Gateway.
- Resolve entitlement inside tool execution from cached account state, then confirm it server-side at dispatch. Do not perform network entitlement lookup while constructing the tool registry.
- A non-entitled account routes through the preserved community/basic implementation only where the current provider/feature-flag rule already enables it; this plan does not promise universal anonymous search.
- If that community provider is unavailable, return a completed structured `search_unavailable` tool result with direct scientific connectors and `WebFetch` as alternatives. Do not throw an opaque error that the agent may retry.
- Search exhaustion returns a completed structured `search_allowance_exhausted` tool result with the reset date and upgrade link. It must not affect any other tool.
- Search never spends wallet credits and never triggers auto-reload.
- Do not silently change provider or privacy mode when the requested route is unavailable.
- Existing local configuration, permissions, session history, and deduplication for `websearch` continue to resolve.

Routing:

```text
research_search
  ├─ active Ace/Ace+ entitlement ──> Gateway managed search
  ├─ Free / no entitlement ────────> existing community/basic search
  └─ community route unavailable ──> typed error; science tools and WebFetch continue
```

## 4. Managed research search

### 4.1 Customer contract

- Ace includes **1,000 completed managed searches** per Stripe subscription period.
- Ace+ includes **5,000 completed managed searches** per Stripe subscription period.
- One completed top-level `research_search` request consumes one search, regardless of whether it searches the web, news, developer sources, or research sources.
- A response with usable partial results counts once and identifies the partial failure.
- Validation, authentication, pre-dispatch, and provider failures consume zero.
- An exact idempotent replay never consumes a second search. Existing same-session `SearchDedupe` reuse is a local replay and executes no Gateway operation.
- A new Gateway operation may receive a provider/Gateway cache hit and still consumes one search; caching is an implementation detail, not a different product. Query equality is never the idempotency key.
- One search returns at most ten results. Full-result enrichment is bounded to the top results selected by server policy.
- There is no search wallet overage in the first release. Exhaustion waits for reset or plan upgrade.

### 4.2 Model-facing tool

```ts
research_search({
  query: string,                       // 2..500 characters
  source?: "web" | "research" | "news" | "developer",
  mode?: "fast" | "balanced" | "deep",
  limit?: number,                      // 1..10, default 8
  content?: "snippets" | "top",
  include_domains?: string[],          // hostnames only, max 20
  exclude_domains?: string[],          // mutually exclusive with include_domains
  published_after?: "YYYY-MM-DD",
  published_before?: "YYYY-MM-DD"
})
```

The normalized result contains stable result IDs, title, URL, source/category, date when known, bounded snippet/content, citation identifiers when known, warnings, cache/freshness information, and remaining allowance. Provider-native fields, keys, job IDs, and cost data stay server-side.

`deep` means bounded Gateway orchestration. It may enrich a small number of top results; it does not expose a provider's autonomous agent, browser, crawl, or arbitrary extraction surface.

### 4.3 Firecrawl integration

- Implement a provider-neutral `ResearchSearchProvider` interface in the Gateway. Firecrawl is the first provider; the OpenScience client never imports its SDK or sees its key.
- Use Firecrawl's documented `POST /v2/search` for web/news and `categories: ["research"]` for academic discovery. Developer search can use the GitHub category where appropriate.
- Request titles, descriptions, URLs, and bounded snippets by default. Only `content: "top"` may request bounded Markdown for a small number of top results.
- Preserve `WebFetch` as the free, permissioned reader/downloader for a known URL. Managed search discovers sources; it does not replace deterministic downloads.
- Do not expose Crawl, Map, Agent, Browser/Interact, uploads, screenshots, actions, custom headers/cookies, persistent sessions, TLS bypass, private-network access, or arbitrary JSON extraction.
- Treat all retrieved content as untrusted evidence. It cannot authorize tool calls, select new outbound targets, override instructions, or reveal credentials.
- Keep staging and production Firecrawl keys separate, server-only, and subject to daily/monthly spend caps and circuit breakers.
- Obtain written authorization for bundled multi-tenant commercial use and record the applicable DPA, subprocessors, retention, incident, support, and rate terms before customer traffic.
- Teams ZDR is a separately contracted provider route. Do not market standard Gateway search as ZDR.

Official implementation references:

- Firecrawl search endpoint: <https://docs.firecrawl.dev/api-reference/endpoint/search>
- Firecrawl v2 API surface: <https://docs.firecrawl.dev/api-reference/v2-introduction>

### 4.4 Reservation and settlement

Use one durable operation per top-level search:

```text
validate entitlement and request
  → create idempotent operation
  → atomically reserve one allowance
  → release database connection
  → call provider
  → complete: settle one search and store operational facts
  → pre-dispatch failure: release reservation
  → ambiguous provider outcome: mark unknown and reconcile; do not blindly resend
```

- Unique key: `(account_id, subscription_period_id, durable_operation_id)`. The operation ID comes from the client call, not from query equality.
- Do not hold a database connection during provider work.
- Record endpoint class, provider request ID, provider credits used, latency, cache status, attempts, normalized error class, and terminal state without query/result content.
- Retry only bounded transient failures and honor `Retry-After`.
- Circuit-break on invalid credentials, provider payment/capacity failure, sustained rate limiting, reconciliation drift, or exhausted global reserve.
- Raw search queries and result bodies are not written to analytics or project history by default. Explicit “Save to project” is the only durable research-content action.

### 4.5 Search UI states

- Available: show searches remaining and reset date in the Research Tools popup and Billing page.
- Near limit: show a non-blocking warning at 80% and 95%.
- Exhausted: show reset date, plan upgrade, and free alternatives; never show a generic provider error.
- Provider degraded: show retry availability and preserve the reservation correctly.
- Free path: label it “Community search” and avoid implying a contractual allowance.
- Privacy: state that managed-search queries are sent to the Gateway and search provider; routine analytics does not retain query text.

## 5. Subscription, wallet, and auto-reload

### 5.1 Financial model

- Price provider usage in integer micro-USD. Never use floating-point currency. During migration, add versioned micro-USD cost/fee fields to managed operations and perform one explicit rounded conversion into the existing cents wallet ledger; do not mix unlabeled cent and micro-USD values. A later full-ledger unit migration requires its own reconciliation.
- Use an append-only wallet ledger with separate buckets for purchased and promotional credits.
- Maintain immutable `price_schedule_version` and `fee_schedule_version` on every charge.
- Reserve before managed model/compute work; settle actual server-observed provider usage; release the difference.
- Provider acceptance with an unknown outcome becomes `unknown` and is reconciled. Never dispatch the same paid request again without knowing whether it ran.
- Apply the 5% service fee in authoritative Gateway hold/settlement pricing. Store provider cost and service fee separately under one price-schedule version.
- The managed proxy's server-side hold/settlement path becomes the sole debit authority. The client completion report never creates a second debit.
- Cut over in stages: make `/api/cli/usage` a non-financial compatibility/analytics acknowledgement; stop its billing retry queue and `modelBlocked` dependency only after clients use proxy responses/account state; reconcile its historical zero-value markers; then remove its debit code. Prove one managed request produces exactly one wallet debit throughout the transition.
- Refunds, disputes, expirations, grants, and corrections are new ledger entries, never row rewrites.

### 5.2 Subscription state

- Stripe webhook events are verified over the raw body, stored by event ID, and applied idempotently.
- The subscription state machine covers checkout pending, trialing, active, past due, canceled-at-period-end, canceled, unpaid, refunded, and disputed.
- A successful renewal deposits credits once and creates one search period tied to Stripe's period boundaries.
- Duplicate or reordered webhooks cannot duplicate a credit grant or allowance.
- A short, explicit grace state may preserve membership access after payment failure; it deposits no new credits.
- Canceling disables plan-linked auto-reload at period end. One-time top-ups remain available.

### 5.3 Auto-reload

- New Ace checkout presents auto-reload selected: reload `$20` when purchased balance falls below `$5`; default monthly cap `$100`.
- New Ace+ checkout presents auto-reload selected: reload `$100` when purchased balance falls below `$20`; default monthly cap `$500`.
- Users can turn it off or lower the cap before checkout and at any time in Billing.
- The final checkout action records off-session payment consent, threshold, amount, cap, currency, fee schedule, terms version, timestamp, and actor.
- Existing users remain off until they explicitly pass through this consent flow.
- Trigger checks run after authoritative wallet settlement, under an account lock. Concurrent requests can create only one PaymentIntent for the same threshold crossing.
- Auto-reload affects spend credits only. It never runs because search allowance is low or exhausted.
- Failed reloads do not loop. Notify once, apply bounded retry policy, and leave research routes that do not require wallet spend available.

## 6. Trace logging and observability

### 6.1 Three separate layers

1. **Local trace:** the existing full local session/run history used for continuity, artifacts, recovery, and debugging.
2. **Shared usage analytics:** default on, content-free, disableable, and available across managed, BYOK, ChatGPT/Codex, and local routes.
3. **Research-content improvement:** a separate explicit opt-in, off by default, with per-upload preview and deletion controls.

Do not reuse provider OpenTelemetry spans, the existing research tracer, or the billable usage endpoint as the analytics contract.

The data-sharing switch must cover every OpenScience-controlled remote analytics emitter. Gate the current AI-SDK experimental telemetry behind the same consent or keep it disabled. Treat landing-site analytics as a separate website analytics boundary with its own disclosure/consent control; do not claim the in-app switch controls a browser session on the public website.

### 6.2 Shared event allowlist

Allowed fields:

- event ID, schema version, event type, occurred-at time;
- app version, platform, architecture, coarse locale/timezone;
- rotating installation ID and account ID when signed in;
- session/run pseudonym, model route, provider family, model family;
- input/output/cached/reasoning token counts when actually available;
- tool name, duration, success/cancel/retry, normalized error class;
- artifact type/count and coarse size bucket;
- search source/mode/result count and allowance state, never query text;
- feature funnel events and plan/entitlement state;
- managed request ID only when needed to join authoritative Gateway usage.

Explicitly prohibited:

- prompts, responses, hidden reasoning, tool inputs or outputs;
- query text, result titles/snippets, URLs, filenames, paths, code, shell commands;
- file contents, notebooks, images, credentials, tokens, cookies, headers;
- raw provider errors or arbitrary metadata blobs.

If a provider does not report token counts, store `null`; do not invent an estimate and present it as observed usage.

### 6.3 Client and ingestion behavior

- Add a versioned allowlist event builder at the session, tool, search, artifact, and billing boundaries.
- Build observed token/route events from the completed assistant-step boundary. Never serialize the local `SessionTrace` object: it intentionally contains paths, queries, hashes, and raw diagnostic fields. Keep the existing `SessionTelemetry` bus local and create a separate strict outbound envelope.
- Redact on the client, then validate the allowlist again on the server. Reject unknown fields rather than storing arbitrary JSON.
- Batch and compress uploads. Keep a small account-bound local queue with size/age limits; telemetry loss is acceptable and never blocks research.
- Never flush events recorded under one account while a different account is active.
- Signed-out activity uses a rotating pseudonymous installation ID. Signing in links only future events unless the user accepts linkage.
- The Settings toggle and first-run disclosure say exactly what is shared.
- Opt-out stops new uploads immediately, deletes the unsent queue, rotates the installation ID, and offers deletion of account-linked analytics.
- Store consent in a dedicated versioned record with atomic replace writes, not only the general preferences JSON. An absent record means the disclosed default-on state; an unreadable/corrupt record always fails closed with sharing off. Define account consent as authoritative when signed in, local-install consent when signed out, and never upload a prior account's queue after account switching.
- Service outage drops or defers analytics; it does not retry indefinitely or interrupt a session.
- Arbitrary activity outside OpenScience is not observable. Other clients are covered only if they intentionally use an OpenScience SDK/logger or Gateway.

### 6.4 Retention and access

- Raw content-free events: short fixed retention sufficient for debugging and aggregation.
- Daily/weekly aggregates: longer retention with no event payload.
- Consent history, deletion requests, and admin audit: retained under their legal/operational policy.
- Support staff see aggregates and structured account state, not research content.
- Research-content improvement uploads live in a separate store, separate consent table, separate access role, and separate deletion path.

## 7. Supabase cleanup and security

### 7.1 Immediate containment

- Rotate and revoke the two plaintext `thk` credentials found in production; do not merely encrypt the exposed values.
- Inventory every production table, function, trigger, policy, bucket, extension, scheduled job, and live-only object. Assign an owner and retention rule.
- Capture every retained object in versioned migrations before cleanup.
- Freeze new ad hoc production schema changes outside migrations.

### 7.2 Schema and data ownership

Organize retained data by responsibility where practical:

- `public`: user/account profile and safe client-facing views;
- `billing`: plans, subscriptions, wallets, ledger, holds, search periods, Stripe events;
- `telemetry`: consent, installations, events, aggregates, deletion requests;
- `admin`: roles, support actions, configuration history, audit;
- `private`: encrypted provider credentials, reconciliation state, internal operations.

Keep exact legacy table names during staged migration where renaming would risk production data. Expose new views/contracts first, backfill, switch readers, then retire aliases.

### 7.3 Access controls

- Default-deny RLS on every user/account-scoped table and storage bucket.
- Test owner, collaborator, support, finance, security, and anonymous access separately.
- Use least-privilege backend roles per service. Do not use the Supabase service role as a general application credential.
- Keep secrets in deployment secret storage/KMS, not ordinary tables or client config.
- Encrypt retained user provider credentials with key versioning and rotation. Never log decrypted values.
- Admin access is server-authorized, requires MFA `aal2`, and cannot rely on a frontend flag.
- Add CI checks for missing RLS, security-definer functions without pinned search paths, public grants, unsafe storage policies, and migration drift.

### 7.4 Reconciliation and cleanup

- Classify Auth-only and app-only identities; recover or merge valid accounts before deleting anything.
- Move zero-value idempotency markers out of the financial ledger into an ingestion/operation table. Keep legitimate zero-value grants explicitly typed.
- Reconcile abandoned holds and unknown provider operations before archival.
- Migrate deprecated credential rows only after ownership and decryption checks.
- Add MIME, file-size, path, and per-user quota enforcement to storage.
- Add deletion/retention jobs for telemetry, webhook payloads, operation retries, audit events, revoked keys, and deleted accounts.
- Every cleanup writes a count, reason, actor, migration version, and recoverability window to the admin audit log.

## 8. Gateway admin dashboard

### 8.1 Access model

- Route: authenticated `/admin`, absent from navigation unless the server returns an admin capability.
- Roles: `support_read`, `support_write`, `finance`, `security`, `super_admin`.
- Require MFA `aal2`; require fresh step-up for mutations, exports, refunds, key changes, and impersonation-like support actions.
- Every mutation requires a typed reason and writes an immutable before/after audit event.
- No raw prompt/response, search-query, file, or tool-output viewer.

### 8.2 Pages

1. **Overview:** total users, activated users, DAU/WAU/MAU, weekly active users, weekly tokens, week-over-week growth, retention, Ace conversion/churn, search utilization, managed COGS, revenue, and gross margin.
2. **Users:** Auth/app/key/subscription/wallet/entitlement state, consent state, recent structured activity, and audited support actions.
3. **Plans and billing:** MRR, renewals, education discounts, wallet liability, purchased/promotional balances, reloads, refunds, disputes, failed payments, and Stripe event health.
4. **Usage and providers:** managed token usage/cost, BYOK/ChatGPT/local observed token telemetry, latency, errors, retries, provider health, search usage/provider burn, holds, unknown operations, and reconciliation drift.
5. **Privacy and telemetry:** sharing coverage, opt-out rate, deletion queue, consent versions, event rejection/redaction, and retention-job health.
6. **Security:** RLS coverage, Supabase advisor findings, privileged users, API-key age/usage, rotation state, suspicious access, and audit exports.
7. **Configuration:** versioned plan prices, credit deposits, search allowances, Synthetic Scientists concurrency, auto-reload defaults/caps, provider flags, circuit breakers, and global spend caps.

### 8.3 Metric definitions

- Managed tokens and cost come only from authoritative Gateway settlements.
- BYOK, ChatGPT/Codex, and local tokens appear as a separate “shared telemetry” series and only when observed. Never extrapolate missing users into a total.
- WAU is unique signed-in users with at least one OpenScience session/run start in the Monday-Sunday UTC week. Signed-out installations appear separately.
- Weekly tokens use the same complete UTC weeks. The current partial week is labeled provisional and compared only with the same elapsed portion of the prior week.
- Week-over-week growth is `(current - previous) / previous`; show absolute change and handle a zero prior period explicitly.
- Every chart displays source, coverage percentage, timezone, denominator, and last refresh.
- Maintain a versioned metric dictionary so dashboard definitions cannot drift silently.

Use daily aggregate tables/materialized views for charts; do not scan raw event tables on every page load.

## 9. Minimal OpenScience landing page

Keep the existing warm dark/coral visual identity and its strongest primitives, but reduce the page to:

1. **Header:** OpenScience mark, Docs, GitHub, Pricing, Sign in.
2. **Hero:** one headline, one short explanation, primary Install/Open CTA, secondary View plans CTA, and one copyable install command.
3. **Product view:** one real OpenScience screenshot with a concise caption.
4. **Works your way:** a compact comparison explaining that local, BYOK, and ChatGPT/Codex remain free while the Gateway is optional.
5. **Pricing:** Free, Ace, Ace+, and Teams. This is the primary decision surface.
6. **Install:** one clear install path and supported platforms.
7. **FAQ:** credits, managed search, auto-reload, cancellation, privacy/data sharing, and whether a subscription is required.
8. **Footer:** Docs, GitHub, Privacy, Terms, Support, Sign in.

Remove the oversized database/model/skills grids, duplicate CTAs, public graph promotion, old plan names, compute claims, and any unshipped screenshots or assertions.

### 9.1 Pricing card copy

- **Free:** “Use OpenScience locally with your own models, ChatGPT/Codex subscription, scientific tools, and direct downloads. Sign in only if you want owned/private graphs.” CTA: Install.
- **Ace — $20/month:** “20 purchased credits, 1,000 managed searches, hosted Synthetic Scientists access, standard support.” Managed web marked coming soon. CTA: Start Ace.
- **Ace+ — $100/month:** “150 monthly credits (100 purchased + 50 promotional), 5,000 managed searches, higher hosted limits, priority support, early access.” Collaboration/managed web marked coming soon. CTA: Start Ace+.
- **Teams:** only contracted capabilities; compliance marked coming soon unless actually available. CTA: Contact.
- Show “50% off the first month with a verified `.edu` email” below paid plans.
- State “Auto-reload is selected at checkout and can be turned off or changed before payment.” Do not hide it in footnotes.

### 9.2 Checkout flow

- Landing CTA uses public `plan=ace|ace_plus`, preserves the choice through sign-in, and resolves legacy identifiers server-side.
- Checkout shows recurring price, initial credit deposit, purchased/promotional split, search allowance, auto-reload threshold/amount/cap, fees, renewal date, cancellation behavior, and terms.
- Account Billing shows balance buckets, searches remaining/reset, reload state, plan benefits, invoices, portal, cancellation, and deletion links.
- Mobile layout, keyboard focus, contrast, motion reduction, and 44px interaction targets are required. Pricing cards may use a card layout because they are selectable entities; avoid a generic feature-card wall.
- Remove scroll parallax and long reveal chains. Keep at most one restrained focal entrance, use roughly 180–260 ms interaction motion, and disable transforms plus global smooth scrolling under `prefers-reduced-motion`.

## 10. `app.syntheticsciences.ai` product surface

### 10.1 Primary navigation

The Gateway product group contains only:

- **Install** — canonical route `/install`.
- **Graphs** — canonical authenticated route `/graphs`.

Billing, Settings, Docs, Support, and eligible Admin live in the account menu, not the primary product navigation. Authenticated `/` and `/home` resolve to `/graphs`. Legacy `/atlas` redirects to `/install`.

When public surfaces are hidden, `/explore`, `/explore/graphs/:graphId`, `/u/:handle`, `/o/:org`, `/c/:slug`, `/competitions`, and protected `/compute` redirect to protected `/graphs`; anonymous stale links therefore end at sign-in. Keep `/auth/atlas/cli/approve` routable for installed-client authentication while changing only its rendered copy.

### 10.2 Graph access

- Graphs lists graphs owned by the signed-in user plus private graphs explicitly shared with that user.
- Add one server-paginated `scope=owned_or_shared_private` list contract. It unions owned graphs and explicit private collaborator grants before pagination; do not client-union the existing independently paginated `owners=me` and shared queries.
- Remove public/shared-everyone filters, Explore buttons, trends, profiles, organization discovery, competitions, public artifact cards, star/fork controls, and public graph CTAs.
- Hide public/unlisted publishing controls. Enforce rejection of new public/unlisted transitions in the central `sharing_service` batch and single-item methods so web routes and older CLI routes cannot bypass the flag.
- Existing public/unlisted database values are preserved for rollback but are treated as owner/collaborator-private while disabled.
- Owners still see their own graph regardless of its old visibility value; no data disappears from its owner.
- Under `ENABLE_PUBLIC_GRAPHS=false`, public/unlisted visibility never grants access in the central access checker, generic graph listing, retrieval service, or user-files query. Owner and explicit collaborator grants remain authoritative.
- Public graph/profile/org/competition/tree/artifact/repository endpoints return 404 while disabled, avoiding object-existence leakage. This includes the current node Explore routes, researcher/user routes, and the `/api/v1/explore`, `/api/v1/researchers`, `/api/v1/competitions`, and competition-detail compatibility routes.
- Check the flag before any public-response cache lookup so runtime disablement cannot serve cached public bytes.

### 10.3 Compute

- Remove Compute from nav, home, command palette, prefetch, docs links, sitemap, and product marketing.
- `/compute` redirects to `/graphs` or returns the same feature-unavailable route behavior used elsewhere.
- Keep existing authenticated compute APIs intact for current CLI/BYOK/local integrations; hiding the app surface must not break installed users.
- Put frontend discovery and backend API availability behind separate flags so the future product can be launched deliberately.

### 10.4 Feature flags

- Frontend build-time flags: `VITE_FEATURE_PUBLIC_GRAPHS=false`, `VITE_FEATURE_COMPUTE_UI=false`, exposed through centralized typed config.
- Backend: `ENABLE_PUBLIC_GRAPHS=false` with 404 enforcement.
- Compute API remains enabled independently unless a separate security incident requires disabling it.
- The backend flag is runtime/server-configured and observable in admin. The Vite UI flags are build-time; changing them requires a frontend deployment. All flags remain reversible without a data migration. A later server-fetched feature-config endpoint may make UI flags runtime-controlled, but this implementation must not claim they already are.

## 11. Public branding migration

Replace user-visible legacy branding with **Gateway** or **OpenScience Gateway** in:

- app titles, nav, home, install, settings, billing, admin, tooltips, empty states, errors, authentication approval, and emails;
- OpenScience landing, docs, README/security copy, search disclosure, plans, analytics labels, and support material;
- graph UI: use “Graphs,” never a branded graph name.

Compatibility rules:

- Keep `/auth/atlas/...`, `/atlas`, `atlas_*` database fields, internal module filenames, local-storage keys, and the existing executable/package where installed clients depend on them.
- Add/display a `gateway` command alias before documenting a replacement CLI name. Keep the old command as a deprecated alias.
- Public install copy uses `npx synsci` or the OpenScience installer so legacy implementation branding is not exposed.
- Add a UI-copy check that permits exact compatibility identifiers only in non-rendered code/tests and fails on rendered legacy brand strings.

## 12. Architecture and data contracts

```text
OpenScience desktop/web
  ├─ local/BYOK/ChatGPT/Codex/science/WebFetch ───────────────> direct/local path
  ├─ managed model or hosted researcher ──> Gateway ─────────> provider
  ├─ research_search (entitled) ───────────> Gateway ─────────> Firecrawl adapter
  ├─ research_search (Free) ───────────────> community adapter
  └─ content-free telemetry (disableable) ─> telemetry ingest

Gateway
  ├─ auth + entitlements
  ├─ wallet holds + settlement
  ├─ search allowance reservation
  ├─ Stripe subscriptions + reloads
  ├─ provider routing + secrets
  ├─ normalized operations + reconciliation
  ├─ telemetry validation + aggregation
  └─ audited admin console
```

### 12.1 Core records

- `plan_catalog_versions`: public plan name, price version, credit deposit, search allowance, entitlement/concurrency, effective dates.
- `subscription_periods`: Stripe period, plan version, state, credit/search grant idempotency.
- `wallet_accounts` and `wallet_ledger_entries`: purchased/promotional balances, holds, settlement, reloads, grants, refunds, expirations.
- `managed_operations`: idempotency, provider route, reserved/actual cost, terminal/unknown state, reconciliation.
- `search_periods` and `search_operations`: allowance, reservation, settlement, provider operational facts.
- `auto_reload_policies` and `auto_reload_attempts`: consent version, threshold, amount, cap, monthly consumed amount, PaymentIntent state.
- `telemetry_consents`, `telemetry_installations`, `telemetry_events`, `telemetry_daily_metrics`, `telemetry_deletion_requests`.
- `admin_roles`, `admin_actions`, `configuration_versions`, `security_findings`.

All financial, search, consent, and admin idempotency constraints are database-enforced, not process-local.

### 12.2 Gateway endpoints

- `GET /api/v1/plans`
- `GET /api/v1/entitlements`
- `POST /api/v1/research/search`
- `GET /api/v1/research/usage`
- `GET /api/v1/wallet`
- `POST /api/v1/wallet/topups`
- `PUT /api/v1/wallet/auto-reload`
- `POST /api/v1/subscriptions/checkout`
- `POST /api/v1/subscriptions/portal`
- `POST /api/v1/telemetry/batches`
- `DELETE /api/v1/telemetry/account-data`
- versioned `/api/v1/admin/*` endpoints per admin role

Keep existing web-search, billing, CLI-auth, and usage routes as compatibility adapters until current clients have migrated.

### 12.3 Repository work

OpenScience:

- add the provider-neutral `research_search` tool and legacy adapter;
- route entitlement/search through the Gateway without coupling to model provider;
- add content-free event builders, queue, consent settings, deletion, and first-run disclosure;
- gate AI-SDK telemetry with in-app consent and give landing-site analytics its own explicit browser consent boundary;
- expose plan/search/data-sharing status in Research Tools and Settings;
- preserve all free/direct tools and current download behavior;
- replace public legacy service copy;
- simplify the landing page and add pricing/checkout links.

Gateway service:

- version plan catalog, Stripe mappings, entitlements, wallet buckets, and auto-reload;
- cut `/api/cli/usage` over to non-financial acknowledgement while preserving exactly one proxy-settled debit per managed request;
- add Firecrawl provider adapter and allowance reservation/settlement;
- add telemetry ingest/aggregation/deletion;
- add admin roles, APIs, and UI;
- add `/install` and reduce app navigation to Install/Graphs;
- enforce private graph access and disable public discovery server-side;
- hide Compute UI while preserving compatible APIs;
- replace rendered legacy branding.

## 13. Execution order

1. **Contain production risk:** rotate exposed credentials, inventory schema/policies, add migration ownership, and lock admin access.
2. **Establish authoritative contracts:** plan versions, entitlements, wallet buckets, managed operations, and compatibility resolvers.
3. **Ship Stripe product flows:** Ace/Ace+, education, renewal grants, cancellation, portal, and explicit default-on auto-reload consent.
4. **Ship managed search:** Gateway endpoint, Firecrawl adapter, 1,000/5,000 metering, client tool routing, and Free compatibility.
5. **Ship observability:** default-on content-free analytics, all-route instrumentation, opt-out/deletion, aggregates, and coverage labels.
6. **Ship admin:** RBAC/MFA, overview/users/billing/usage/privacy/security/configuration pages, support actions, and immutable audit.
7. **Refine public product surfaces:** minimal OpenScience landing/pricing, checkout links, Gateway branding, and concise docs.
8. **Reduce the app:** Install/Graphs primary nav, private graph enforcement, hidden Explore/public graphs, hidden Compute UI.
9. **Reconcile legacy data:** identities, zero-value ledger markers, holds, deprecated credentials, storage, retention, and safe archival.
10. **Enable production flags only after the bounded verification pass below is green.**

## 14. Named failure behavior

| Condition                                   | User behavior                                                                       | Accounting behavior                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| Gateway unavailable                         | Managed action shows one retryable error; local/BYOK/ChatGPT/science tools continue | No debit; reservation released or reconciled |
| Search allowance exhausted                  | Show reset and upgrade; offer community/science/WebFetch alternatives               | No wallet charge or reload                   |
| Firecrawl validation/auth failure           | Specific unavailable message; no agent retry loop                                   | Zero searches consumed                       |
| Usable partial search                       | Show partial warning and results                                                    | One search consumed                          |
| Managed provider accepted but response lost | Show pending/reconciliation state, not blind retry                                  | Hold remains `unknown` until reconciled      |
| Empty wallet                                | Managed model/hosted action offers top-up or BYOK                                   | No negative balance                          |
| Auto-reload payment failure                 | Notify once; allow manual top-up and free routes                                    | No repeated PaymentIntent loop               |
| Telemetry offline                           | No user interruption                                                                | Bounded queue or drop; never bill            |
| Telemetry disabled                          | Research unchanged                                                                  | Upload stops, queue clears, ID rotates       |
| Hidden public graph URL                     | 404                                                                                 | No visibility data changed                   |
| Hidden Compute route                        | Return to Graphs; existing CLI API stays available                                  | No data changed                              |

## 15. One bounded verification pass

Run this once per completed workstream, fix concrete failures, then run the affected checks once more. Do not open an unbounded tuning cycle.

1. **Compatibility matrix:** Free/Ace/Ace+ across managed, BYOK, ChatGPT/Codex, and local routes; science tools; `WebFetch`; community and managed search.
2. **Billing matrix:** Stripe test clocks for initial checkout, education discount, renewals, duplicate/reordered webhooks, cancel-at-period-end, failed payment, refunds/disputes, plan change, and grandfathered Pro.
3. **Wallet invariants:** integer accounting and cents/micro-USD conversion, purchased/promotional order, holds/settlement/release/unknown, replay idempotency, concurrent threshold crossing, reload cap, no client-created debit, and exactly one proxy-settled debit per managed request while `/api/cli/usage` is non-financial.
4. **Search contract:** 1,000/5,000 grants, period reset, concurrency, idempotent replay, failure zero-count, partial one-count, exhaustion, provider circuit breaker, no wallet/reload interaction, and legacy `websearch` compatibility.
5. **Telemetry contract:** all routes emit allowlisted events; prohibited fields are rejected; opt-out/deletion/account switching/corrupt-consent/offline queue behave correctly; AI-SDK emission obeys in-app consent; landing analytics obeys its separate browser consent; research continues when ingest fails.
6. **Supabase security:** migration drift, RLS role matrix, storage limits, secret scanning, function/grant checks, deletion/retention jobs, and admin MFA.
7. **Admin:** each role's read/write boundaries, step-up, reason requirement, immutable audit, metric definitions, and source/coverage labels.
8. **Landing and checkout:** exact plan copy, coming-soon labels, education, auto-reload disclosure, sign-in return-to, Stripe checkout, responsive layout, keyboard, contrast, and reduced motion.
9. **App surface:** Install/Graphs nav only, account-menu Billing/Settings/Admin, `/atlas` compatibility redirect, hidden routes, owner/private-collaborator graph access, public endpoint 404s, and preserved compute API compatibility.
10. **Release smoke:** one Free local/BYOK workflow, one Ace managed-search workflow, one Ace+ workflow, one opt-out workflow, and one admin read-only workflow, all with rollback flags available.

## 16. Acceptance criteria

The work is complete only when:

- Free users lose no current local, model, science, search, download, or private-graph capability.
- Ace grants 20 purchased credits and exactly 1,000 managed searches per subscription period.
- Ace+ clearly grants 100 purchased + 50 promotional credits and exactly 5,000 managed searches per subscription period.
- Search works independently of the inference route and never spends wallet credits or triggers auto-reload.
- Existing `$50` Pro subscriptions and legacy clients continue to resolve without silent repricing.
- Auto-reload is selected for new checkout, visibly editable, backed by explicit off-session consent, capped, idempotent, and off for existing users until consent.
- Only server-observed managed operations create charges.
- Shared analytics covers managed/BYOK/ChatGPT/local routes, contains no research content, and can be disabled without affecting research.
- Supabase has no known plaintext application credentials, every retained object has an owner/migration/policy, and user data cleanup is reconciled rather than guessed.
- Admin mutations are server-authorized, MFA/step-up protected, reasoned, and audited.
- OpenScience landing shows working Free/Ace/Ace+/Teams pricing and a materially shorter information architecture.
- Rendered product surfaces contain no legacy service branding.
- `app.syntheticsciences.ai` shows Install and private Graphs as primary product surfaces; public Explore and Compute UI are unreachable.
- Public graph APIs enforce the disabled state and private graph APIs enforce owner/collaborator access.
- Feature flags can restore the previous UI without deleting data.

## 17. Rollback and non-goals

Rollback:

- Keep search, backend public-graph access, telemetry upload, and new checkout behind independent server-controlled flags. Keep public-graph and Compute UI behind independent Vite build flags until a server-fetched feature-config contract exists.
- Preserve legacy plan/tool/route identifiers and database values through migration.
- Disable a provider adapter without disabling `research_search` community fallback or direct tools.
- Disable telemetry ingest without changing local trace behavior.
- Stop new auto-reloads without mutating wallet balances or subscriptions.

Not in this implementation:

- public graph discovery, profiles, stars, competitions, or public sharing;
- launching Compute as an app feature;
- unlimited hosted Synthetic Scientists compute;
- search wallet overage or reload-on-search;
- provider crawl, autonomous agent, browser interaction, arbitrary extraction, private-network access, or user-supplied provider options;
- default collection of prompts, responses, files, URLs, or tool payloads;
- changing the open-source/local product into a subscription gate;
- deleting legacy production data before reconciliation;
- claiming Teams compliance, ZDR, collaboration, or managed web before those contracts and features ship.

## Approval boundary

Approval of this plan authorizes implementation in the worktrees and repositories named above, followed by the single bounded verification pass. It does not authorize destructive production cleanup, publishing unshipped benefits, silently repricing legacy subscribers, or enabling auto-reload for existing users without consent.
