# Compute lease prerequisites — implementation plan

> ## ✅ EXECUTED — 2026-08-01. Historical record; do not implement from it again.
>
> **Where:** `~/codes/InkVell/atlas`, branch `feat/compute-lease-prerequisites`, base `8aa66d5`.
> **Not merged** — the PR is deliberately draft while the team waits for compute to be complete.
> **Outcome:** all four tasks landed, plus a six-finding fix wave from the whole-branch review.
> Suite **1610 passed / 1 skipped**, 12 commits at plan completion. Ledger:
> `.superpowers/sdd/2026-07-31-compute-lease-prerequisites/progress.md`.
>
> **The deliverable holds, and was later confirmed against a real provider rather than a fake clock:**
> a user lease sat `ready` for 578s → 687s → **788s** un-reaped against the deployed reaper. Before
> this branch it died at 600s. Task 1's deploy gate is discharged by a **cross-login test**: two
> instances on one Vast operator account, each key accepted for its own box and **refused**
> (`Permission denied (publickey)`) against the other's. The cross-tenant hole is closed, measured,
> not inferred.
>
> **What execution proved this plan wrong about — read these before trusting any step below:**
>
> - **Task 3's promotion was under-specified and the first fix for it broke Modal.** The fix wave
>   gated promotion on a non-empty `ssh_host`; Modal's `connection()` returns no `ssh_host` at all
>   (it is exec-based, no SSH), so Modal CPU sandboxes stopped promoting and were reaped at 600s.
>   The gate is now `if not ssh_host and lease.get("ssh_key_name")` — the four SSH providers set
>   `ssh_key_name` in `acquire`, Modal does not. The gate itself was **justified by measurement**,
>   not taste: RunPod returns `desiredStatus=RUNNING` from pod creation with **no address**, so
>   provider status alone is not readiness. This plan's Step 5 does not say any of that.
> - **The status mapping was wrong for a destroyed Vast instance.** `_get_instance` returned `{}` and
>   `_map_status` read that as `provisioning` **forever**, so reaper branch 1 could never fire for
>   Vast. Fixed in `9bc19a7` (empty payload → `terminated`). Later sharpened again: Vast returns
>   HTTP 200 `{"instances": null}` for a destroyed id **and** for one that never existed, and never
>   404s, while RunPod does 404 — both signals are needed.
> - **Task 4's `_PROVISIONING` set omitted Lambda's in-flight strings.** Flagged during the task and
>   deliberately left for a human ruling; fixed in the follow-on plan (`8748057`).
> - **Task 1's minor deferral is still open:** `vast_provider`'s docstring API list still names
>   `POST /ssh/` — the endpoint the task removed the call to.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the live cross-tenant SSH exposure on Vast, and make a user-launched GPU lease survive long
enough to be usable — the two things every other compute change waits on.

**Architecture:** All four tasks are in the **Atlas** repo (`~/codes/InkVell/atlas`), Python/FastAPI. Task 1
removes an account-level SSH key registration. Tasks 2–3 fix the lease reaper: today a managed GPU lease
never leaves `provisioning` status, so it is reaped as a provisioning timeout ~10 minutes after creation.
Task 4 normalises the status vocabulary the OpenScience client will later poll on.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, pytest + pytest-asyncio, respx (HTTP mocking), httpx.

**Spec:** `~/codes/InkVell/openscience/docs/specs/compute-design.md` — changes 9(a), 0(a), 0(b), 0(c).

## Global Constraints

- **Repo:** `~/codes/InkVell/atlas`. All paths below are relative to that repo root.
- **Run tests with:** `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest <path> -q`
  There is no activated virtualenv; always invoke `.venv/bin/python` explicitly.
- **Branch:** work on `feat/compute-lease-prerequisites`, cut from `main`. The repo is currently on
  `feat/managed-catalog-opus5-frontier`, which is unrelated work — **do not commit onto it.**
- **Never add a `Co-Authored-By:` trailer or any AI attribution to commits.** Organisation rule.
- **No mocks of our own code.** Stub HTTP at the transport boundary with `respx`; use the real repo and
  provider objects. This matches the existing suite.
- **Every new assertion must be shown failing first.** Run the test before writing the implementation and
  paste the failure. A test that has never failed is not evidence.
- **Ignore `.claude/worktrees/`** — other branches, will mislead greps.
- Baseline before starting: `.venv/bin/python -m pytest tests/test_lease_reaper.py -q` → **7 passed**.

---

### Task 0: Branch setup

- [ ] **Step 1: Cut the branch from main**

```bash
cd ~/codes/InkVell/atlas
git fetch origin
git checkout -b feat/compute-lease-prerequisites origin/main
```

- [ ] **Step 2: Confirm the baseline suite passes**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py tests/test_compute_providers.py -q`
Expected: all pass. If anything fails here, stop and report — it is pre-existing and not yours to fix.

---

### Task 1: Vast must not register account-level SSH keys

**Why:** `VastProvider.acquire` posts every lease's public key to the **shared operator account**
(`POST /ssh/`), and the module docstring says the purpose is "so new instances pick it up"
(`app/compute/vast_provider.py:10-12`). Under managed funding all users share one operator credential
(`:78`), so one user's private key opens another user's instance. The per-instance attach at `:244-248`
already exists and its comment describes it as the path that works "even if the account key wasn't applied
at launch" — i.e. it is the reliable one.

**Files:**

- Modify: `backend/app/compute/vast_provider.py:202-213` (remove the account POST), `:10-16` (docstring)
- Create: `backend/tests/test_compute_vast_provider_http.py`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. Standalone security fix.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_compute_vast_provider_http.py`:

```python
"""HTTP-contract tests for the Vast provider.

Regression anchor: ``acquire`` must NOT register the per-lease public key on
the Vast *account*. Managed leases all run on one operator credential, so an
account-level key is readable by every subsequently created instance — one
user's private key would open another user's box. The per-instance attach is
the only key path.
"""

from __future__ import annotations

import httpx
import respx

from app.compute.vast_provider import VAST_API, VastProvider

CREDS = {"secret": "vast-test-key"}


@respx.mock
async def test_acquire_registers_no_account_ssh_key():
    account = respx.post(f"{VAST_API}/ssh/").mock(
        return_value=httpx.Response(200, json={})
    )
    respx.put(f"{VAST_API}/asks/9999/").mock(
        return_value=httpx.Response(200, json={"new_contract": 4242})
    )
    instance = respx.post(f"{VAST_API}/instances/4242/ssh/").mock(
        return_value=httpx.Response(200, json={})
    )

    lease = await VastProvider().acquire("9999", "us", user_credentials=CREDS)

    assert lease["lease_id"] == "4242"
    assert instance.called, "the per-instance key attach is the only key path"
    assert not account.called, "account-level key registration is cross-tenant readable"


@respx.mock
async def test_acquire_still_returns_the_private_key():
    respx.put(f"{VAST_API}/asks/9999/").mock(
        return_value=httpx.Response(200, json={"new_contract": 4242})
    )
    respx.post(f"{VAST_API}/instances/4242/ssh/").mock(
        return_value=httpx.Response(200, json={})
    )

    lease = await VastProvider().acquire("9999", "us", user_credentials=CREDS)

    assert lease["ssh_private_key"].startswith("-----BEGIN")
    assert lease["ssh_public_key"].startswith("ssh-ed25519")
    assert lease["status"] == "provisioning"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_vast_provider_http.py -q`
Expected: `test_acquire_registers_no_account_ssh_key` FAILS on
`assert not account.called`. The second test should already pass — it pins behaviour we must not break.
**Paste the failure output into your report.**

- [ ] **Step 3: Remove the account-level registration**

In `backend/app/compute/vast_provider.py`, delete this block from `acquire` (currently `:203-213`):

```python
            # Register the public key on the account so the new instance
            # picks it up; best-effort (a content-identical key may already
            # exist, which Vast tolerates).
            try:
                await client.post(
                    f"{VAST_API}/ssh/",
                    headers=headers,
                    json={"ssh_key": public_openssh},
                )
            except Exception:  # noqa: BLE001
                pass
```

Then update the per-instance attach comment (currently `:240-241`) to say it is the only key path:

```python
            # Attach the per-lease key to the instance. This is the ONLY key
            # path: the account-level POST /ssh/ that used to run here made the
            # key readable by every instance created afterwards on the same
            # (shared, operator) account.
```

- [ ] **Step 4: Correct the module docstring**

Replace lines 10-16 of `backend/app/compute/vast_provider.py`:

```python
SSH: Atlas generates a fresh keypair per lease and attaches the *public* key
to the instance (``POST /instances/{id}/ssh/``). It is deliberately NOT
registered on the account (``POST /ssh/``): managed leases share one operator
credential, so an account key is picked up by every instance created after it,
which would let one user's private key open another user's box.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_vast_provider_http.py tests/test_compute_providers.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/compute/vast_provider.py backend/tests/test_compute_vast_provider_http.py
git commit -m "fix(vast): stop registering per-lease SSH keys on the shared account

acquire posted each lease's public key to the operator account so that new
instances would pick it up. Managed leases all run on one operator credential,
so every instance created afterwards accepted that key -- one user's private
key opened another user's box.

The per-instance attach already present is the only key path needed; its own
comment described it as working even when the account key was not applied."
```

- [ ] **Step 7: Flag the deploy gate in your report**

This cannot be fully verified without a live Vast launch. **State in your report** that before this
deploys, someone must lease one real Vast box and confirm SSH still works with the returned key. The
code comment suggests the per-instance attach is sufficient; that is an inference, not a measurement.

---

### Task 2: Scope heartbeat reaping to leases that can answer it

**Why:** `sweep_once` branch 3 reaps any non-`provisioning` lease whose telemetry is stale past
`HEARTBEAT_STALE_SECONDS` (600). `create_lease` mints no runner token — `set_runner_api_key` has exactly
one caller, the agent-spawn path — so a user lease can never emit telemetry and can never pass this check.
Task 3 makes leases reach a non-`provisioning` status, which is what would expose this; do it first so the
two land in either order safely.

The predicate is the **`runner_api_key_id` column** (`backend/app/db/migrations.py:567`). Do not confuse it
with the `thrk_*` runner token in the `runner_tokens` table — different credential, different table.

**Files:**

- Modify: `backend/app/jobs/lease_reaper.py:138-144`
- Test: `backend/tests/test_lease_reaper.py` (append)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing. Behaviour change only.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_lease_reaper.py`:

```python
@pytest.mark.asyncio
async def test_user_lease_without_runner_token_is_not_heartbeat_reaped(test_db, monkeypatch):
    """A user-launched lease has no runner token, so it can never emit
    telemetry. Reaping it for heartbeat staleness destroys a box the user is
    paying for, ~10 minutes after it becomes ready."""
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Luser", status="ready",
        user_id=uid, provider="runpod", requested_sku="h100", region="us",
        hourly_rate_cents=279, category="gpu")
    # No telemetry at all, and created long ago -> branch 3 would fire today.
    old = _iso(datetime.now(timezone.utc) - timedelta(seconds=9999))
    await db.execute(
        "UPDATE compute_leases SET created_at = ?, started_at = ? WHERE lease_id = 'Luser'",
        (old, old))
    await db.commit()

    class _P:
        async def status(self, _id): return {"status": "running"}
    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())
    async def _noop_release(self, _db, _lease): return {"status": "released"}
    monkeypatch.setattr(reaper.LeaseManager, "release_lease", _noop_release)

    n = await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    assert n == 0
    row = await compute_repo.get_lease(db, "Luser")
    assert row["status"] == "ready"


@pytest.mark.asyncio
async def test_agent_lease_with_runner_token_is_still_heartbeat_reaped(test_db, monkeypatch):
    """The narrowing must not disable the check for leases that CAN report."""
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Lagent", status="ready",
        user_id=uid, provider="modal", requested_sku="cpu-small", region="us",
        hourly_rate_cents=0, category="cpu", node_id="na")
    old = _iso(datetime.now(timezone.utc) - timedelta(seconds=9999))
    await db.execute(
        "UPDATE compute_leases SET created_at = ?, started_at = ?, "
        "runner_api_key_id = 'thk_test' WHERE lease_id = 'Lagent'", (old, old))
    await db.commit()

    class _P:
        async def status(self, _id): return {"status": "running"}
    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())
    reaped = []
    async def _fake_reconcile(_db, *, lease_id, node_id, forced_state=None, reason=None):
        reaped.append((lease_id, reason)); return {"outcome": "failed"}
    monkeypatch.setattr(reaper.run_reconcile_service, "reconcile_completed_run", _fake_reconcile)
    async def _noop_release(self, _db, _lease): return {"status": "released"}
    monkeypatch.setattr(reaper.LeaseManager, "release_lease", _noop_release)

    n = await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    assert n == 1
    assert reaped[0] == ("Lagent", "heartbeat_timeout")
```

- [ ] **Step 2: Run to verify the first fails and the second passes**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q`
Expected: `test_user_lease_without_runner_token_is_not_heartbeat_reaped` FAILS (`assert 1 == 0`).
`test_agent_lease_with_runner_token_is_still_heartbeat_reaped` PASSES already — it pins the behaviour the
narrowing must preserve. **Paste the failure.**

- [ ] **Step 3: Narrow branch 3**

In `backend/app/jobs/lease_reaper.py`, replace the branch-3 block:

```python
        # 3. Heartbeat staleness — only for leases that have actually booted
        # AND are supposed to report. A still-`provisioning` lease legitimately
        # has no telemetry yet (PROVISION_TIMEOUT_SECONDS governs it), and a
        # user-launched lease is issued no runner token at all, so it can never
        # emit telemetry — reaping it would destroy a box the user is paying
        # for. `runner_api_key_id` is set only by the agent-spawn path.
        if (
            reason is None
            and lease.get("status") != "provisioning"
            and lease.get("runner_api_key_id")
        ):
            latest = _parse_iso(live["latest_at"]) or _lease_started(lease)
            if latest and (now - latest).total_seconds() > config.HEARTBEAT_STALE_SECONDS:
                reason = "heartbeat_timeout"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q`
Expected: 9 passed. If `test_sweep_reaps_heartbeat_stale` (the pre-existing one) now fails, its fixture
lease has no `runner_api_key_id` — **fix the fixture, not the predicate**: add
`runner_api_key_id = 'thk_test'` to that lease, since it models an agent-spawned lease.

- [ ] **Step 5: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/jobs/lease_reaper.py backend/tests/test_lease_reaper.py
git commit -m "fix(reaper): heartbeat staleness only applies to leases with a runner token

create_lease mints no runner token, so a user-launched lease can never emit
telemetry and can never satisfy the heartbeat check. It stayed bounded by plan
TTL, wallet exhaustion and explicit release; it does not need a liveness probe
it has no way to answer."
```

---

### Task 3: Promote a provisioning lease to ready and persist its SSH coordinates

**Why:** two facts combine into the defect. `RunPodProvider.acquire` returns `status: "provisioning"` and
`create_lease` persists it; and the only two writers that flip a lease to `ready` are
`_reconcile_active_cpu_leases` (CPU-only, `lease_manager.py:270`) and `LeaseManager.get_lease_status`,
which has **no production caller** (`:690`; only two test callers). So a managed GPU lease stays
`provisioning` forever and branch 2 reaps it at `PROVISION_TIMEOUT_SECONDS` = 600.

Separately, `acquire` returns a hardcoded `ssh_port: 22` and no `ssh_host` on every provider — the real
values live only in `provider.connection()`. `update_lease_status` already accepts them
(`compute_repo.py:397-405`) and nothing passes them.

Do both in the reaper sweep, which already runs every 60s and **already calls `provider.status()` for
every unfinished lease** at branch 1 — so the promotion check costs no extra provider call. The
`connection()` call happens once, on the transition only.

**Files:**

- Modify: `backend/app/jobs/lease_reaper.py` (add `_PROVIDER_READY`, add promotion between branches 1 and 2)
- Test: `backend/tests/test_lease_reaper.py` (append)

**Interfaces:**

- Consumes: nothing.
- Produces: leases now reach `status = "ready"` with `ssh_host` / `ssh_port` / `ready_at` populated. Task 4
  and all later compute work depend on this.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_lease_reaper.py`:

```python
@pytest.mark.asyncio
async def test_sweep_promotes_provisioning_lease_and_persists_ssh(test_db, monkeypatch):
    """A GPU lease is created 'provisioning' and nothing in production ever
    moves it. The sweep must promote it once the provider says it is up, and
    record the SSH coordinates, which acquire() cannot know."""
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Lprom", status="provisioning",
        user_id=uid, provider="runpod", requested_sku="h100", region="us",
        hourly_rate_cents=279, category="gpu")

    class _P:
        async def status(self, _id): return {"status": "running"}
        async def connection(self, _id, **kw):
            return {"status": "running", "ssh_host": "194.68.245.162",
                    "ssh_port": 22065, "ssh_user": "root"}
    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())

    n = await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    assert n == 0  # promotion is not a reap
    row = await compute_repo.get_lease(db, "Lprom")
    assert row["status"] == "ready"
    assert row["ssh_host"] == "194.68.245.162"
    assert row["ssh_port"] == 22065
    assert row["ready_at"] is not None


@pytest.mark.asyncio
async def test_sweep_does_not_promote_a_lease_still_booting(test_db, monkeypatch):
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Lboot", status="provisioning",
        user_id=uid, provider="runpod", requested_sku="h100", region="us",
        hourly_rate_cents=279, category="gpu")

    class _P:
        async def status(self, _id): return {"status": "provisioning"}
        async def connection(self, _id, **kw):
            raise AssertionError("connection() must not be called before the provider is up")
    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())

    await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    row = await compute_repo.get_lease(db, "Lboot")
    assert row["status"] == "provisioning"
    assert row["ready_at"] is None


@pytest.mark.asyncio
async def test_promotion_survives_a_connection_failure(test_db, monkeypatch):
    """Provider is up but connection() errors: still promote, so the lease is
    not reaped as a provisioning timeout. Coordinates arrive on a later sweep."""
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Lconn", status="provisioning",
        user_id=uid, provider="runpod", requested_sku="h100", region="us",
        hourly_rate_cents=279, category="gpu")

    class _P:
        async def status(self, _id): return {"status": "running"}
        async def connection(self, _id, **kw): raise RuntimeError("provider 503")
    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())

    await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    row = await compute_repo.get_lease(db, "Lconn")
    assert row["status"] == "ready"
    assert row["ssh_host"] is None


@pytest.mark.asyncio
async def test_promoted_lease_is_not_reaped_at_the_provisioning_timeout(test_db, monkeypatch):
    """The headline property: a user lease created 20 minutes ago survives.
    Today it dies at PROVISION_TIMEOUT_SECONDS = 600."""
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Llive", status="provisioning",
        user_id=uid, provider="runpod", requested_sku="h100", region="us",
        hourly_rate_cents=279, category="gpu")
    old = _iso(datetime.now(timezone.utc) - timedelta(seconds=1200))
    await db.execute(
        "UPDATE compute_leases SET created_at = ?, started_at = ? WHERE lease_id = 'Llive'",
        (old, old))
    await db.commit()

    class _P:
        async def status(self, _id): return {"status": "running"}
        async def connection(self, _id, **kw):
            return {"ssh_host": "1.2.3.4", "ssh_port": 20095, "ssh_user": "root"}
    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())
    async def _noop_release(self, _db, _lease): return {"status": "released"}
    monkeypatch.setattr(reaper.LeaseManager, "release_lease", _noop_release)

    n = await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    assert n == 0, "a live 20-minute-old lease must not be reaped"
    row = await compute_repo.get_lease(db, "Llive")
    assert row["status"] == "ready"
```

- [ ] **Step 2: Run to verify all four fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q -k "promot or booting or conn or reaped_at_the"`
Expected: `test_sweep_promotes...` FAILS (`status == 'provisioning'`),
`test_promotion_survives_a_connection_failure` FAILS, `test_promoted_lease_is_not_reaped...` FAILS
(`assert 1 == 0` — it was reaped). `test_sweep_does_not_promote_a_lease_still_booting` passes already.
**Paste the failures.**

- [ ] **Step 3: Add the ready-state set**

In `backend/app/jobs/lease_reaper.py`, below `_PROVIDER_TERMINAL` (line 34):

```python
# Provider vocabularies for "the box is up". RunPod and Vast say "running",
# Prime Intellect says "active", Lambda passes its upstream string through.
_PROVIDER_READY = {"running", "active", "ready"}
```

- [ ] **Step 4: Add the promotion helper**

In `backend/app/jobs/lease_reaper.py`, above `sweep_once`:

```python
async def _promote_to_ready(db, provider, lease: dict) -> None:
    """A provisioning lease whose provider reports it up becomes `ready`, with
    the SSH coordinates acquire() could not know.

    Without this a managed GPU lease stays `provisioning` forever — the only
    other writers of `ready` are CPU-scoped or have no production caller — and
    branch 2 reaps it at PROVISION_TIMEOUT_SECONDS. Coordinates are best-effort:
    promotion must happen even if connection() fails, or the lease is reaped
    while the box is alive. A later sweep fills them in.
    """
    ssh_host = ssh_port = None
    try:
        conn = (await provider.connection(lease["lease_id"])) or {}
        ssh_host = conn.get("ssh_host") or None
        ssh_port = conn.get("ssh_port") or None
    except Exception:
        log.exception("reaper: connection lookup failed for %s", lease["lease_id"])
    await compute_repo.update_lease_status(
        db, lease["lease_id"], "ready", ssh_host=ssh_host, ssh_port=ssh_port,
    )
    lease["status"] = "ready"
```

- [ ] **Step 5: Call it from the sweep**

In `sweep_once`, insert immediately after branch 1's `if provider is not None:` block and **before**
branch 2 (currently line 132). The provider status was already fetched at branch 1; reuse it:

```python
        # 1b. Promotion. `acquire` returns status='provisioning' and nothing
        # else in production advances it, so without this every managed GPU
        # lease is reaped by branch 2 at PROVISION_TIMEOUT_SECONDS.
        if (
            reason is None
            and lease.get("status") == "provisioning"
            and provider is not None
            and (pstat.get("status") or "").lower() in _PROVIDER_READY
        ):
            await _promote_to_ready(db, provider, lease)
```

`pstat` is bound inside `if provider is not None:` at branch 1. Hoist its initialisation so it is always
defined — change the top of branch 1 from `if provider is not None:` to:

```python
        pstat: dict = {}
        provider = get_provider((lease.get("provider") or "").lower())
        if provider is not None:
```

and delete the now-redundant `pstat = {}` assignments inside the `try`/`except` — keep
`pstat = (await provider.status(lease_id)) or {}` in the `try` and `pstat = {}` in the `except`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q`
Expected: 13 passed.

- [ ] **Step 7: Run the wider compute suite for regressions**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q -k "compute or lease or telemetry"`
Expected: all pass. Report any failure rather than fixing it if it looks unrelated.

- [ ] **Step 8: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/jobs/lease_reaper.py backend/tests/test_lease_reaper.py
git commit -m "fix(reaper): promote provisioning leases to ready and record SSH coordinates

A managed GPU lease was created 'provisioning' and nothing in production ever
advanced it: the only writers of 'ready' are the CPU-scoped reconcile pass and
get_lease_status, which has no production caller. So every user lease was
reaped as a provisioning timeout ~10 minutes after creation.

The sweep already polls provider.status for each unfinished lease, so the
promotion check is free. connection() runs once on the transition, and its
failure must not block promotion -- a lease left provisioning gets reaped while
the box is alive. This also populates ssh_host/ssh_port, which acquire() cannot
know: every provider returns a hardcoded port 22 and no host."
```

---

### Task 4: Normalise the lease status vocabulary

**Why:** `GET /api/compute/leases/{id}/connection` returns
`conn.get("status") or lease.get("status")` (`backend/app/routes/compute.py:500`) — one field carrying five
vocabularies. RunPod maps `running|stopped|terminated|unknown`, Vast `running|provisioning|stopped|unknown`,
Prime `provisioning|active|stopped|error|terminating|terminated|unknown`, Lambda passes its raw upstream
string through unmapped, and when the provider call throws it falls back to the DB's
`provisioning|ready|released`. A client cannot poll on that. Add a normalised field; **do not change
`status`**, which the dashboard consumes.

**Files:**

- Modify: `backend/app/routes/compute.py:450-508` (add `state` to the response)
- Create: `backend/app/compute/lease_state.py`
- Test: `backend/tests/test_compute_lease_state.py`

**Interfaces:**

- Consumes: Task 3's `ready` status.
- Produces: `normalise_state(raw: str | None) -> str` in `app/compute/lease_state.py`, returning one of
  `"provisioning" | "ready" | "terminated" | "unknown"`. The `/connection` response gains a `state` field
  with that value. The OpenScience `compute_launch` readiness poll will consume it.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_compute_lease_state.py`:

```python
"""One vocabulary for lease state.

/connection returns `conn.get("status") or lease.get("status")`, which mixes
four provider vocabularies with the DB's own. A client polling for readiness
cannot be written against that: "running" never appears on the DB path,
"ready" never appears on the provider path, Prime says "active", and Lambda
passes its upstream string through unmapped.
"""

from __future__ import annotations

import pytest

from app.compute.lease_state import normalise_state


@pytest.mark.parametrize("raw", ["running", "active", "ready", "RUNNING", "Active"])
def test_up_states_normalise_to_ready(raw):
    assert normalise_state(raw) == "ready"


@pytest.mark.parametrize(
    "raw", ["terminated", "released", "stopped", "failed", "error", "TERMINATED"]
)
def test_dead_states_normalise_to_terminated(raw):
    assert normalise_state(raw) == "terminated"


@pytest.mark.parametrize("raw", ["provisioning", "terminating", "PROVISIONING"])
def test_in_flight_states_normalise_to_provisioning(raw):
    assert normalise_state(raw) == "provisioning"


@pytest.mark.parametrize("raw", [None, "", "unknown", "some-lambda-string"])
def test_unrecognised_states_are_unknown_not_ready(raw):
    """Fail toward 'unknown'. A client must never read an unmapped Lambda
    string as readiness and try to SSH into a box that is still booting."""
    assert normalise_state(raw) == "unknown"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_lease_state.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.compute.lease_state'`. **Paste it.**

- [ ] **Step 3: Write the implementation**

Create `backend/app/compute/lease_state.py`:

```python
"""Normalise the five lease-status vocabularies into one.

`/connection` returns `conn.get("status") or lease.get("status")`, so the same
field carries whichever provider answered plus the DB's own values. Callers
that need to act on readiness use `state`, not `status`.

`status` is left untouched: the dashboard renders it.
"""

from __future__ import annotations

_READY = {"running", "active", "ready"}
_TERMINATED = {"terminated", "released", "stopped", "failed", "error"}
_PROVISIONING = {"provisioning", "terminating", "pending", "starting"}


def normalise_state(raw: str | None) -> str:
    """Map a provider or DB status onto provisioning | ready | terminated |
    unknown.

    Unrecognised input is `unknown`, never `ready` — Lambda passes its upstream
    string through unmapped, and a client that read an unknown string as
    readiness would SSH into a box that is still booting.
    """
    value = (raw or "").strip().lower()
    if value in _READY:
        return "ready"
    if value in _TERMINATED:
        return "terminated"
    if value in _PROVISIONING:
        return "provisioning"
    return "unknown"
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_lease_state.py -q`
Expected: 18 passed.

- [ ] **Step 5: Expose it on the connection endpoint**

In `backend/app/routes/compute.py`, add the import near the other local imports inside
`lease_connection`, and add one key to the returned dict (after `"status"`):

```python
    from app.compute.lease_state import normalise_state
```

```python
        "status": conn.get("status") or lease.get("status"),
        # Normalised: provisioning | ready | terminated | unknown. Poll on this,
        # not on `status`, which carries whichever provider vocabulary answered.
        "state": normalise_state(conn.get("status") or lease.get("status")),
```

- [ ] **Step 6: Verify the route still passes its suite**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q -k "compute"`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/compute/lease_state.py backend/tests/test_compute_lease_state.py backend/app/routes/compute.py
git commit -m "feat(compute): normalise lease state into one vocabulary

/connection's status field carries whichever of four provider vocabularies
answered, or the DB's own when the provider call throws. 'running' never
appears on the DB path, 'ready' never on the provider path, Prime says
'active', and Lambda passes its upstream string through unmapped -- so a
readiness poll cannot be written against it.

Adds a `state` field: provisioning | ready | terminated | unknown. Unmapped
input is 'unknown', never 'ready'. `status` is unchanged; the dashboard reads
it."
```

---

## Whole-branch verification

- [ ] **Step 1: Full compute suite**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q -k "compute or lease or reaper or telemetry"`
Expected: all pass, no network access required.

- [ ] **Step 2: Confirm the headline property holds end to end**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q -v`
Confirm by name that both of these pass:
`test_promoted_lease_is_not_reaped_at_the_provisioning_timeout` and
`test_user_lease_without_runner_token_is_not_heartbeat_reaped`.
**Together they are the deliverable:** a user lease now survives both reaper branches that killed it.

- [ ] **Step 3: Report the deploy gates**

Two things this plan cannot verify, both of which must be stated in the final report:

1. **Task 1 needs a live Vast launch** to confirm SSH works without the account key.
2. **Nothing here has run against a real provider.** These are source-level fixes with unit coverage; the
   spec's own record is that four source-read conclusions were wrong about deployed behaviour.

---

## Out of scope for this plan

Budget caps (spec changes 1–2), the resolver and quote endpoint (3–4), rolling window cap (5), volumes (6),
budget extension (7), release honesty (8), the SSH key-id lifecycle (9b), boot telemetry (10), image
pinning (11), catalog cache (12), orphan reap (13), and all three OpenScience tools. Each needs this plan
landed first — until a lease survives, none of them can be observed to work.
