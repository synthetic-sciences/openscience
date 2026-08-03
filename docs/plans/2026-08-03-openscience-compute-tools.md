# OpenScience compute tools: give the agent the three verbs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can rent a GPU, use it, and give it back. Today `ComputeTools = [ComputeStatusTool]`
and the only `/api/compute` call in the product is a read-only probe — Atlas can do all of this and
OpenScience cannot ask.

**Architecture:** All work is in **OpenScience** (`~/codes/InkVell/git-worktrees/openscience-compute`,
branch `openscience-compute`, branched off `feat/compute-guardrails`). Three new tools beside the
existing `compute_status`, plus one client module they share. No Atlas changes — its side is done.

**Tech Stack:** Bun, TypeScript, zod, `Tool.define`. Tests with `bun test`.

**Spec:** `docs/specs/compute-design.md`, "OpenScience changes" → "Three verbs".

## Global Constraints

- **Repo:** `~/codes/InkVell/git-worktrees/openscience-compute`, branch `openscience-compute` (already
  checked out). Do not create or switch branches. **This is a git worktree — the same repo also has a
  checkout at `~/codes/InkVell/openscience` on a different branch. Do not touch that one.**
- **Run tests with:** `cd <worktree>/backend/cli && bun test <path>`. Typecheck with `bun run typecheck`
  from the repo root — the pre-push hook runs it and a type error blocks the push.
- **Never add a `Co-Authored-By:` trailer or any AI/assistant attribution to commit messages.**
- Follow `AGENTS.md`: prefer `const`, avoid `else`, single-word variable names, rely on type inference,
  **no `any`**, use Bun APIs (`Bun.file()`), **no mocks — test real implementations.**
- Every new assertion must be shown failing first. Paste the RED output into your report.
- Ignore `.claude/worktrees/`.

## What Atlas gives you — verified live, do not re-derive

`POST /api/compute/leases` with `{gpu, count, budget_cents, max_hourly_cents?}` returns **201** with,
among other fields:

```
lease_id, provider, requested_sku, status, funding,
gpu_model, gpu_name, gpu_count,
hourly_rate_cents, price_cents_per_hour_display,
effective_budget_cents, provisioning_timeout_seconds,
ssh_user, ssh_port, ssh_host (NULL at launch), ssh_private_key (returned ONCE)
```

1. **SSH coordinates do not exist at launch.** `status` is `provisioning` and `ssh_host` is null.
   Measured: `ready` with a real host arrives at **t+20–30s**, written by a server-side reaper. So the
   tool must poll.
2. **Poll `GET /api/compute/leases/{id}/connection`.** It returns a **normalised** `state` field —
   `provisioning | ready | terminated | unknown` — beside a raw provider-specific `status`. **Poll on
   `state`, never on `status`:** the raw vocabularies are disjoint across providers, `"running"` is
   unreachable on the DB path and `"ready"` on the provider path, and Lambda passes its upstream string
   through unmapped. `unknown` is not readiness.
3. **Bound the poll with `provisioning_timeout_seconds` from the launch response**, not a constant of
   your own. A client bound *shorter* than the server's abandons launches the server was still
   completing. Never hardcode a copy.
4. **`ssh_private_key` is returned exactly once**, in the 201. It is not retrievable later from the
   launch path. If you do not persist it, the box is unreachable.
5. **Errors that mean different things:**
   - `402` twice over — `error: "insufficient_cli_credit"` (wallet cannot fund an hour) and
     `error: "budget_below_hourly_rate"` (the caller's budget cannot). **Both carry
     `affordable_budget_cents`** — the largest budget the wallet would back right now.
   - `429` twice over, needing **opposite** responses. The rate limiter (20/min on writes) means *wait
     and retry*. The concurrency cap (`MANAGED_GPU_CONCURRENT = 2`) means *retrying never works —
     release something*. Discriminate on the body; the cap's detail reads
     `Managed GPU concurrency cap reached (n/m).`
   - `400 no_matching_offer` (nothing matched the requirement) vs `503 no_capacity` (candidates were
     tried and all refused), each with an `attempted` list.
   - `409` on releasing an already-released lease.
6. **Reads are cheap, writes are not.** `GET`s under `/api/compute/leases` are metered at 600/min;
   `POST`s at 20/min. Polling is affordable. Launching in a loop is not.

## Behaviour the spec fixes, and why

- **On `402`, surface `affordable_budget_cents` and stop. Never auto-retry at a smaller budget** — a
  truncated training run is not a cheaper result, it is a discarded one.
- **On `409` and either `429`, surface rather than retry.**
- **A non-2xx or malformed launch response writes no key file and reports no lease.**
- **On poll timeout with the lease still live, release it** — a paid box the agent cannot reach is worse
  than no box. But a lease the *server* has already reaped needs reporting, not releasing.
- **No client-side deadline timer, price table, or SKU ranking.** Atlas picks; the client does not
  second-guess it.
- **The agent does the work with plain `ssh`/`scp` from `bash`.** No relay, no exec wrapper, no
  file-transfer helper — that is a remote-execution platform and it was designed once and rejected.
- **Always send an explicit `budget_cents`.** Omitting it authorises the whole plan TTL at the hourly
  rate — 24 hours, roughly $168 at $6.99/h — from a call that named no budget.
- **Never tell a free-tier user to connect a key to run free.** BYOK is gated on
  `plan.monthly_cents > 0`; a free user with a key connected still runs managed and still pays.

---

### Task 1: The client the three tools share

**Files:**
- Create: `backend/cli/src/compute/lease.ts`
- Test: `backend/cli/test/compute/lease.test.ts` (new)

**Interfaces:**
- Consumes: `OpenScience.getSession()` and `API_BASE` — the pattern in `src/compute/mode.ts`.
- Produces: `Lease.launch`, `Lease.connection`, `Lease.list`, `Lease.release`, and a discriminated
  result type that names each failure the tools must handle differently.

This task is the error vocabulary, not the tools. Every behaviour above that says "surface, don't retry"
is a distinction that has to exist in a type before a tool can act on it. Model the outcomes so an
impossible response cannot be mistaken for a good one — a malformed 201 must not become a lease.

Pay particular attention to the two `429`s. They arrive with the same status and need opposite handling,
so the type must separate them; a single `RateLimited` case is a defect. Match defensively on the body:
provider and server prose can change, and an unrecognised `429` should be treated as the *safer* of the
two — the cap, which tells the agent to stop — rather than inviting a retry loop.

- [ ] **Step 1: Write the failing tests.** Use a real local HTTP server (Bun's `serve`) rather than
      mocking `fetch`; `AGENTS.md` forbids mocks and the point is to exercise the real request path.
      Cover: a good 201; a 201 missing `ssh_private_key`; both 402 shapes and their
      `affordable_budget_cents`; both 429 shapes; 400 vs 503; 409 on release; a network failure; a body
      that is not JSON.
- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, then `bun run typecheck`**
- [ ] **Step 5: Commit**

---

### Task 2: `compute_launch`

**Files:**
- Modify: `backend/cli/src/tool/compute.ts`
- Test: `backend/cli/test/tool/compute-launch.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's client.
- Produces: `ComputeLaunchTool`, exported but **not yet registered** (Task 3 wires the registry).

Parameters: `gpu` (canonical id), `count`, `budget_cents`, `max_hourly_cents?`.

Output: `lease_id`, `provider`, `gpu_model`, `gpu_name`, `gpu_count`, `ssh_host`, `ssh_port`, `ssh_user`,
`key_path`, `hourly_cents`, `effective_cap_cents` — and a ready-to-paste `ssh` command, because the
agent's next step is `bash`.

Three things carry the risk:

**The key file.** `ssh_private_key` arrives once. Write it before the poll, not after — a crash mid-poll
must not strand a running box whose key was never saved. `0600`, and the path goes in the output.
Decide where it lives and say why in a comment.

**The poll.** Bounded by the launch response's `provisioning_timeout_seconds`. Poll on `state == "ready"`
*and* a non-empty `ssh_host` — `ready` without coordinates is not usable, and the server can promote
before a host is backfilled. Choose an interval with a backoff and justify it: every poll is an uncached
provider HTTP call on Atlas's side, so a tight loop costs the operator real requests. `terminated` during
the poll is a launch that died — report it, do not release it again.

**Timeout.** If the bound elapses and the lease is still live, release it and say so. If the server
already reaped it, report that instead — releasing a reaped lease is the `409` above.

- [ ] **Step 1: Write the failing tests** — a launch that is ready on the second poll; one that never
      becomes ready (assert the release happens); one already terminated by the server (assert no
      release attempt); a 402 (assert no key file is written and the affordable budget is surfaced); a
      concurrency-cap 429 (assert it does not retry). Assert the key file's mode.
- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, then `bun run typecheck`**
- [ ] **Step 5: Commit**

---

### Task 3: `compute_list`, `compute_release`, and registration

**Files:**
- Modify: `backend/cli/src/tool/compute.ts`, `backend/cli/src/tool/registry.ts`
- Test: `backend/cli/test/tool/compute-list-release.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's client, Task 2's `ComputeLaunchTool`.
- Produces: `ComputeTools = [ComputeStatusTool, ComputeLaunchTool, ComputeListTool, ComputeReleaseTool]`.

`compute_list` takes nothing and returns the unfinished leases with their rate and cap, so an agent that
lost track can find its boxes. `compute_release` takes a `lease_id` and surfaces any provider teardown
warning rather than swallowing it — Atlas now reports an unconfirmed teardown honestly, and a tool that
hides that reintroduces the bug the server side just fixed.

Registration is the point at which these become reachable, so this is where the whole surface is checked:
four tools, distinct names, and `compute_launch` the only one that spends money.

- [ ] **Step 1: Write the failing tests** — list with no leases and with several; release of a live
      lease; release of an already-released lease (`409`, surfaced not thrown); a release whose teardown
      was unconfirmed (assert the warning reaches the agent).
- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the full CLI compute suite, then `bun run typecheck`**
- [ ] **Step 5: Commit**

---

## Whole-branch verification

- [ ] `bun test` green across the compute area; `bun run typecheck` clean.
- [ ] `compute_status` is unchanged — it shipped and is not part of this work.
- [ ] A live end-to-end run against real Atlas with real provider keys: launch → poll → SSH in → release.
      **Nothing may be left running**; verify against the provider afterwards.

## Acceptance criteria

1. An agent can launch by requirement, without naming a provider or SKU.
2. The private key reaches disk exactly once, at `0600`, before the poll begins.
3. The readiness poll is bounded by the server's own timeout and polls the normalised `state`.
4. A poll timeout on a live lease releases it; on a server-reaped lease it reports.
5. Both `402`s surface `affordable_budget_cents` and neither retries at a smaller budget.
6. The two `429`s are distinguished and neither is retried blindly.
7. A non-2xx or malformed launch writes no key file and reports no lease.
8. `compute_release` surfaces an unconfirmed teardown rather than reporting success.
9. All four tools are registered and `bun run typecheck` passes.

## Out of scope

- Volumes (`volume_id`) — Atlas change 6 has not shipped.
- The quote endpoint (change 4) and any client-side price display beyond what a launch returns.
- Any relay, exec wrapper, or file-transfer helper. The agent uses `ssh`/`scp` from `bash`.
- Atlas changes of any kind.
