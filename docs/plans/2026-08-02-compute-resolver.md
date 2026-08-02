# Compute catalog cache and server-side resolver — implementation plan

> **EXECUTED 2026-08-02** on `feat/compute-lease-prerequisites`. All four tasks shipped and reviewed;
> full suite **1908 passed / 1 skipped**, no network. Commits: `8913be3` (cache), `f9c2da9` (GPU map),
> `9e1664d` (resolver), `d888ba5` + `730ee82` (requirement path + retry), `cf9e7de` + `416c064` +
> `bed63dc` + `fa429c6` (final-review fixes).
>
> **Two things this plan got wrong, both caught only by the whole-branch review:**
>
> 1. **Task 3's tie-break became a purchasing decision in Task 4.** Ranking on
>    `price_cents_per_hour_display` alone is correct across funding paths but degenerate *within* BYOK,
>    where every row displays `0` — the order collapsed to alphabetical by provider and leased a $9.00/h
>    box over a $3.00/h one. Neither task was wrong alone. The key is now
>    `(display, raw, provider, sku)`.
> 2. **Task 4 charged a retry attempt for a candidate no provider ever saw.** A region-less Lambda offer
>    is rejected locally, but it consumed one of three attempts plus a full catalog fan-out — and Lambda
>    emits region-less rows precisely for the types it is out of capacity on, which are also its
>    cheapest, so they sort first. Three of them ahead of a launchable offer returned 503 `no_capacity`
>    while capacity sat in the list.
>
> **And one thing it prescribed that the implementation was right to refuse:** Task 4 Step 3 says to
> discriminate the two `400`s on the provider's message. The implementation excludes already-refused
> `(provider, sku)` pairs instead — one rule that satisfies both providers and cannot rot when a
> provider rewrites its error prose. See `docs/specs/compute-design.md`, change 3.
>
> Deferred Minor findings, triaged by the final review, are in the ledger at
> `.superpowers/sdd/2026-08-02-compute-resolver/progress.md` (gitignored).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a managed lease launch actually land. Today a caller picks a SKU from
`GET /api/compute/options` and posts it — and on Vast that fails roughly half the time, because offer ids
churn faster than a client can act on them.

**Architecture:** All work is in the **Atlas** repo (`~/codes/InkVell/atlas`), continuing on
`feat/compute-lease-prerequisites`. Spec changes 12 (catalog cache) and 3 (server-side resolver). The
cache comes first because the resolver's retry multiplies catalog fetches.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, pytest + pytest-asyncio, respx.

**Spec:** `~/codes/InkVell/openscience/docs/specs/compute-design.md`, Part B changes 12 and 3.

## Global Constraints

- **Repo:** `~/codes/InkVell/atlas`, branch `feat/compute-lease-prerequisites` (already checked out).
  Do not create or switch branches.
- **Run tests with:** `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest <path> -q`.
  No activated virtualenv — always invoke `.venv/bin/python` explicitly.
- **Never add a `Co-Authored-By:` trailer or any AI/assistant attribution to commit messages.**
- **No mocks of our own code.** Fake providers at the HTTP boundary with `respx`, or register a
  `_FakeProvider` into the provider registry — the pattern in `backend/tests/test_compute_billing.py`
  and `backend/tests/test_compute_vast_provider_http.py`.
- **Every new assertion must be shown failing first.** Paste the failure into your report.
- Baseline: full suite is **1689 passed, 1 skipped**. It must be green when each task finishes.
- Ignore `.claude/worktrees/`.

## Established facts — measured, do not re-derive

Everything here was measured against production on 2026-08-01, not inferred:

1. **Vast offer ids churn ~50% between two consecutive catalog fetches.** Three back-to-back
   `GET /api/compute/options` calls returned 65 / 67 / 67 Vast offers with only **25 stable across all
   three**; 31 of the first 65 were gone by the second fetch.
2. **Client-side selection therefore fails about half the time.** Seven consecutive
   `400 Unknown SKU '<id>' for provider 'vast'` across price ranks 0–25 — so it is not a
   cheapest-first artefact, it is the whole catalog. A lease finally landed on the third random attempt.
3. **A tempting heuristic was falsified.** "Offers present in consecutive fetches are launchable" had
   perfect separation at n=8 retrospectively and **failed its first prospective test**. Do not
   reintroduce it. Retry is unavoidable.
4. **RunPod advertises GPU types with zero capacity.** The two cheapest both failed; the third
   succeeded. RunPod returns `500 "create pod: There are no instances currently available"`, which Atlas
   maps to a **`400`** — the same status as Vast's stale offer, with a different message.
5. **The two failures need opposite responses.** A stale Vast offer means "re-resolve the same
   requirement"; RunPod no-capacity means "pick a different SKU". Retrying the same offer on
   no-capacity loops forever.
6. **Providers publish quality signals we discard.** Vast returns `reliability2`, `inet_down` and
   `dlperf_per_dphtotal` on every offer and `list_options` reads none of them. RunPod exposes
   `lowestPrice { stockStatus }` and the query does not ask for it — across 37 priced types the
   distribution is Low 25 / High 9 / Medium 3, and **all ten cheapest types are `Low`**.
7. **Ranking must use `price_cents_per_hour_display`, not `price_cents_per_hour`.** The latter is the
   raw provider rate on both funding paths; the former is what the user pays and is `0` on BYOK.
8. `_catalog` is called at three sites — `/options`, `/estimate`, and `create_lease` — and each call
   costs **five provider HTTP requests** (four wired providers; Vast issues two).
9. `create_lease` re-validates the posted SKU with `_find_option` and raises the `400 Unknown SKU`. That
   is the race point.

## The tension the cache creates, and how to resolve it

A cache cannot make offers _fresher_. Given fact 1, a cached catalog is ~50% stale for Vast within
seconds, exactly as an uncached one is by the time a caller acts. So the cache is a **cost** fix, not a
correctness fix — and the resolver's retry must **bypass it**, or the retry re-reads the same dead
offers and can never succeed.

That is the load-bearing interaction between changes 12 and 3, and it is why they are planned together.

---

### Task 1: Cache the options catalog

**Files:**

- Modify: `backend/app/routes/compute.py` (`_catalog` and its three call sites)
- Test: `backend/tests/test_compute_catalog_cache.py` (new)

**Interfaces:**

- Produces: `_catalog(db, user_id, *, fresh: bool = False)` — same return shape as today
  `(options, providers, byok_eligible)`. `fresh=True` bypasses and repopulates the cache.

- [ ] **Step 1: Decide the cache key, and report before implementing**

`_provider_catalog` takes `user_id` and `byok_eligible`, and calls `_byok_for(db, user_id, provider)`
— so for a user holding a BYOK key the offers are fetched **with that user's credentials** and the
`funding` annotation differs. A naive global cache would leak one user's catalog to another.

Establish and report: whether the offer rows for a **managed-only** user (no BYOK key for that provider)
are user-independent. If they are, the common case can share one entry and only BYOK users need
per-user entries. **Report your finding before writing the key** — a wrong key here is a cross-user data
leak, not a performance bug.

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_compute_catalog_cache.py`. Count provider calls with a registered fake
provider that increments a counter. Cover:

1. two `_catalog` calls inside the TTL issue **one** round of provider calls
2. a call after the TTL expires re-fetches
3. `fresh=True` bypasses the cache even inside the TTL, and repopulates it
4. **two users with different BYOK eligibility never see each other's rows** — the key correctness test,
   shaped by your Step 1 finding
5. a provider that raises does not poison the cache with an empty catalog that then serves for the whole
   TTL

- [ ] **Step 3: Run and confirm they fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_catalog_cache.py -q`

- [ ] **Step 4: Implement**

An in-process TTL cache is sufficient — the reaper and billing loop already assume a single process per
worker, and a stale entry costs a retry rather than money. Do **not** reach for Redis.

Pick the TTL deliberately and justify it in a comment against fact 1: a longer TTL saves requests but
cannot reduce staleness below the churn rate, so there is a point past which it only trades correctness
for nothing. State the number you chose and why.

- [ ] **Step 5: Run, then the full suite**

- [ ] **Step 6: Commit**

---

### Task 2: A canonical GPU model map

**Why:** the resolver takes a requirement (`gpu`, `count`) rather than an opaque SKU, so it needs to know
that Vast's `RTX 4090` and RunPod's `NVIDIA GeForce RTX 4090` are the same card — and that `H100 SXM`,
`H100 PCIe` and `H100 NVL` are **not** interchangeable. Interconnect is part of the model identity: they
differ in throughput and price.

**Files:**

- Create: `backend/app/compute/gpu_models.py`
- Test: `backend/tests/test_compute_gpu_models.py` (new)

**Interfaces:**

- Produces: `canonical(name: str, *, gpu_ram_gb: int | None = None) -> str | None` — maps a provider's
  display name to a canonical model id, or `None` when it cannot be mapped confidently.

- [ ] **Step 1: Write the failing tests**

The taxonomy to support, which a comparable aggregator settled on independently:

```
A10 · A40 · A100-40GB-PCIe · A100-40GB-SXM · A100-80GB-PCIe · A100-80GB-SXM
H100-PCIe · H100-NVL · H100-SXM · H200-NVL · H200-SXM · B200
L4 · L40 · L40S · RTX-3090 · RTX-4090 · RTX-5090 · RTX-6000-Ada
RTX-A6000 · RTX-PRO-6000 · RTX-PRO-6000-WK
```

Cover:

1. the same card spelled differently across providers maps to one id — use **real strings** taken from
   the provider modules, not invented ones
2. `H100-SXM`, `H100-PCIe` and `H100-NVL` are three distinct ids and never satisfy each other
3. an unmappable name returns `None` — **not** a guess. A mis-mapped card is the wrong machine at the
   wrong price, silently
4. matching is not substring-based: a name containing `H100` as a substring of something else does not
   map to an H100

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Implement**

Read the real name strings each provider emits before writing the map — `vast_provider.list_options`
(`gpu_name`), `runpod_provider.list_options` (`displayName`), and the Lambda and Prime equivalents.
Build from what they actually produce.

- [ ] **Step 4: Run, then the full suite**

- [ ] **Step 5: Commit**

---

### Task 3: Resolve a requirement to an offer

**Files:**

- Create: `backend/app/compute/resolver.py`
- Test: `backend/tests/test_compute_resolver.py` (new)

**Interfaces:**

- Consumes: `canonical()` from Task 2; catalog rows as `_catalog` returns them.
- Produces: `resolve(options, *, gpu, count, max_hourly_cents=None) -> list[dict]` — the matching offers
  in preference order, best first. A **list**, not one offer, because the caller retries down it.

- [ ] **Step 1: Write the failing tests**

1. picks the **globally cheapest** matching offer across providers — proven with a catalog where the
   winner is neither the first provider listed nor the same provider twice. A resolver that always
   returns one provider must fail this.
2. ranks on the **funding-adjusted** rate: a cheaper billed offer never beats a dearer BYOK one (fact 7)
3. honours `max_hourly_cents`
4. matches on the canonical model, so `H100-SXM` never returns an `H100-PCIe`
5. exercised at `count > 1`, not only `count = 1`
6. returns an ordered list with the cheapest first, so a caller can walk it
7. an empty result is a distinct, inspectable outcome — not an exception

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Implement**

Rank by `price_cents_per_hour_display` ascending among offers whose canonical model and `count` match.
Keep it a pure function over catalog rows — no I/O, no DB. That is what makes it cheap to test
exhaustively.

**Do not implement a stock or reliability filter in this task.** Facts 6 and 3 make it tempting; the
signals are real but unrequested by the provider modules, and the one heuristic we tried was falsified
prospectively. Ordering by price alone, with retry underneath, is the behaviour we have actually
measured working. Note the opportunity in a comment and leave it.

- [ ] **Step 4: Run, then the full suite**

- [ ] **Step 5: Commit**

---

### Task 4: Accept a requirement on lease creation, and retry

**Files:**

- Modify: `backend/app/routes/compute.py` (`LeaseRequest`, `create_lease`)
- Test: `backend/tests/test_compute_resell_routes.py` (append)

**Interfaces:**

- Consumes: `resolve()` from Task 3, `_catalog(fresh=…)` from Task 1.
- Produces: `POST /api/compute/leases` accepts `{gpu, count, max_hourly_cents?}` in place of
  `{provider, sku}`. Explicit `provider`/`sku` continues to work unchanged.

- [ ] **Step 1: Write the failing tests**

1. `{gpu, count}` resolves and leases without the caller naming a SKU
2. **explicit `provider`/`sku` still works exactly as today** — the dashboard and `compute:up` depend on
   it, and it must not start requiring `gpu`
3. **a stale-offer `400` retries the next candidate and succeeds** — the Vast case, fact 2
4. **a no-capacity failure moves to a different SKU rather than retrying the same one** — the RunPod
   case, facts 4 and 5. Retrying the same offer must be provably not what happens.
5. retries are bounded, and exhausting them returns a structured error naming what was tried
6. the retry re-resolves against a **fresh** catalog, not the cached one — the load-bearing interaction
   from the section above. Assert the provider was re-queried.
7. `budget_cents` still applies to a resolved lease exactly as to an explicit one

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Implement**

Discriminate the two failures **on the provider's message**, since both arrive as `400`. The exact
strings, captured live:

- Vast stale offer — `Unknown SKU '<id>' for provider 'vast'.`
- RunPod no capacity — `create pod: There are no instances currently available`

Match defensively: these are provider prose and can change. An unrecognised `400` should behave like the
safer of the two — advance to the next candidate rather than retrying the same one, since retrying a
genuinely dead SKU cannot succeed while advancing merely costs one attempt.

- [ ] **Step 4: Run, then the full suite**

- [ ] **Step 5: Commit**

---

## Whole-branch verification

- [ ] Full suite green, no network.
- [ ] Confirm by name that the earlier deliverables still pass:
      `test_promoted_lease_is_not_reaped_at_the_provisioning_timeout`,
      `test_lease_without_a_budget_is_still_sized_to_the_full_plan_ttl`,
      `test_out_of_credit_release_of_a_managed_lease_uses_the_operator_key`,
      and the budget headline test.
- [ ] Confirm explicit `provider`/`sku` leases are unchanged — the dashboard's path.

## Acceptance criteria

1. Two `_catalog` calls inside the TTL cost one round of provider requests; `fresh=True` bypasses.
2. Users with different BYOK eligibility never share a cache entry.
3. `canonical()` maps real provider strings to one id, keeps the three H100 variants distinct, and
   returns `None` rather than guessing.
4. `resolve()` returns the globally cheapest match on the funding-adjusted rate, ordered, exercised at
   `count > 1`.
5. `{gpu, count}` leases without a caller-supplied SKU; explicit `provider`/`sku` is unchanged.
6. A stale-offer `400` retries the next candidate against a **fresh** catalog and succeeds.
7. A no-capacity failure advances to a different SKU rather than retrying the same one.
8. Retries are bounded and exhaustion returns a structured error.
9. `pytest` passes with no network access.

## Out of scope

The quote endpoint (change 4) — it consumes this resolver and is the next plan. Stock and reliability
filtering (change 10) — the signals are unrequested and the one heuristic tried was falsified; it needs
its own evidence. Volumes (6), budget extension (7), the rolling window cap (5), and the three
OpenScience tools.
