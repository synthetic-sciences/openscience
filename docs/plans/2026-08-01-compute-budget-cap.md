# Managed compute budget cap — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `hard_cap_cents` a ceiling that actually binds, and let a caller propose a budget — so a
managed GPU lease is bounded by the money authorised for it rather than by the user's entire wallet.

**Architecture:** All work is in the **Atlas** repo (`~/codes/InkVell/atlas`), continuing on
`feat/compute-lease-prerequisites`. Spec changes 1 and 2, which **must land together** — see below.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, pytest + pytest-asyncio.

**Spec:** `~/codes/InkVell/openscience/docs/specs/compute-design.md`, Part B changes 1 and 2.

## Global Constraints

- **Repo:** `~/codes/InkVell/atlas`, branch `feat/compute-lease-prerequisites` (already checked out).
  Do not create or switch branches.
- **Run tests with:** `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest <path> -q`.
  No activated virtualenv — always invoke `.venv/bin/python` explicitly.
- **Never add a `Co-Authored-By:` trailer or any AI/assistant attribution to commit messages.**
- **No mocks of our own code.** Use the real repo functions, real `tick_once`, `aiosqlite` +
  `run_migrations`, and a `_FakeProvider` at the boundary — the pattern in
  `backend/tests/test_compute_billing.py`.
- **Every new assertion must be shown failing first.** Paste the failure into your report.
- Baseline: full suite is **1670 passed, 1 skipped**. It must be green when each task finishes.
- Ignore `.claude/worktrees/`.

## Established facts — do not re-derive these

Verified in the source, and the last two against production:

1. **`tick_once`'s managed branch is cumulative and replay-safe**
   (`backend/app/services/compute_billing_service.py`, the `if funding == "managed":` branch):
   ```python
   elapsed_total = (now - started).total_seconds()      # started = started_at or created_at
   already       = int(lease.get("total_spent_cents") or 0)
   delta_cents   = wall_clock_cents(hourly, elapsed_total) - already
   if delta_cents <= 0: skip
   ```
   A replayed tick yields `delta <= 0` and skips. **The grant debit must mirror this shape.**
2. `wall_clock_cents(hourly, secs) = round(hourly * secs / 3600)` — `app/compute/provider_registry.py:10`.
3. **BYOK leases are skipped by the tick entirely** (`if funding == "byok": continue`), so they can never
   be charged and must never be grant-debited.
4. `compute_repo.debit_grant` is an **increment** with an atomic ceiling:
   `SET spent_cents = spent_cents + ? … WHERE grant_id = ? AND status = 'active' AND (spent_cents + ?) <= hard_cap_cents`.
5. **Acquire debits exactly one hour up front** and never refunds it —
   `first_hour_cents = int(price_cents_per_hour)` then `debit_grant(db, grant_id, first_hour_cents)` in
   `lease_manager.acquire_lease`.
6. The grant is sized at lease creation to `max_spend = max(charge_raw * ttl_hours, charge_raw, 1)` with
   `ttl_hours = gpu_sandbox_max_ttl_hours` = **24** on every plan — `app/routes/compute.py`.
7. `LeaseRequest` is `{provider, sku, region?, node_id?}` — no budget field today.
8. **Measured in production (2026-08-01):** a live 34¢/hr lease had `grant.hard_cap_cents = 816`
   (= 34 × 24), `grant.spent_cents = 34` **frozen**, while `lease.total_spent_cents` climbed 0 → 2 → 3 →
   5 → 6. The tick charges the wallet and never touches the grant, so `spent_cents` can never approach
   `hard_cap_cents`. **The cap is decorative.** That is the bug this plan fixes.

## The central design decision

The grant update is a **set-to-total, not an increment**:

```
grant.spent_cents := wall_clock_cents(hourly, elapsed_total)
```

Three things follow, and they are why an increment is wrong:

- **Replay safety comes for free.** It mirrors the tick's own cumulative model (fact 1). An increment is
  not replay-safe: a crash between the charge and the debit either double-counts on the next tick or
  loses the debit.
- **It supersedes the acquire-time one-hour debit instead of double-counting it.** This is the trap the
  spec records: a naive re-debit makes a $10 budget at $6.99/h die at 25.8 minutes instead of ~1.4 hours.
  A set writes the truth and the pre-tick placeholder simply disappears.
- **It preserves the full plan TTL.** At exactly 24h, `spent = 24 × rate = hard_cap`, and the guard is
  `<=`, so the lease survives its TTL and the next tick releases it. Adding the acquire debit on top
  (`wall_clock + rate`) would kill a no-budget lease at ~23h — a silent regression for the dashboard and
  `compute:up`, which is precisely why changes 1 and 2 must land together.

**Before the first tick the acquire debit still does its job**, bounding an un-ticked lease at one hour of
grant. Only once the tick runs does wall-clock become the truth.

---

### Task 1: An atomic set-to-total for grant spend

**Files:**

- Modify: `backend/app/db/repos/compute_repo.py` (add `set_grant_spend` beside `debit_grant`)
- Test: `backend/tests/test_compute_grant_spend.py` (new)

**Interfaces:**

- Produces: `async def set_grant_spend(db, grant_id: str, total_cents: int) -> bool` — sets
  `spent_cents` to `total_cents` when the grant is active and `total_cents <= hard_cap_cents`; returns
  `False` without writing when it would exceed the cap or the grant is not active. `debit_grant` is left
  untouched — other callers still use it.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_compute_grant_spend.py`. Follow the fixture style of
`backend/tests/test_compute_billing.py` (`aiosqlite` + `run_migrations` against a tmp DB). Cover:

1. a set below the cap writes the exact total and returns `True`
2. a set **equal** to the cap succeeds — the guard is `<=`, and this is what preserves the full TTL
3. a set above the cap returns `False` **and leaves `spent_cents` unchanged** (assert the row, not just
   the return value)
4. a set on a non-`active` grant returns `False`
5. it is idempotent — calling it twice with the same total leaves the same row

- [ ] **Step 2: Run and confirm they fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_grant_spend.py -q`
Expected: `ImportError` / `AttributeError` — `set_grant_spend` does not exist. Paste it.

- [ ] **Step 3: Implement**

In `backend/app/db/repos/compute_repo.py`, beside `debit_grant`:

```python
async def set_grant_spend(db, grant_id: str, total_cents: int) -> bool:
    """Set a grant's cumulative spend, refusing to exceed its ceiling.

    A SET rather than an increment, mirroring the billing tick, which charges
    ``wall_clock_cents(rate, elapsed_since_started) - total_spent_cents``. Both
    sides then derive from the same wall-clock truth, so a replayed tick is a
    no-op instead of a double count, and the one-hour debit ``acquire_lease``
    takes up front is superseded rather than added to.

    Returns False without writing when the total would exceed ``hard_cap_cents``
    or the grant is no longer active — the caller releases the lease.
    """
    now = _now()
    cursor = await db.execute(
        """
        UPDATE compute_grants
        SET spent_cents = ?, updated_at = ?
        WHERE grant_id = ?
          AND status = 'active'
          AND ? <= hard_cap_cents
        """,
        (total_cents, now, grant_id, total_cents),
    )
    await db.commit()
    return cursor.rowcount > 0
```

- [ ] **Step 4: Run and confirm they pass**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_grant_spend.py -q`
Then the full suite. Both green.

- [ ] **Step 5: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/db/repos/compute_repo.py backend/tests/test_compute_grant_spend.py
git commit -m "feat(compute): an atomic set-to-total for grant spend

debit_grant increments, which cannot mirror a billing tick that charges
cumulatively from started_at. set_grant_spend writes the total instead, so a
replayed tick is a no-op and the one-hour debit taken at acquire is superseded
rather than added to. Refuses above the ceiling without writing."
```

---

### Task 2: Make the cap bind

**Files:**

- Modify: `backend/app/services/compute_billing_service.py` (the `funding == "managed"` branch of
  `tick_once`)
- Test: `backend/tests/test_compute_billing.py` (append)

**Interfaces:**

- Consumes: `compute_repo.set_grant_spend` from Task 1.
- Produces: a managed lease is released once its grant ceiling is reached.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_compute_billing.py`. **The headline test is the first one** — the spec
records that both previous attempts at this change omitted it from their tests _and_ their acceptance
criteria, and that a $10 budget dying at 25.8 minutes passes every "a release happened" assertion while
being wrong by 3×.

1. **A budget of $B at $R/h lasts ≈ B/R hours.** Seed a grant with `hard_cap_cents = B`, a managed lease
   at `hourly_rate_cents = R`, drive `tick_once` with an injected `now` advancing in steps, and assert on
   the **elapsed billable duration at the moment of release** — not merely that a release occurred.
   Allow ±90s of rate: `COMPUTE_BILLING_TICK_SECONDS` (60) + `FIRST_BILL_GRACE_SECONDS` (30).
2. A tick whose new total fits under the cap does **not** release, and `grant.spent_cents` now equals
   `wall_clock_cents(rate, elapsed_total)` — proving it tracks rather than freezing at the acquire debit.
3. A tick whose new total would exceed the cap **charges the elapsed time first, then releases.** The
   user consumed that time and the operator owes the provider for it; skipping the charge loses real
   money. Assert both the wallet movement and the release.
4. A replayed tick (same injected `now`) neither double-charges the wallet nor moves `grant.spent_cents`.
5. **A BYOK lease is never grant-debited** — it is skipped before this code runs.
6. **A no-budget lease still runs its full plan TTL.** With `hard_cap = rate × 24`, the lease survives to
   24h. This is the regression guard for the acquire-debit interaction; if the implementation adds the
   acquire debit on top of wall-clock instead of superseding it, this test dies at ~23h.

- [ ] **Step 2: Run and confirm they fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_billing.py -q`
Paste the failures.

- [ ] **Step 3: Implement**

In the `funding == "managed"` branch, after the existing `mark_billed` call and before `continue`, set the
grant to the same wall-clock total the charge was derived from, and release when the ceiling refuses it:

```python
            grant_id = lease.get("grant_id")
            if grant_id:
                # Mirror the charge: the tick bills wall-clock-since-started
                # minus what was already billed, so the grant's cumulative
                # spend is that same wall-clock total. A set, not an increment —
                # see set_grant_spend. The one-hour debit taken at acquire is
                # superseded here, which is what keeps a no-budget lease alive
                # for its full plan TTL instead of dying an hour early.
                within = await compute_repo.set_grant_spend(
                    db, grant_id, wall_clock_cents(hourly, elapsed_total),
                )
                if not within:
                    # The approved money is spent. The charge above already
                    # captured the time actually used, which the user consumed
                    # and the operator owes the provider for.
                    logger.info(
                        "compute_billing: grant ceiling reached - releasing lease=%s",
                        lease_id,
                    )
                    await _safe_release(db, lease)
                    released += 1
                    continue
```

Import `wall_clock_cents` if it is not already in scope — it lives in `app.compute.provider_registry`.

**Order matters and is load-bearing:** charge → `mark_billed` → `set_grant_spend` → release on refusal.
Charging after the ceiling check would drop the final increment; setting the grant before the charge
would authorise money that was never taken.

- [ ] **Step 4: Run and confirm they pass**

Run the file, then `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q`. Both green.

- [ ] **Step 5: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/services/compute_billing_service.py backend/tests/test_compute_billing.py
git commit -m "fix(billing): make hard_cap_cents a ceiling that actually binds

The tick charged the wallet and never touched the grant, so spent_cents froze
at the one-hour debit taken at acquire and could never approach hard_cap_cents.
Measured in production: a 34c/hr lease with hard_cap 816c sat at spent 34c
while the lease accrued past it. The ceiling was decorative and the wallet was
the only real bound.

The tick now sets the grant to the same wall-clock total it charges from, and
releases when that total is refused."
```

---

### Task 3: Accept a budget on lease creation

**Files:**

- Modify: `backend/app/routes/compute.py` (`LeaseRequest`, and the grant sizing in `create_lease`)
- Test: `backend/tests/test_compute_resell_routes.py` (append)

**Interfaces:**

- Consumes: the binding cap from Task 2.
- Produces: `POST /api/compute/leases` accepts optional `budget_cents`; the response carries the
  **effective** cap actually authorised.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_compute_resell_routes.py`, following its existing route-test style:

1. **Omitting `budget_cents` preserves today's behaviour exactly** — the grant is still sized to
   `rate × ttl_hours`. Assert the grant row, since the dashboard and `compute:up` both call this endpoint
   without the field.
2. `budget_cents` present sizes the grant to it.
3. **A budget larger than the wallet is clamped, not rejected** — the wallet is always the outer bound —
   and the response reports the **effective** cap, not the asked-for one.
4. A budget that cannot fund the first hour is refused with the existing structured `402`, extended with
   `affordable_budget_cents`.
5. **BYOK ignores `budget_cents`** and is never grant-debited.

- [ ] **Step 2: Run and confirm they fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_resell_routes.py -q`
Paste the failures.

- [ ] **Step 3: Implement**

Add `budget_cents: int | None = None` to `LeaseRequest`. In `create_lease`, replace the fixed sizing:

```python
    max_spend = max(charge_raw * ttl_hours, charge_raw, 1)
```

with a budget-aware version that keeps the wallet as the outer bound. Read the current code around it
before editing — `charge_raw`, `ttl_hours` and the effective balance lookup are already in scope, and the
existing `402` for insufficient credit is the one to extend rather than duplicate.

Report the effective cap on the response so a caller can tell the user what was actually authorised.

- [ ] **Step 4: Run and confirm they pass**

Run the file, then the full suite. Both green.

- [ ] **Step 5: Commit** (message in the same style; state that absent `budget_cents` is unchanged
      behaviour, and that the wallet remains the outer bound)

---

### Task 4: The agent-spawn default becomes a hard kill

**Why:** `budget_cents` already exists on the agent-spawn path with a default of `500`
(`app/services/agent_tools.py`, plus `models/agent.py` and `spawn_queue_service.py`), where it is
**display-only** today. Task 2 makes caps real, so every already-shipped spawn silently acquires a hard
$5 ceiling. The spec calls this out explicitly: _"Not a no-op, and the previous draft called it one."_

**Files:** to be determined by Step 1 — do not guess.

- [ ] **Step 1: Investigate and report before changing anything**

Trace how the spawn path's `budget_cents` reaches `create_grant`, what `hard_cap_cents` it produces
today, and what a typical spawn actually costs. **Report:**

- the value a spawn's grant is currently created with
- whether $5 is above or below a realistic spawn cost, with a number
- whether spawn grants are the same `compute_grants` rows the billing tick now enforces against

- [ ] **Step 2: Choose and implement, having reported**

Two options the spec names — pick one on the evidence from Step 1 and say why:

- **raise the default deliberately** to a value chosen with enforcement in mind, or
- **exempt spawn-path grants** until their budgets are set with enforcement in mind.

Whichever you choose, add a test proving a spawn is not killed at a budget nobody chose.

- [ ] **Step 3: Commit**

---

## Whole-branch verification

- [ ] Full suite: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q` — green, no
      network.
- [ ] Confirm by name that the prior branch's deliverables still pass:
      `test_promoted_lease_is_not_reaped_at_the_provisioning_timeout`,
      `test_user_lease_without_runner_token_survives`,
      `test_class_4_managed_gpu_with_owner_key_never_uses_it`,
      `test_out_of_credit_release_of_a_managed_lease_uses_the_operator_key`.
- [ ] Confirm the headline property test exists and asserts on **elapsed billable duration**, not on the
      fact that a release happened.

## Acceptance criteria

1. A budget of $B at rate $R/h lasts B/R hours ± 90s of rate, asserted on elapsed billable duration.
2. `grant.spent_cents` tracks wall-clock spend instead of freezing at the acquire-time debit.
3. A tick exceeding the ceiling charges the elapsed time and then releases; one that fits does not.
4. A replayed tick neither double-charges the wallet nor moves `grant.spent_cents`.
5. A lease created without `budget_cents` runs its **full** plan TTL — asserted on runtime, not on the
   request being accepted.
6. `budget_cents` sizes the grant; a budget above the wallet is clamped and the response reports the
   effective cap; one that cannot fund the first hour is refused with a structured `402`.
7. BYOK leases ignore `budget_cents` and are never grant-debited.
8. An agent spawn is not killed at a budget nobody chose.
9. `pytest` passes with no network access.

## Out of scope

Rolling window cap across sequential leases (change 5), the resolver and quote endpoint (changes 3, 4,
12), volumes (6), budget extension (7), and the three OpenScience tools. A budget bounds one lease; it
does not yet bound release-and-reacquire.
