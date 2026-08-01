# Compute lease defects — implementation plan

> ## ✅ EXECUTED — 2026-08-01. Historical record; do not implement from it again.
>
> **Where:** `~/codes/InkVell/atlas`, branch `feat/compute-lease-prerequisites` (continuing).
> **Not merged** — the PR is deliberately draft while the team waits for compute to be complete.
> **Outcome:** all four tasks landed (`b8a4467`, `0eb33c2`, `f65dd47`, `8748057`), followed by an
> eight-commit fix wave closing nine review findings. Ledger:
> `.superpowers/sdd/2026-08-01-compute-lease-defects/progress.md`.
>
> **This branch was then deployed and driven end to end**, which is the part that matters: on a
> deployed backend, `POST /api/compute/leases` → the real reaper promoted within one sweep with
> **NATed** SSH coordinates (`ssh3.vast.ai:15650`, `194.68.245.163:22189` — never the placeholder
> `22`) → SSH into a real GPU → release, with the instance verified gone at the provider. Done on
> **both** Vast and RunPod. Prime Intellect no longer leaks a key per lease; provider releases now
> report what actually happened; BYOK leases are polled with the owner's credential and managed
> leases never are.
>
> **What execution proved wrong — including one finding that was wrong in the safe-looking direction:**
>
> - **A review finding was overturned by a live probe.** Finding M9 required an explicit `404` before
>   treating a Vast instance as gone. Vast returns HTTP **200 `{"instances": null}`** for a destroyed
>   id _and_ for an id that never existed — it never 404s — so M9 would have silently reversed
>   `9bc19a7`, itself live-verified. The `410` it cited was on the `/instances/` **listing** endpoint,
>   a different call. Corrected by restoring the null-payload verdict and guarding the original
>   concern properly: two consecutive terminal observations before reaping.
> - **Deploying found a real bug nothing else would have.** `uvicorn --workers 2` runs the lifespan in
>   both workers, both ran `run_migrations` against the same sqlite file, both saw `provider_key_id`
>   absent, both `ALTER`ed, one crashed with `duplicate column name` and failed startup. A
>   **pre-existing pattern** at all 22 `ADD COLUMN` sites that this branch's new column exposed. Fixed
>   in `84bbbb7`.
> - **A tempting heuristic was falsified.** "Offers present in consecutive catalog fetches are
>   launchable" had perfect separation at n=8 retrospectively, and **failed its first prospective
>   test**. Retracted, along with the claim that spec change 12's cache would give change 3 its
>   correctness fix for free. Retry remains unavoidable.
> - **Task 3 carries a caveat that is still open:** Prime's `DELETE /ssh_keys/{id}` is
>   documentation-verified only, never exercised against production. It fails safe — the delete is
>   swallowed and cannot block the pod teardown — so a wrong endpoint would leak silently.
> - **Measured facts this plan did not anticipate**, now feeding spec changes 3 and 10: Vast offer ids
>   churn **~50% between two consecutive catalog fetches** (7 consecutive `Unknown SKU` failures
>   across price ranks 0–25); RunPod advertises GPU types with **zero capacity** and its `500` is
>   mapped to a `400` — the same status as Vast's stale offer, with a different message, so a
>   resolver must discriminate on the message because the two need opposite responses.
> - **Two openscience fixes came out of this wave**, on `feat/compute-guardrails`: `784633e` (stop
>   claiming managed compute at a zero balance) and `a732396d` (tmpfs the XDG cache dir so
>   `bubblewrap` stops failing tools with "Read-only file system").

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four known-unfixed defects in the managed-lease path that live testing and review
surfaced but the prerequisites branch deliberately left alone.

**Architecture:** All four tasks are in the **Atlas** repo (`~/codes/InkVell/atlas`), continuing on the
`feat/compute-lease-prerequisites` branch. Two are provider-level correctness (Vast release honesty, Prime
key lifecycle), one restores a whole lease class to the promotion path (BYOK), one is a status-mapping
gap.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, pytest + pytest-asyncio, respx, httpx.

**Spec:** `~/codes/InkVell/openscience/docs/specs/compute-design.md` — change 9(b), plus defects recorded
in `.superpowers/sdd/2026-07-31-compute-lease-prerequisites/progress.md`.

## Global Constraints

- **Repo:** `~/codes/InkVell/atlas`, branch `feat/compute-lease-prerequisites` (already checked out).
  Do not create or switch branches.
- **Run tests with:** `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest <path> -q`.
  No activated virtualenv — always invoke `.venv/bin/python` explicitly.
- **Never add a `Co-Authored-By:` trailer or any AI/assistant attribution to commit messages.**
- **No mocks of our own code.** Stub HTTP at the transport boundary with `respx`; use real repo functions
  and the real `sweep_once`, matching `backend/tests/test_lease_reaper.py` and
  `backend/tests/test_compute_vast_provider_http.py`.
- Provider HTTP tests use `@respx.mock` only — **no** `@pytest.mark.asyncio` (pytest-asyncio is in auto
  mode).
- **Every new assertion must be shown failing first.** Paste the failure into your report.
- Baseline: full suite is **1610 passed, 1 skipped**. It must be green when each task finishes.
- Ignore `.claude/worktrees/`.

---

### Task 1: BYOK GPU leases can never be promoted, so they still die at 600s

**Why:** `sweep_once` polls providers with no user credentials — the module's own comment concedes it
(`backend/app/jobs/lease_reaper.py`, branch 1: _"status is polled WITHOUT BYOK user_credentials, so
GPU/BYOK leases can't be classified here"_). For a BYOK lease `provider.status()` either raises or returns
`not_configured`, so `pstat` never matches `_PROVIDER_READY`, promotion never runs, the lease stays
`provisioning`, and branch 2 reaps it at `PROVISION_TIMEOUT_SECONDS`. `release_lease` **does** use BYOK
credentials, so the user's own paid instance is genuinely destroyed.

`LeaseManager` already has the helper: `_credentials_for_lease(db, lease)`
(`backend/app/compute/lease_manager.py`), which returns BYOK creds for a stored lease or `None`.

**Files:**

- Modify: `backend/app/jobs/lease_reaper.py` — branch 1's `status()` call, and the `connection()` call
  inside `_promote_to_ready` / `_backfill_coordinates`
- Test: `backend/tests/test_lease_reaper.py` (append)

**Interfaces:**

- Consumes: `_credentials_for_lease(db, lease) -> dict | None` from `app.compute.lease_manager`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Read the current call sites**

Read `sweep_once`'s branch 1 and both coordinate helpers. Note how `_promote_to_ready` and
`_backfill_coordinates` obtain a provider and call `connection()`. All three provider calls need the same
credentials.

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/test_lease_reaper.py`:

```python
@pytest.mark.asyncio
async def test_byok_lease_is_promoted_using_the_users_credentials(test_db, monkeypatch):
    """A BYOK lease runs on the user's own provider account. The reaper polls
    with no credentials, so it could never see the box as up, never promoted,
    and branch 2 destroyed the user's own paid instance at 600s."""
    db = test_db["db"]; uid = test_db["user_id"]
    await compute_repo.create_lease(db, lease_id="Lbyok", status="provisioning",
        user_id=uid, provider="runpod", requested_sku="h100", region="us",
        hourly_rate_cents=279, category="gpu", funding="byok",
        ssh_key_name="atlas-byok")
    old = _iso(datetime.now(timezone.utc) - timedelta(seconds=1200))
    await db.execute(
        "UPDATE compute_leases SET created_at = ?, started_at = ? WHERE lease_id = 'Lbyok'",
        (old, old))
    await db.commit()

    seen = {"status": None, "connection": None}

    class _P:
        async def status(self, _id, **kw):
            seen["status"] = kw.get("user_credentials")
            if not kw.get("user_credentials"):
                return {"status": "not_configured"}
            return {"status": "running"}

        async def connection(self, _id, **kw):
            seen["connection"] = kw.get("user_credentials")
            if not kw.get("user_credentials"):
                return {}
            return {"ssh_host": "1.2.3.4", "ssh_port": 20095, "ssh_user": "root"}

    monkeypatch.setattr(reaper, "get_provider", lambda _name: _P())

    async def _creds(_db, _lease):
        return {"secret": "user-byok-key"}
    monkeypatch.setattr(reaper, "_credentials_for_lease", _creds, raising=False)

    async def _noop_release(self, _db, _lease): return {"status": "released"}
    monkeypatch.setattr(reaper.LeaseManager, "release_lease", _noop_release)

    n = await reaper.sweep_once(db, now=datetime.now(timezone.utc))

    assert n == 0, "a live BYOK lease must not be reaped"
    row = await compute_repo.get_lease(db, "Lbyok")
    assert row["status"] == "ready"
    assert row["ssh_host"] == "1.2.3.4"
    assert seen["status"] == {"secret": "user-byok-key"}
    assert seen["connection"] == {"secret": "user-byok-key"}
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q -k byok`
Expected: FAIL — the lease is reaped (`n == 1`) or stays `provisioning`, and `seen["status"]` is `None`.
Paste the failure.

- [ ] **Step 4: Thread credentials through the three provider calls**

Import `_credentials_for_lease` into `lease_reaper.py` at module level, alongside the existing
`from app.compute.lease_manager import LeaseManager`:

```python
from app.compute.lease_manager import LeaseManager, _credentials_for_lease
```

In `sweep_once`, resolve credentials once per lease before branch 1 and pass them to `status()`:

```python
        creds = await _credentials_for_lease(db, lease)
        kw = {"user_credentials": creds} if creds is not None else {}
```

Pass `**kw` to `provider.status(lease_id, **kw)` in branch 1, and thread `creds` into
`_promote_to_ready` and `_backfill_coordinates` so their `connection()` calls use it too. Update those
two helpers' signatures to accept the credentials, and update every call site.

**Keep the failure handling as it is** — a raising `status()` must still leave `pstat = {}` and fall
through to the timeout branches. This change adds credentials; it must not change what happens when a
provider call fails.

Correct the now-stale comment on branch 1 that says BYOK leases cannot be classified here.

- [ ] **Step 5: Run the tests**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_lease_reaper.py -q`
Expected: all pass, including every pre-existing test. Then
`cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q` → 1611 passed / 1 skipped.

- [ ] **Step 6: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/jobs/lease_reaper.py backend/tests/test_lease_reaper.py
git commit -m "fix(reaper): poll BYOK leases with the user's own credentials

The sweep polled every provider with no credentials, so a BYOK lease could
never be seen as up: status() returned not_configured or raised, promotion
never ran, and branch 2 destroyed the user's own paid instance at the
provisioning timeout. release_lease already used BYOK credentials, so the
teardown worked even though the liveness check could not.

_credentials_for_lease already existed on LeaseManager; the reaper now uses it
for status() and for the connection() lookups behind promotion and backfill."
```

---

### Task 2: `VastProvider.release` reports success it never verified

**Why:** the release wraps its DELETE in `try/except: pass` and then returns
`{"lease_id": lease_id, "status": "terminated"}` **unconditionally**. A 4xx, a network error, or a
half-completed teardown all return the same "terminated". Observed live: the return value is not evidence
of anything.

This is the provider half of spec change 8. The `LeaseManager.release_lease` half — which marks the row
released regardless — stays out of scope here; this task makes the provider able to tell the truth.

**Files:**

- Modify: `backend/app/compute/vast_provider.py` — the `release` method
- Test: `backend/tests/test_compute_vast_provider_http.py` (append)

**Interfaces:**

- Produces: `VastProvider.release` returns `status: "terminated"` only on a 2xx; otherwise
  `status: "unknown"` with a `warning` key describing what happened. Callers that only read `status` are
  unaffected on the success path.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_compute_vast_provider_http.py`:

```python
@respx.mock
async def test_release_reports_failure_instead_of_claiming_terminated():
    respx.delete(f"{VAST_API}/instances/4242/").mock(
        return_value=httpx.Response(403, text="forbidden")
    )
    out = await VastProvider().release("4242", user_credentials=CREDS)
    assert out["status"] != "terminated", "a refused delete must not report success"
    assert "warning" in out
    assert "403" in str(out["warning"])


@respx.mock
async def test_release_reports_failure_on_transport_error():
    respx.delete(f"{VAST_API}/instances/4242/").mock(
        side_effect=httpx.ConnectError("boom")
    )
    out = await VastProvider().release("4242", user_credentials=CREDS)
    assert out["status"] != "terminated"
    assert "warning" in out


@respx.mock
async def test_release_reports_terminated_on_success():
    respx.delete(f"{VAST_API}/instances/4242/").mock(
        return_value=httpx.Response(200, json={"success": True})
    )
    out = await VastProvider().release("4242", user_credentials=CREDS)
    assert out["status"] == "terminated"
    assert "warning" not in out
```

- [ ] **Step 2: Run and confirm the first two fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_vast_provider_http.py -q -k release`
Expected: the first two FAIL (`status` is `"terminated"` regardless), the third passes. Paste the failure.

- [ ] **Step 3: Make the release honest**

Rewrite the body of `release` so it inspects the response and reports what actually happened. Keep it
**non-fatal** — it must not start raising, because callers rely on release being best-effort — and log at
warning level, matching the logging added to the key-attach path in the same module:

```python
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.delete(
                    f"{VAST_API}/instances/{lease_id}/", headers=headers
                )
            if resp.status_code >= 400:
                detail = (resp.text or "")[:200]
                logger.warning(
                    "vast.release: HTTP %s destroying instance %s: %s",
                    resp.status_code, lease_id, detail,
                )
                return {
                    "lease_id": lease_id,
                    "status": "unknown",
                    "warning": f"HTTP {resp.status_code}: {detail}",
                }
        except Exception as exc:  # noqa: BLE001
            logger.exception("vast.release: destroying instance %s failed", lease_id)
            return {"lease_id": lease_id, "status": "unknown", "warning": str(exc)[:200]}
        return {"lease_id": lease_id, "status": "terminated"}
```

Update the method's docstring to say the return value now distinguishes a confirmed teardown from an
unconfirmed one.

- [ ] **Step 4: Run the tests**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_vast_provider_http.py -q`
Expected: all pass. Then the full suite → 1614 passed / 1 skipped.

- [ ] **Step 5: Check for callers that assumed the old contract**

Grep for callers of `release(` on providers and confirm none of them break when `status` is `"unknown"`.
`LeaseManager.release_lease` already treats the provider result as advisory. **Report what you find** —
if any caller keys off `status == "terminated"` to decide something important, say so rather than
changing it.

- [ ] **Step 6: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/compute/vast_provider.py backend/tests/test_compute_vast_provider_http.py
git commit -m "fix(vast): release reports what happened instead of always 'terminated'

The DELETE was wrapped in try/except: pass and the method returned
status='terminated' unconditionally, so a 403, a transport error and a real
teardown were indistinguishable to the caller. Still best-effort and still
non-raising; it just tells the truth now."
```

---

### Task 3: Prime Intellect leaks an account SSH key per lease, and stores the wrong identifier

**Why:** `PrimeIntellectProvider.acquire` registers the public key with `_register_ssh_key`, which returns
the provider's key **id** — used as `sshKeyId` on the pod. But `acquire` then returns
`"ssh_key_name": name`, the **pod** name (`atlas-{user_id[:8]}`), which is identical for every lease that
user ever creates. The key id is discarded, `release` deletes nothing, and every lease leaves a key in the
operator account permanently.

Vast no longer leaks (the account registration was removed there), so Prime is the remaining case. This is
spec change 9(b), scoped to the one provider that still needs it.

There is **no column** to store a provider-side key id — `compute_leases` carries `ssh_key_name` and
`ssh_public_key` only. Follow the additive-column pattern already used for `runner_api_key_id` in
`backend/app/db/migrations.py` (see the `if "runner_api_key_id" not in existing:` guard) and mirror it in
`backend/app/db/pg_migrations.py`.

**Files:**

- Modify: `backend/app/db/migrations.py`, `backend/app/db/pg_migrations.py` (add `provider_key_id TEXT`)
- Modify: `backend/app/db/repos/compute_repo.py` (`create_lease` accepts and persists it)
- Modify: `backend/app/compute/lease_manager.py` (pass it from the acquire result into `create_lease`;
  forward it to `release`)
- Modify: `backend/app/compute/prime_intellect_provider.py` (return the key id; delete on release and on
  failed launch)
- Test: `backend/tests/test_compute_prime_provider_http.py` (append)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `compute_leases.provider_key_id`, a nullable TEXT column. `acquire` results may carry
  `provider_key_id`; `release` accepts `provider_key_id=` and deletes it when present.

- [ ] **Step 1: Read the existing shapes first**

Read `PrimeIntellectProvider._register_ssh_key`, `acquire` and `release`; `LambdaProvider._delete_ssh_key`
and how `release_lease` forwards `ssh_key_name` (`lease_manager.py`); and the `runner_api_key_id`
migration guard. **Report the Prime delete endpoint you find** — if the module does not already know how
to delete a key, find it in the provider's API surface before writing code.

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_compute_prime_provider_http.py`, matching that file's existing respx style
(read it first — reuse its base-URL constant and credentials fixture rather than inventing new ones):

1. `acquire` returns `provider_key_id` equal to the id `POST /ssh_keys/` returned, and **not** the pod
   name.
2. `release` called with that `provider_key_id` issues a delete for that key.
3. `release` with no `provider_key_id` does not attempt a key delete and still terminates the pod.
4. A launch that fails **after** key registration deletes the key it registered (no leak on the error
   path).

- [ ] **Step 3: Run and confirm they fail**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_prime_provider_http.py -q`
Paste the failures.

- [ ] **Step 4: Implement**

Work in this order so each piece is independently runnable:

1. Migration: `provider_key_id TEXT` on `compute_leases`, both sqlite and Postgres, additive and guarded
   exactly like `runner_api_key_id`.
2. `compute_repo.create_lease`: accept `provider_key_id: str | None = None`, persist it, include it in the
   returned dict.
3. `prime_intellect_provider.acquire`: return `"provider_key_id": ssh_key_id` alongside the existing keys.
   **Leave `ssh_key_name` as it is** — other code reads it, and this task is not a rename.
4. `prime_intellect_provider.acquire`: wrap the pod-creation call so a failure after key registration
   deletes the registered key before re-raising.
5. `prime_intellect_provider.release`: accept `provider_key_id: str | None = None` and delete that key
   when present, best-effort and logged, never raising.
6. `lease_manager`: pass the acquire result's `provider_key_id` into `create_lease`, and forward the
   stored `provider_key_id` into `provider.release(...)` the same way `ssh_key_name` is already forwarded.

- [ ] **Step 5: Run the tests**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q -k "prime or compute or lease"`
then the full suite. Both green.

- [ ] **Step 6: Commit**

```bash
cd ~/codes/InkVell/atlas
git add -A backend/app backend/tests
git commit -m "fix(prime): delete the per-lease SSH key instead of leaking it

acquire registered a key, used its id as sshKeyId, then returned the POD name
in ssh_key_name and discarded the id -- so release had nothing correct to
delete and every lease left a key in the operator account forever. The pod name
is also identical across all of a user's leases, so a name-keyed delete would
have missed or over-deleted.

Adds a nullable provider_key_id column, returns the real id from acquire,
deletes on release and on a launch that fails after registration."
```

---

### Task 4: Lambda's in-flight status reads as `unknown`

**Why:** `LambdaProvider.status` returns Lambda's raw upstream string unmapped
(`backend/app/compute/lambda_provider.py`), and `normalise_state`'s `_PROVISIONING` set contains only
`"provisioning"`. So a booting Lambda box reports `state: "unknown"` for its whole boot window. Safe —
`unknown` never reads as ready — but a client polling for progress cannot distinguish "coming up" from
"something is wrong".

`booting` is named as an in-flight status by this repo's own frontend
(`frontend/src/components/compute/InstancesTab.tsx:29`), which is the in-repo evidence that was missing
when this was first deferred.

**Files:**

- Modify: `backend/app/compute/lease_state.py`
- Test: `backend/tests/test_compute_lease_state.py`

**Interfaces:**

- Consumes: `normalise_state` from Task-4-of-the-previous-plan. Unchanged signature.

- [ ] **Step 1: Add the failing case**

In `backend/tests/test_compute_lease_state.py`, add `"booting"` to the parametrisation of
`test_in_flight_states_normalise_to_provisioning`, and **remove** it from any unknown-case list if present.

- [ ] **Step 2: Run and confirm it fails**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_lease_state.py -q`
Expected: FAIL — `normalise_state("booting")` returns `"unknown"`. Paste it.

- [ ] **Step 3: Map it**

Add `"booting"` to `_PROVISIONING` in `backend/app/compute/lease_state.py`, with a comment naming Lambda
as the emitter and the frontend file as the evidence.

**Do not add `unhealthy`.** Lambda's enum is not documented in this repo, and `unhealthy` is genuinely
ambiguous between "degraded but alive" and "dead" — mapping it wrong is worse than leaving it `unknown`.
Say so in the comment.

- [ ] **Step 4: Run the tests**

Run: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/test_compute_lease_state.py -q`
then the full suite. Both green.

- [ ] **Step 5: Commit**

```bash
cd ~/codes/InkVell/atlas
git add backend/app/compute/lease_state.py backend/tests/test_compute_lease_state.py
git commit -m "fix(compute): map Lambda's booting status to provisioning

Lambda passes its upstream status string through unmapped, so a booting box
reported state='unknown' for its whole boot window -- safe, since unknown never
reads as ready, but a client could not tell 'coming up' from 'broken'. The
repo's own frontend already treats booting as an in-flight status.

unhealthy is deliberately left unmapped: it is ambiguous between degraded and
dead, and guessing is worse than unknown."
```

---

## Whole-branch verification

- [ ] Full suite: `cd ~/codes/InkVell/atlas/backend && .venv/bin/python -m pytest tests/ -q` — green, no
      network.
- [ ] Confirm by name that the previous plan's deliverable tests still pass:
      `test_promoted_lease_is_not_reaped_at_the_provisioning_timeout`,
      `test_user_lease_without_runner_token_is_not_heartbeat_reaped`,
      `test_modal_cpu_sandbox_promotes_without_ssh_host`,
      `test_status_of_destroyed_instance_is_terminated_not_provisioning`.
- [ ] Report which defects remain open (see below) so nothing is assumed closed.

## Deliberately out of scope

Two items from the same defect list are **full spec changes, not defects**, and each needs its own plan:

- **Volumes provision nothing** (spec change 6). `create_volume` writes a DB row and calls no provider
  API; no provider except RunPod has any volume concept. This is "make volumes real, per provider", and
  under cheapest-first it also narrows the resolver pool. A design task, not a fix.
- **The options catalog is uncached** (spec change 12). Five provider requests per call behind a 3s client
  timeout. It needs a cache key, a TTL, and a decision about how the resolver's retry interacts with it —
  all design choices the spec has not made.

Also still open and recorded, not addressed here: the `LeaseManager.release_lease` half of change 8 (marks
a row released even when provider teardown failed), and `PROVISION_TIMEOUT_SECONDS` being a single global
constant.
