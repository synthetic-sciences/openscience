# Compute pre-flight: what must be true before OpenScience gets compute tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five things standing between a working Atlas compute API and three agent-facing
OpenScience tools. Four are defects found by live probing; one is a decision already taken but unbuilt.

**Architecture:** All work is in **Atlas** (`~/codes/InkVell/atlas`), continuing on
`feat/compute-lease-prerequisites`. No OpenScience changes here — the tools come after.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, pytest + pytest-asyncio, respx.

**Spec:** `~/codes/InkVell/openscience/docs/specs/compute-design.md`.

## Global Constraints

- **Repo:** `~/codes/InkVell/atlas`, branch `feat/compute-lease-prerequisites` (already checked out).
  Do not create or switch branches.
- **Run tests with:** `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest <path> -q`.
  No activated virtualenv — always invoke `.venv/bin/python` explicitly.
- **Never add a `Co-Authored-By:` trailer or any AI/assistant attribution to commit messages.**
- **No mocks of our own code.** Fake providers at the HTTP boundary with `respx`, or register a fake
  into the provider registry — the pattern in `backend/tests/test_compute_resell_routes.py`.
- **Every new assertion must be shown failing first.** Paste the RED output into your report.
- Baseline: full suite is **1913 passed, 1 skipped**. It must be green when each task finishes.
- Ignore `.claude/worktrees/`.

## Measured facts — established live on 2026-08-02/03, do not re-derive

1. **Atlas meters reads and launches from one bucket.** `POST /leases`, `GET /leases`,
   `GET /leases/{id}/connection` and `POST /leases/{id}/release` all classify as `compute_acquire`,
   20/min. Measured: 429 at request 21. `GET /options` is `default`, 600/min.
2. **The bucket is per bearer token, per process.** Key is `auth:{sha256(token)[:24]}`; the store is
   `InMemoryStore` because neither Fly app sets `REDIS_URL`; production runs `--workers 2`
   (`backend/fly.toml:69`). So the effective ceiling is 20–40/min depending on which worker serves.
3. **A launch returns `provisioning` with no SSH coordinates.** Measured `ready` at t+20–30s, via the
   reaper's promotion. So any client must poll — which is why fact 1 bites.
4. **Vast rate-limits `/bundles/` at ~1 request/second**, advertising `x-ratelimit-limit: 1.0`,
   `x-ratelimit-remaining`, `x-ratelimit-reset` ≈1s out; recovers after 1s idle. Per Vast's docs the
   identity is bearer token + session user + api_key param + **client IP**, enforced as a minimum
   interval **per endpoint** — so this is shared by every managed user of a deployment and does not
   improve when we add machines.
5. **Vast returns exactly 64 offers per query and ignores `limit`** (tested 64…2000 and with the key
   absent). **There is no pagination**: `offset` and `from` both return `400`. More inventory is only
   reachable through more *filtered* queries, each costing one request against fact 4.
6. **RunPod has no observable limit** — 60 requests at 2.2/s, no 429, no rate-limit headers.
7. **One `list_options` is 2 concurrent GETs** and completes healthily in ~2.1s; three back-to-back
   fan-outs (the retry pattern) also all healthy. Today's pattern fits inside fact 4; concurrent
   *retrying* launches are what would not.

---

### Task 1: Reads must not spend the launch budget

**Files:**
- Modify: `backend/app/middleware/rate_limit.py`
- Test: `backend/tests/test_rate_limit_compute.py` (new)

**Interfaces:**
- Produces: safe methods (`GET`/`HEAD`/`OPTIONS`) on `compute_acquire` paths classify as `default`.
  `POST`/`DELETE` on those paths keep `compute_acquire`.

Two defects, one file.

**(a) The read/write split.** `_classify` already lets safe methods fall through to the generous
`default` class, but only for classes whose *name contains the substring* `"mutation"`
(`rate_limit.py:203`). That is why `compute_acquire` was missed. Replace the name test with an explicit
field on `_BucketClass` — a name is not a policy — and set it on `compute_acquire`, `mutations` and
`atlas_graph_mutations` so behaviour for the existing two is unchanged.

Do **not** raise `compute_acquire`'s 20/min. The launch side should stay guarded; it is the reads that
were never meant to be in there.

**(b) The store is captured too early.** `RateLimitMiddleware.__init__` does
`self._store = get_kv_store()` (`rate_limit.py:225`). `reset_kv_store()` swaps the module-level store,
so the middleware keeps a stale reference and these buckets never reset between tests. This has already
produced a **false pass** in a RED run — a test asserting a 429 received the limiter's 429. Resolve the
store per request (or per call) so a test reset is honoured. Keep it cheap: `get_kv_store()` is memoized.

- [ ] **Step 1: Write the failing tests**

1. `GET /api/compute/leases` 30 times on one token stays 200 — it must not consume launch budget.
   Fails today at request 21.
2. `POST /api/compute/leases` is still limited at 20/min on one token.
3. Reads and writes do not share a bucket: exhaust the write bucket, then a read still succeeds.
4. `mutations` and `atlas_graph_mutations` keep their existing safe-method fall-through — a regression
   guard on the behaviour being generalised.
5. After `reset_kv_store()`, a previously exhausted bucket is clean. **This is (b), and it must fail
   first** — if it passes before the change, the test is not testing the defect.

- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, then the full suite**
- [ ] **Step 5: Commit**

---

### Task 2: A rate-limited Vast must degrade, not vanish

**Files:**
- Modify: `backend/app/compute/vast_provider.py`, `backend/app/routes/compute.py`
- Test: `backend/tests/test_compute_vast_provider_http.py` (append),
  `backend/tests/test_compute_catalog_cache.py` (append)

**Interfaces:**
- Produces: a Vast `429` is distinguishable from "Vast has no offers", and does not silently empty the
  catalog.

`list_options` calls `cheap_resp.raise_for_status()`. On a `429` that raises, `_provider_catalog` catches
`Exception` and returns `base` — a block with `options: []`. So a rate-limited fetch is indistinguishable
from Vast having nothing, and Vast is most of the cheap inventory. The caller is told "no listed offer
matches" when the truth is "ask again in one second".

Given fact 4 this is not hypothetical under concurrency: `fresh=True` retries bypass the cache, and two
concurrent blocked launches exceed Vast's budget.

Required behaviour:

- A `429` from the cheap query must be reported as a rate-limit condition, not an empty catalog.
- `_provider_catalog` must **not** replace a usable cached entry with an empty one because of a
  transient `429`. Serving slightly stale rows beats serving none — and note the existing comment at
  `routes/compute.py:222` already argues the empty result must not be *cached*; this extends that
  reasoning to not discarding what we already have.
- The `no_matching_offer` / `no_capacity` error a caller finally sees must not claim nothing matched
  when a provider was rate-limited. Say which provider was unavailable.
- Respect `x-ratelimit-reset` where present rather than inventing a backoff.

**Do not add a retry loop inside `list_options`.** The caller already has one, and Vast's budget is
shared deployment-wide — a provider-level retry multiplies load exactly when the system is busiest.

- [ ] **Step 1: Write the failing tests** (`respx`, no live calls)

1. A `429` on the cheap query does not produce a silently empty Vast block.
2. A `429` does not evict or overwrite a healthy cached entry.
3. A genuinely empty Vast catalog (200, no offers) is still reported as empty — the two must stay
   distinguishable.
4. A `429` on the *premium* query alone still yields the cheap rows (it is already additive).
5. The user-facing error names the rate-limited provider rather than claiming no match.

- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, then the full suite**
- [ ] **Step 5: Commit**

---

### Task 3: Unlock Prime Intellect, and widen the canonical map

**Files:**
- Modify: `backend/app/compute/prime_intellect_provider.py`, `backend/app/compute/gpu_models.py`
- Test: `backend/tests/test_compute_prime_provider_http.py` (append),
  `backend/tests/test_compute_gpu_models.py` (append)

**Interfaces:**
- Consumes: `canonical(name, *, gpu_ram_gb=None)`.
- Produces: Prime rows carry enough to be canonicalised; the map covers the datacenter cards our
  providers actually sell.

**(a) Prime Intellect.** Its `gpuType` carries memory but not interconnect (`A100_40GB`), so its A100 and
H100 rows cannot be placed among the four A100 / three H100 ids and are dropped entirely. The offer
*does* carry a `socket` field (`PCIe` / `SXM4`) and `acquire` already forwards it — `list_options`
simply never copies it onto the row (`prime_intellect_provider.py:174`). Surface it, and make
`canonical()` able to use it.

**(b) The map is narrower than what is on sale.** Verified against live catalogs: **37% of Vast rows and
52% of RunPod's** are mapped. Most of the remainder is consumer tail that is correctly dropped
(`GTX 1060`, `Tesla P4`, `Titan Xp`, `Quadro P4000`, `RTX 3060 laptop`) — **leave those unmapped.** But
these are priced today and unreachable through `{gpu, count}`: **B300**, **MI300X**, **GH200**,
`RTX PRO 6000 MaxQ`, and the Ada/Ampere workstation line.

**The exact-match rule is not negotiable.** `RTX 6000 Ada`, `RTX A6000`, `RTX PRO 6000`,
`RTX PRO 6000 WK` and `RTX PRO 6000 MaxQ` are five different cards whose names contain each other, and
`GH200 SXM` contains `H200`. Every added id is a literal-string table entry plus a canonical id. Adding
`GH200` while a substring rule exists anywhere would rank a Grace Hopper superchip as an H200.

**Do not invent provider strings.** `VAST_API_KEY` and `RUNPOD_API_KEY` are live in `backend/.env`; dump
the real catalogs (read-only `GET`s, the same ones `list_options` issues — **provision nothing**) and
map what you actually observe. Vast rate-limits `/bundles/` at ~1/s (fact 4), so sleep between fetches.
Record in your report which strings came from a live dump and which from a repo fixture.

- [ ] **Step 1: Write the failing tests**

1. A Prime offer with `socket: "SXM4"` and `gpuType: "A100_40GB"` canonicalises to `A100-40GB-SXM`;
   with `socket: "PCIe"`, to `A100-40GB-PCIe`.
2. A Prime offer with no `socket` still yields `None` — never a guess.
3. Each newly added card maps from its real provider spelling(s).
4. **`GH200 SXM` is not `H200-*`, and `RTX PRO 6000 MaxQ` is not `RTX-PRO-6000` or `-WK`.** Extend the
   existing `_UNMAPPABLE`/adversarial cases rather than adding a separate test.
5. Live coverage rises for the datacenter tier; the consumer tail stays unmapped.

- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, then the full suite**
- [ ] **Step 5: Commit**

---

### Task 4: A release that did not happen must not bill the user

**Files:**
- Modify: `backend/app/compute/lease_manager.py`, `backend/app/services/compute_billing_service.py`,
  `backend/app/jobs/lease_reaper.py`, `backend/db` migration for the new column
- Test: `backend/tests/test_lease_reaper_seam.py` (extend), `backend/tests/test_compute_billing.py`

**Interfaces:**
- Produces: an unconfirmed teardown stops billing and frees the concurrency slot, while remaining
  visible to a retry.

**The decision, already taken by the product owner:** stop billing the user, and flag the lease for
reconciliation so the operator's box is chased separately. The user must never pay for our failure to
tear down.

Today `release_lease` returns early when `release_confirmed()` is false, leaving `status` untouched. Every
billing and concurrency gate is `status NOT IN ('released','failed')`, so the user keeps being billed and
keeps holding a slot.

**Both docstrings claim the reaper retries this. It does not.** All four reaper branches were walked:
branch 0 needs terminal telemetry a user lease never emits; branch 1 finds the box `ready` precisely
because the teardown failed; branch 2 only fires on `provisioning`; branch 3 is gated on
`runner_api_key_id`, which only the agent-spawn path sets. **Fix the comments as part of this task** —
they are the reason this looked safe.

Required behaviour:

- An unconfirmed teardown marks the lease terminal for billing and concurrency purposes.
- It stays discoverable for a retry — a distinct state or flag, not silently released. Historical rows
  must be unaffected.
- Something must actually retry it. If that is the reaper, add the branch and prove it fires for a
  **user** lease with no `runner_api_key_id`.
- `CredentialUnavailable` (a deleted BYOK key, a rotated operator key) is the case with no recovery
  today; it must not be conflated with a provider that answered and refused.

- [ ] **Step 1: Write the failing tests**

1. A managed lease whose provider release is unconfirmed stops accruing charges.
2. …and frees the concurrency slot, so a subsequent launch is not 429'd by a box we failed to kill.
3. …and is still visible to whatever retries it.
4. The retry actually fires for a user lease (no `runner_api_key_id`) — extend
   `test_lease_reaper_seam.py`, which sweeps every lease class in one pass.
5. A confirmed release is unchanged.
6. A historical row predating the new column serialises and reaps unchanged.

- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, then the full suite**
- [ ] **Step 5: Commit**

---

### Task 5: See more than the cheapest 64 offers

**Files:**
- Modify: `backend/app/compute/vast_provider.py`
- Test: `backend/tests/test_compute_vast_provider_http.py` (append)

**Interfaces:**
- Produces: a requirement for a specific GPU reaches offers outside the global cheapest-64 window.

Atlas asks Vast for `limit: 512` and gets 64. **There is no pagination** — `offset` and `from` both
`400` (fact 5). So "Atlas leases the cheapest box" currently means *cheapest of the 64 cheapest
on-demand offers overall, plus 64 more matching the premium name list* — for a mid-tier card there may
be cheaper instances in neither window.

The only lever is more filtered queries, and each costs one request against a ~1/s **deployment-wide**
budget (fact 4). A per-model sweep of 22 canonical ids would take 22 seconds and is not viable in a
request path.

**Start by measuring, then choose.** Before implementing, establish with read-only live queries:
- how much a `gpu_name`-filtered query improves coverage for one card versus the global window
- what the cheapest offer for a given card looks like in each

Then implement the cheapest widening that fits the budget. A targeted query issued only when a caller
names a requirement — one extra request, for exactly the card wanted — is the shape I expect to win,
but **verify before building it**, and if the measurement says the current windows already contain the
cheapest offers for the cards we canonicalise, **say so and build nothing.** That is a legitimate
outcome and better than a speculative fetch on every launch.

Whatever ships must not increase the request count on the *cached* path, and must not turn one launch
into more than one extra Vast request.

- [ ] **Step 1: Measure and report the coverage gap** (read-only, provision nothing)
- [ ] **Step 2: Write the failing tests for the chosen design** (`respx`)
- [ ] **Step 3: Run and confirm they fail**
- [ ] **Step 4: Implement**
- [ ] **Step 5: Run, then the full suite**
- [ ] **Step 6: Commit**

---

## Whole-branch verification

- [ ] Full suite green, no network.
- [ ] These still pass by name: `test_promoted_lease_is_not_reaped_at_the_provisioning_timeout`,
      `test_lease_without_a_budget_is_still_sized_to_the_full_plan_ttl`,
      `test_out_of_credit_release_of_a_managed_lease_uses_the_operator_key`,
      `test_two_users_with_different_byok_eligibility_never_see_each_others_rows`,
      `test_gh200_is_not_an_h200`, `test_two_concurrent_migrators_do_not_crash_on_shared_sqlite_file`.
- [ ] Explicit `provider`/`sku` leases unchanged — the dashboard's path.
- [ ] A live re-probe of launch → ready → connection → release still passes.

## Acceptance criteria

1. A readiness poll does not consume launch budget; `POST` stays at 20/min.
2. `reset_kv_store()` actually clears the limiter's buckets.
3. A Vast `429` is distinguishable from an empty Vast catalog and never silently empties it.
4. Prime Intellect rows canonicalise when the offer names a socket, and `None` when it does not.
5. B300, MI300X, GH200, `RTX PRO 6000 MaxQ` and the workstation line are reachable via `{gpu, count}`;
   the consumer tail stays unmapped; `GH200 SXM` is still not an H200.
6. An unconfirmed teardown stops billing, frees the slot, stays retryable, and something retries it.
7. The docstrings no longer claim a reaper retry that does not exist.
8. Task 5 ships either a measured widening or a written finding that none is warranted.

## Out of scope

- Any OpenScience change — the three tools come after this plan.
- Provisioning Redis for a cross-process rate limit (an infra decision, not code).
- Backfilling historical lease rows.
- The ~14 deferred Minor findings in the resolver plan's ledger.
