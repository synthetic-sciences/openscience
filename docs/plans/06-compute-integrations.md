# 06 — Compute integrations audit + fixes

Workstream: verify each compute path and fix what's broken — BYOK GPU (confirm), cloud storage, SSH, managed compute via the Atlas CLI. Findings-first. Audited against the Atlas backend (cloned) and the installed `atlas` CLI (`0.13.1` = npm `@synsci/atlas`). Citations `file:line`.

> **Currency note — 2026-08-01.** This audit was written in late July and parts of it have been
> overtaken. Three things changed and each is marked inline below, not silently rewritten:
>
> 1. **Path C is no longer a dead end.** `aa9b3142` ("feat: add managed compute jobs", merged to
>    `main` on 2026-07-29 — _after_ this audit) shipped a real SSH/Slurm/PBS dispatcher.
> 2. **Path D's "Correction to the initial audit" is false** and is retracted in place. The pin is
>    not `^0.5.12` and the published CLI has no `compute:` commands at all.
> 3. **The managed backend behind Path D now works end to end** — lease → promote → SSH → release,
>    on Vast and RunPod — but only on an **unmerged draft** Atlas branch, and OpenScience still
>    cannot launch a lease.
>
> Everything not marked below is a July fact that has **not** been re-audited. Treat it as such.

## Status per path

| Path                                 | Verdict                        | One-line                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. BYOK GPU providers**            | ✅ works (with gaps)           | Key encrypt→env-injection is solid + unit-tested for the 4 providers with skills (Modal, Lambda, TensorPool, Prime). **Vast + RunPod keys inject but no skill reads them.**                                                                                                                                   |
| **B. Cloud storage**                 | ⚠️ creds-only, unverified      | No mount/rclone abstraction — AWS/GCP creds → env → whatever CLI a skill invokes. **Azure object storage is advertised but not backed.** Needs real creds+bucket to verify (FLAG).                                                                                                                            |
| **C. SSH-based compute**             | ~~❌ dead-end~~ → **fixed**    | ~~"SSH hosts" + "Model endpoints" panels persist data **nothing ever reads**. No SSH client, no dispatch, no routing.~~ **Overtaken by `aa9b3142`:** `src/compute/jobs.ts` dispatches over `ssh`, with Slurm/PBS/none schedulers and a reachability probe. **Model endpoints are still unread.**              |
| **D. Managed compute via atlas CLI** | ❌ command surface unpublished | The published `@synsci/atlas@0.13.2` contains **zero** `compute:` commands. The suite exists only in the atlas **repo**, unreleased. The pin is already `^0.13.2` (`backend/cli/package.json:123`) — there is no version to bump to. Atlas's `/api/compute/leases` itself works; nothing shipped can call it. |

Ground truth: `atlas doctor` on this machine is seeded (`~/.config/atlas-cli/config.json`), authed, backend reachable — so atlas **auth/config-seeding works**; only the **compute command surface** is broken.

## Path A — BYOK GPU providers (✅)

Compute panel (`Compute.tsx`, 6 cards) → `server/routes/settings/compute.ts`: keys AES-256-GCM at rest; `PROVIDER_ENV` maps to canonical var names (`:175-181`; Modal `ak-…:as-…` split into ID/SECRET); `applyComputeEnv()` injects at boot (`index.ts:111`) + after connect/disconnect (shell exports win, `:230`). Vars reach skill subprocesses via `subprocessEnv`. Consumers: Modal/Lambda/TensorPool/Prime skills. **Unit-tested** (`test/server/settings-compute.test.ts`).

- ✅ injection is correct + tested; Modal/Lambda/TensorPool/Prime have real skill consumers.
- ❌ **Vast/RunPod inject but no skill reads them** (`VAST_API_KEY`/`RUNPOD_API_KEY` set, no skill) — connecting does nothing.
- ⚠️ `last_used` is declared + rendered but **never written** → always "never".
- ⚠️ **Modal double-stored** — also in the Credentials panel, which injects the same vars and runs first at boot (`index.ts:107` before `:111`), so a Modal key set in both panels has the Credentials value silently win.
- ⚠️ ~~latent: the atlas-bin fallback resolver walks for `@openscience/atlas` while the dep is `@synsci/atlas` (`index.ts:225`) — dead fallback.~~ **Fixed** — `grep -r '@openscience/atlas' backend/cli/src` → 0 hits (2026-08-01).
- **FLAG:** an actual job round-trip (Modal/Lambda/TensorPool/Prime) needs live provider accounts — plumbing verified, round-trip not.

**Still true 2026-08-01:** `last_used` is still only defaulted and carried forward, never assigned
(`routes/settings/compute.ts:252`, `:272`). Vast/RunPod still have no catalogued skill.

**Note on Vast/RunPod:** both are now leasable **server-side**, as managed providers in Atlas, and
were driven end to end on 2026-08-01. That does not close this gap: the capability lives behind
`POST /api/compute/leases`, on an unmerged draft branch, and OpenScience has no tool that calls it.
A user's `VAST_API_KEY`/`RUNPOD_API_KEY` in this panel is still consumed by nothing.

**Fixes:** author Vast/RunPod skills or drop them from the catalog (interim: "key stored — skill coming"); populate or remove `last_used`; pick one home for Modal (recommend removing from Compute, Credentials owns it) or share one precedence; ~~fix the `@openscience→@synsci` scope typo~~ (done).

## Path B — Cloud storage (⚠️)

`Storage.tsx` is local-disk only; its "Cloud storage" section just links to Credentials ("S3, GCS, Azure configured through service credentials"). Actual mechanism: `credentials.ts` injects AWS (`AWS_ACCESS_KEY_ID/…`) and GCP (service-account JSON → 0600 file + `GOOGLE_APPLICATION_CREDENTIALS`); skills call `aws s3`/`gcloud`/`boto3`/`rclone` (env-auth).

- ✅ **S3 + GCS viable** _if the CLI tool is installed_ — creds → env → tools honor them.
- ❌ **Azure object storage advertised but not backed** — the only Azure cred is **Azure OpenAI** (an LLM key), not Blob Storage. No `AZURE_STORAGE_*` field, so the panel's "Azure" promise can't be fulfilled.
- ⚠️ no managed abstraction (no mount, no rclone.conf seeding) — success depends on the tool being installed + the skill spelling the remote right.
- **FLAG:** end-to-end read/write needs live AWS/GCP creds + a real bucket + CLIs present — untested here.

**Fixes:** add an Azure Storage cred or drop "Azure" from the copy; document the "creds-only, needs CLIs, no mount" contract; optionally seed an `rclone` remote from stored creds.

## Path C — SSH-based compute (~~❌~~ → **half fixed**, 2026-08-01)

Compute.tsx promises "SSH hosts" (dispatch runs over SSH) + "Model endpoints" (route inference). `compute.ts` persists `ssh_hosts` + `endpoints`.

**The July verdict below was overtaken by `aa9b3142` ("feat: add managed compute jobs", merged to
`main` 2026-07-29 — two days after this audit's baseline `52845c3`). Option (b) was chosen and
built for the SSH half.** What exists now:

- ✅ **`ssh_hosts` is read and dispatched to.** `src/compute/jobs.ts` (`ComputeJobs`) spawns the
  system `ssh` binary (`:362-366`, `BatchMode=yes`, honours a per-host port), supports `local` and
  `ssh` targets, `none`/`slurm`/`pbs` schedulers (`sbatch --wait --parsable` at `:331`, `scancel`
  at `:710`), optional `apptainer exec` (`:275`), a resource request (cpus/gpus/memory/time/
  partition), artifact collection, and job metadata persisted as JSON at mode `0600` (`:162`).
- ✅ **Reachability is probed, not assumed.** `POST /ssh/:id/test` returns latency plus
  Python / NVIDIA GPU / Slurm / PBS capability flags (`routes/settings/compute.ts:394`).
- ✅ **It is user-reachable** — `frontend/workspace/src/atlas/ComputeJobs.tsx`, mounted in
  `RightPane.tsx:297`, which the session page renders. Routes: `/jobs`, `/jobs/completed`,
  `/jobs/:id/log`, `/jobs/:id/cancel`.
- ❌ **Model endpoints are still a store-only dead end.** `endpoints` still has no
  inference-routing consumer; the panel still promises routing that nothing performs.
- ❌ **No agent tool.** `grep ComputeJobs backend/cli/src/tool/` → **0 hits**. The job system is
  driven from the UI; the agent cannot start or cancel a job.
- ⚠️ **No SSH client _dependency_ was added** — it shells out to the host's `ssh`. So audits
  phrased as "no SSH client in the dep tree" remain literally true and are no longer evidence of
  anything. Key handling is still the user's `~/.ssh`; the store still has no key field, which is
  why the security sign-off below never had to happen.
- ⚠️ nuance: cloud-compute skills SSH into boxes **they provision** (lambda/tensorpool/skypilot) — real SSH, unrelated to the panel.

~~**Fixes (pick one):** (a) **remove** the SSH-hosts + model-endpoints sections + routes (recommended near-term — stop advertising vaporware); (b) **wire it** — a remote-exec tool reading `ssh_hosts` (needs an SSH client dep + key handling) + treat `endpoints` as selectable OpenAI-compatible targets, injected into compute-agent context. **Decision required + security sign-off** on private-key storage (the store has no key field today).~~

**Remaining fixes:** (a) **model endpoints** — still the original decision: remove the section or
wire it as selectable OpenAI-compatible targets. (b) Expose `ComputeJobs` to the agent, or state
that it is deliberately UI-only.

## Path D — Managed compute via the Atlas CLI (❌)

Config seeding works (`ensureAtlasCliConfig`, verified by `atlas doctor`). Intended UX: "Compute spend = Managed" (`Spend.tsx`) → `billing.compute` → a `<system-reminder>` injected by `insertReminders` (`prompt.ts:1321-1333`) telling the agent to run `atlas compute:up`. Atlas has the machinery: `POST /api/compute/leases` provisions Modal sandboxes + reseller GPU VMs, billed to the wallet (`compute.py:305-421`, `compute_billing_service.py`).

### ~~Correction to the initial audit~~ — the correction was itself wrong (retracted 2026-08-01)

**Kept in place rather than deleted, because the mistake is the useful part of this section.** It
was a source-read conclusion about a _published artifact_, checked against neither the artifact nor
the manifest it claimed to be quoting.

~~**Correction to the initial audit** (which tested the _installed 0.13.1_): the atlas CLI at the **published latest (0.13.2)** ships a real compute suite — `cli/src/atlas-runtime/commands.mjs:915-923` registers `compute:up` (aliases `launch`/`lease` → `POST /compute/leases`, _"zero flags = cheapest GPU; managed bills the wallet per hour; BYOK free"_), `compute:catalog`/`gpus`/`options` (browse GPUs → `/compute/options`), `compute:list`/`leases` (`GET /compute/leases`), `compute:ssh` (`/connection`), `compute:release`/`down` (`/release`). So `atlas compute:up` **is a real command in 0.13.2**, hitting the exact `/api/compute/leases` API — the prompt is _aspirationally correct_, not naming a phantom.~~

**Both of its load-bearing claims are false. Verified 2026-08-01:**

- **The pin is not `^0.5.12`.** `backend/cli/package.json:123` reads `"@synsci/atlas": "^0.13.2"`.
  There is no version gap, and nothing to bump.
- **The published artifact carries no `compute:` commands at all.** `npm pack @synsci/atlas@latest`
  resolves to **0.13.2**, and **zero** files in that tarball contain `compute:up` or
  `compute:lease`. Not an older surface — no surface.

The commands _are_ real, but only in the atlas **repo**: `3e1d1ca` removed them, `0.13.1` **and**
`0.13.2` both shipped without them, and `205bbc0` re-added them **with no version bump**. So the
source tree and the published artifact disagree at an identical version number — which is precisely
why reading the repo told the first correction the opposite of what a user installs.

**This is a release problem, not a code or pinning problem.** Until a version ships with the
commands in it, no prompt, doc or runbook may name `atlas compute:*`.

- ✅ **The prompt no longer names it.** `12a43695` replaced the `atlas compute:up` guidance with a
  `compute_status` pointer; `grep -r 'compute:up' backend/cli/src` → **0 hits**. The defect this
  section was written to describe is closed on the client side.
- ⚠️ **The surface has churned** — the CLI CHANGELOG shows a `compute:*` set removed then a richer one re-added; and it also describes provisioning as a **web-dashboard "Lambda Labs reseller" Compute tab**. Confirm the intended UX (CLI leasing vs web dashboard, Modal as agent-runtime-internal) is settled before wiring the prompt hard to it.
- ⚠️ `exec:start` is a **separate** graph-ledger command (INSERTs a bookkeeping row, no Modal/lease call, `execution_service.py:45-87`) — not the compute path; don't conflate the two.
- ⚠️ ~~server-side managed GPU is **off by default**~~ — the **default** is still `"false"`
  (`config.py:383-384`), but **production has it on**: `resell_enabled: true` with lambda / runpod /
  vast / prime_intellect operator-funded and 292 launchable options, verified against
  `thesis-synsc` on 2026-07-31. Reading the default and concluding "managed is off" was one of the
  four source-read errors this workstream has now made about deployed behaviour.
- ⚠️ `billing.compute` is **prompt-only** — unlike `billing.llm` (mirrors to server + resyncs), it just persists + injects the reminder.
- ⚠️ substrate named 3 ways — "Daytona-backed" (`research.txt:229`) vs "Modal sandbox" (`atlas agent:run --help`) vs "Atlas-provisioned" (`config.ts:984`).
- ~~**FLAG:** an actual lease still needs `COMPUTE_RESELL_ENABLED=true` + operator keys + a funded wallet + a Modal account to verify end-to-end.~~ **Discharged 2026-08-01.** Exercised end to end
  against a deployed backend on **both** Vast and RunPod: `POST /leases` → the real background
  reaper promoted to `ready` with NATed SSH coordinates within one sweep → SSH into a real GPU →
  `POST /release` → instance verified gone at the provider. Not Modal — Modal is the CPU sandbox
  path, and conflating it with GPU leases is the same error as the `exec:start` bullet above.

**Fixes:** (1) ~~bump the pin~~ — **publish an atlas release containing the `compute:` commands**;
the pin is already `^0.13.2` and the code is already in the repo, so this is a release action with
no code change. Until then, keep prompts free of `atlas compute:*` (already true — `12a43695`).
(2) ~~enable resale~~ — **done in production**; what remains is wiring `billing.compute` to reality
(mirror `billing.llm`). (3) reconcile the CLI-leasing vs web-dashboard-reseller UX (owner decision).
(4) reconcile substrate naming. (5) decide the BYOK source of truth.

> **What is actually missing is a client, not a CLI.** OpenScience cannot launch a managed lease by
> any route: `ComputeTools` is `[ComputeStatusTool]` (`src/tool/compute.ts:138`), and the only
> `/api/compute` call in the product is `mode.ts`'s read-only `/options` probe. `compute_launch`,
> `compute_list` and `compute_release` are designed in `docs/specs/compute-design.md` and **unbuilt**.

## Cross-cutting — overlapping BYOK stores

A user's Modal key can live in **three** places with no reconciliation: the local **Compute** panel (`compute.ts`), the local **Credentials** panel (`credentials.ts`), and Atlas's **server-side** `compute_keys_service` (injected into managed sandboxes, plan-gated). Different execution contexts (local skill subprocess vs Atlas-provisioned sandbox); needs a source-of-truth decision (cross-repo).

## Consolidated backlog (by effort)

| #   | Fix                                                                                                                                                                                                                                                            | Path | Effort                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------- |
| 1   | ~~Bump the `@synsci/atlas` pin~~ — **wrong fix, the pin is already `^0.13.2`.** **Publish** an atlas release that contains the `compute:` commands; the code is in the repo, unreleased. Prompt guard no longer needed (`12a43695` removed `atlas compute:up`) | D    | S (release, no code)  |
| 2   | Azure: add Storage cred or drop "Azure" copy                                                                                                                                                                                                                   | B    | XS                    |
| 3   | Vast/RunPod: "no skill yet" or remove from catalog                                                                                                                                                                                                             | A    | XS                    |
| 4   | `last_used`: populate or remove — **still open**                                                                                                                                                                                                               | A    | XS                    |
| 5   | ~~Fix atlas-bin fallback scope `@openscience→@synsci`~~ — **done**                                                                                                                                                                                             | A    | XS                    |
| 6   | Modal de-dup across Compute vs Credentials                                                                                                                                                                                                                     | A    | S                     |
| 7   | ~~Remove or wire SSH-hosts~~ — **wired** (`aa9b3142`). Remaining: **model endpoints** (remove or wire), and whether `ComputeJobs` gets an agent tool                                                                                                           | C    | S (remove) / M (tool) |
| 8   | Document cloud-storage contract + optional rclone seeding                                                                                                                                                                                                      | B    | S                     |
| 9   | ~~Enable resale~~ (on in production) + wire `billing.compute` to reality (mirror `billing.llm`)                                                                                                                                                                | D    | M                     |
| 10  | Reconcile 3-way BYOK store ~~+ atlas version pin~~ (the pin is correct)                                                                                                                                                                                        | A/D  | M                     |
| 11  | **Added 2026-08-01** — build `compute_launch`/`compute_list`/`compute_release`. Atlas can lease; nothing in OpenScience can ask it to. Designed in `docs/specs/compute-design.md`                                                                              | D    | L                     |

## Risks / decisions needed from the owner

- **Is managed compute in scope this sprint?** ~~Backend is built but the CLI surface + default-off flag mean it's not shippable today~~ — **restated 2026-08-01:** the backend is built _and demonstrated end to end_, and resale is on in production. What blocks it is (a) an unpublished CLI and (b) **no client**: OpenScience has no launch tool. If it stays out of scope, stop advertising it (`Compute.tsx`, the Spend panel).
- **SSH hosts / endpoints:** ~~in scope (wire, +SSH dep + key security) or remove?~~ **SSH hosts: answered — wired in `aa9b3142`.** Model endpoints: still remove-or-wire.
- **Infra to verify:** BYOK round-trips need provider accounts; cloud storage needs real creds+bucket+CLIs. ~~managed leases need operator keys + `COMPUTE_RESELL_ENABLED=true` + funded wallet + Modal~~ — **done 2026-08-01, Vast and RunPod, on a deployed backend.** **Do not mark any path "works" without exercising it.**
- **BYOK source-of-truth** is a cross-repo decision.

## Acceptance criteria

- No prompt instructs a command absent from the bundled CLI (grep prompts for every `atlas …` verb; assert each resolves in `atlas --help`). **Met for compute** — 0 hits for `compute:up` in `backend/cli/src`.
- Connecting Vast/RunPod either drives a real run or the UI no longer implies it will.
- Storage lists only credential-backed backends (Azure fixed or removed); a documented smoke test (with creds) round-trips an object on S3 + GCS.
- ~~SSH/endpoint panels are gone, or adding a host + "run nvidia-smi on <host>" executes over SSH.~~ **Met for SSH** (`aa9b3142`); **not met for model endpoints.**
- With managed enabled + infra: `Compute spend = Managed` starts a real lease, wallet debits per the 60 s tick, auto-releases — demonstrated once. **Demonstrated at the API, not from OpenScience** — `POST /api/compute/leases` → billing tick decrementing the wallet in lockstep → release, on a deployed backend. The `Compute spend = Managed` _path_ still has no launch mechanism to trigger.
- One substrate name + one canonical atlas version documented; `billing.compute` changes behavior or is labeled advisory; `settings-compute` tests stay green.

**Key files:** `components/settings/{Compute,Storage,Spend}.tsx`, `server/routes/settings/{compute,storage,credentials,billing}.ts`, `openscience/index.ts`, `session/{prompt,billing-gate}.ts`, `agent/prompt/research.txt`, `config/config.ts`. Atlas: `routes/compute.py`, `services/{execution,compute_billing,compute_keys}_service.py`, `compute/{lease_manager,modal_provider}.py`, `config.py`.
