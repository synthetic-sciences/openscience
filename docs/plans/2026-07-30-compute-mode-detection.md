# Compute Mode Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `billing.compute` config default with runtime detection that resolves compute funding to `byok`, `managed`, or `none`, exposes it to the agent through a `compute_status` tool, and filters the skill catalog to the providers the user can actually use.

**Architecture:** One shared resolver (`src/compute/mode.ts`) reads `process.env` for provider credentials and `Skill.all()` for the matching skills; a provider counts only when it has both. Resolution happens on demand at two per-request seams — `SkillTool.init` (which rebuilds the catalog every turn) and the new `compute_status` tool — never at startup, so it cannot observe a half-initialised environment. Managed availability is one authenticated `GET /api/compute/options` call, made only when no usable provider exists, with a hard 3s timeout and a 5s in-process cache.

**Tech Stack:** Bun, TypeScript, Zod, Hono. Tests are `bun test` with `globalThis.fetch` stubbed at the network boundary — no mocks, no network.

**Spec:** `docs/specs/compute-mode-detection-design.md` (14 acceptance criteria). Read it before Task 1.

## Global Constraints

- **Style (`AGENTS.md`):** prefer `const` over `let`, avoid `else`, single-word variable names, rely on type inference over explicit annotations, **no `any`**, use Bun APIs (`Bun.file()`, `Bun.write()`).
- **No mocks in tests.** Stub `globalThis.fetch` at the network boundary and exercise the real implementation. Restore the real `fetch` in `afterEach`.
- **No network in `bun test`.** `test/preload.ts` already points `OPENSCIENCE_API_BASE` at `http://127.0.0.1:9` (unroutable) and sets `OPENSCIENCE_DISABLE_BUNDLED_SKILLS=true`, so `Skill.all()` in tests sees only skills the test itself writes into the tmpdir project.
- **Never** add `Co-Authored-By:` or any AI attribution to commit messages or PR bodies. Organisation rule.
- Run `bunx prettier --write <changed files>` before every commit. CI has a Format job over the whole repo.
- All commands run from `backend/cli`: `bun test`, `bun run typecheck`.
- **Every new assertion must be demonstrated failing against the specific mutation it guards — the _deletion_ of the logic under test, not merely its inversion.** Each test step below names its mutation. On the preceding `science_fetch` branch seven assertion defects were found and all seven were in plan-authored test code; the ones that held up were proven against deletion.
- Do **not** touch `backend/cli/test/provider/synthetic-model.test.ts`, `compaction-divider.png`, `docs/specs/issue-194-katex-latex-leak.md`, or `open-bench/` — untracked user WIP.
- Do **not** implement `docs/specs/compute-guardrails-design.md`. It is parked.

## Corrections to the spec, already verified

The spec was written against skill names that do not exist. These are the real names, confirmed against the live 293-skill catalog index (`~/.cache/openscience/skills-index.json`) and the authored sources in `backend/cli/skills/`:

| Provider        | Spec said                                                | Actual skill name(s)                                              | Source dir                                                 |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Modal           | `cloud-compute/modal`, `cloud-compute/modal-ml-training` | `modal-serverless-gpu`, `modal-ml-training`, `modal-research-gpu` | `skills/cloud-compute/modal{,-ml-training,-research-gpu}/` |
| Lambda          | `cloud-compute/lambda-labs`                              | `lambda-labs-gpu-cloud`                                           | `skills/cloud-compute/lambda-labs/`                        |
| TensorPool      | `cloud-compute/tensorpool`                               | `tensorpool-gpu-cloud`                                            | `skills/cloud-compute/tensorpool/`                         |
| Prime Intellect | `ml-training/prime-intellect-lab`                        | `prime-intellect-lab`                                             | `skills/ml-training/prime-intellect-lab/`                  |
| RunPod          | none                                                     | none — and none will be written, see Decision 2                   | —                                                          |
| Vast.ai         | none                                                     | none — and none will be written, see Decision 2                   | —                                                          |

Skill `name` comes from SKILL.md frontmatter, **not** the directory name, and there is no `category/` prefix in the name. A resolver hardcoding the spec's strings would filter nothing.

Other verified facts the spec did not have:

- `GET /api/compute/options` already returns `cli_effective_balance_cents`, so `balance_usd` needs **no second call**. Response envelope (`atlas` `origin/main:backend/app/routes/compute.py:213-232`): `{options[], providers[], resell_enabled, byok_eligible, platform_fee_ratio, cli_balance_cents, cli_effective_balance_cents}`, where each `providers[]` entry is `{provider, has_byok, has_operator, funding, count}` and `funding` is one of `byok | managed | unavailable`.
- `computeBillingMode()` in `src/session/billing-gate.ts:34` has exactly **one** consumer, `src/session/prompt.ts:1554`. Task 5 deletes both.
- `backend/cli/skills/` is loaded as a **dev-only** fallback (`Installation.VERSION === "local"`, `src/skill/skill.ts:219`). In a shipped binary skills come from the server catalog index. Authoring in this repo is correct and is what Tasks 6–7 do, but the resolver must never assume a skill is present — it checks `Skill.all()` at resolve time, so a binary whose catalog lacks `runpod-gpu-cloud` correctly reports RunPod as not usable.

## Decisions taken (answering the spec's open questions)

1. **Q1 — per-provider resolution:** no. `byok` when _any_ provider is usable; provider choice is left to the agent and the skills.
2. **Q2 — RunPod and Vast — REVISED mid-execution.** The original answer was "write the two skills". The user then ruled: _"the skill is definitely overkill, a capable agent can figure out how to use the cloud provider out of the box."_

   That reverses more than Tasks 6–7. The spec's **"key AND skill"** rule rested entirely on the claim that a provider with a credential but no skill "gives the agent nothing to act on". If a capable agent can drive a public cloud API from a bare key, that claim is false and the conjunction is wrong — it would report `none` to a user holding a perfectly workable RunPod key. So:
   - **A provider is BYOK-usable when it has a credential. Full stop.** The skill conjunction is deleted.
   - `runpod` and `vast` carry `skills: []`. No RunPod or Vast skill is written; **Tasks 6 and 7 are deleted.**
   - The `unusable` list disappears from `Resolution` and from `compute_status` — it existed only to explain the key-without-skill dead end, which no longer exists.
   - **Catalog filtering is unaffected**: it still lists a provider's skills only when that provider is credentialed. A skill is a quality boost where one exists, not a licence to use the provider.
   - Side benefit: this deletes the catalog-drift failure mode. Skills reach a shipped binary from the server catalog, so under the old rule a catalog that dropped or renamed `lambda-labs-gpu-cloud` would have silently marked Lambda unusable for a user whose key was fine.

   Tasks 6 and 7 in this plan are **superseded — do not implement them.**

3. **Q3 — is `none` a hard block:** no, guidance only. `compute_status` tells the agent not to attempt GPU work; nothing gates `bash` or blocks a direct `skill(name=…)` load. Enforcement is a larger change and is out of scope. Task 4 makes this explicit in a code comment rather than leaving it to be discovered.
4. **Q4 — prompt pointer:** **keep one line.** Task 5 deletes the false `atlas compute:up` / `atlas doctor` text and replaces it with a single unconditional, stateless reminder for `COMPUTE_AGENTS`. It carries no mode, so it can never go stale.
5. **Q5 — config description:** yes, updated in Task 5.
6. **Q6 — how long may `compute_status` block:** **3000 ms**, hard. `OpenScience.atlasFetch`'s 60s default is far too long to sit in front of an agent turn. Cache TTL is **5000 ms**.
7. **Filter scope:** only the six mapped providers' skills are subject to mode filtering. `fireworks-ai-inference`, `together-ai-inference`, `tinker-fine-tuning`, `tinker-training-cost` and `skypilot-multi-cloud-orchestration` share the `cloud-compute` category but are inference APIs and orchestrators keyed by their own credentials, not GPU leases this mode governs. They are never hidden.

## File Structure

**Created:**

| Path                                                 | Responsibility                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/cli/src/compute/mode.ts`                    | The single shared resolver. Provider→env→skill table, `usable()`, `resolve()`, `invalidate()`. The only place that decides what "usable" means. |
| `backend/cli/src/tool/compute.ts`                    | The `compute_status` tool. Formats a `ComputeMode.Resolution` for the agent; contains no resolution logic of its own.                           |
| `backend/cli/skills/cloud-compute/runpod/SKILL.md`   | RunPod GPU cloud skill (`runpod-gpu-cloud`).                                                                                                    |
| `backend/cli/skills/cloud-compute/vast-ai/SKILL.md`  | Vast.ai GPU marketplace skill (`vast-ai-gpu-cloud`).                                                                                            |
| `backend/cli/test/compute/mode.test.ts`              | Resolver tests (Tasks 1–2).                                                                                                                     |
| `backend/cli/test/tool/compute-status.test.ts`       | Tool tests (Task 3).                                                                                                                            |
| `backend/cli/test/tool/skill-compute-filter.test.ts` | Catalog filtering tests (Task 4).                                                                                                               |
| `backend/cli/test/session/compute-prompt.test.ts`    | Prompt-text regression tests (Task 5).                                                                                                          |

**Modified:**

| Path                                            | Change                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `backend/cli/src/tool/registry.ts`              | Import and register `ComputeTools`.                                    |
| `backend/cli/src/tool/skill.ts`                 | Filter the catalog by resolved mode inside `init`.                     |
| `backend/cli/src/session/prompt.ts:1550-1564`   | Replace the mode-carrying injection with a stateless one-line pointer. |
| `backend/cli/src/session/billing-gate.ts:33-36` | Delete the now-dead `computeBillingMode()`.                            |
| `backend/cli/src/config/config.ts:1058-1064`    | Correct the `billing.compute` description.                             |

---

### Task 1: The resolver's usable-provider rule

> **Implemented at `dc125b9` under the original "key AND skill" rule, then superseded by Decision 2. Task 1b below revises it to credential-only. Kept here as the historical record — do not re-implement.**

Pure logic, no network. Establishes the one definition of "usable" that Tasks 2–4 all consume.

**Files:**

- Create: `backend/cli/src/compute/mode.ts`
- Test: `backend/cli/test/compute/mode.test.ts`

**Interfaces:**

- Consumes: `Skill.all()` from `@/skill` (returns `Skill.Info[]`, each with a `name`).
- Produces, for Tasks 2, 3 and 4:
  - `type ComputeMode.Source = "byok" | "managed" | "none"`
  - `ComputeMode.PROVIDERS: Record<string, { env: string[][]; skills: string[] }>`
  - `ComputeMode.SKILLS: Set<string>` — every provider skill name, the exact set Task 4 filters over.
  - `ComputeMode.usable(): Promise<{ providers: string[]; unusable: string[] }>` — `providers` are ids with a key _and_ at least one catalogued skill; `unusable` are ids with a key but no catalogued skill. Both sorted, in `PROVIDERS` declaration order.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/compute/mode.test.ts`:

```ts
import { test, expect, afterEach, describe } from "bun:test"
import path from "path"
import { ComputeMode } from "../../src/compute/mode"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ENV = [
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "LAMBDA_API_KEY",
  "LAMBDA_LABS_API_KEY",
  "TENSORPOOL_KEY",
  "TENSORPOOL_API_KEY",
  "PRIME_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "RUNPOD_API_KEY",
  "VAST_API_KEY",
]

function clearEnv() {
  for (const name of ENV) delete process.env[name]
}

afterEach(clearEnv)

/** A tmpdir project seeded with real SKILL.md files, so Skill.all() finds them
 *  without a network catalog. `OPENSCIENCE_DISABLE_BUNDLED_SKILLS` in preload.ts
 *  keeps the dev skills/ dir and the server index out, so the test controls the
 *  catalog exactly. */
async function withSkills<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const name of names) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Test fixture for ${name}.\ncategory: cloud-compute\n---\n\n# ${name}\n`,
        )
      }
    },
  })
  return Instance.provide({ directory: tmp.path, fn })
}

describe("ComputeMode.usable", () => {
  test("a provider with a key and a skill is usable", async () => {
    clearEnv()
    process.env["LAMBDA_API_KEY"] = "secret_abc"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.usable())
    expect(result.providers).toEqual(["lambda"])
    expect(result.unusable).toEqual([])
  })

  test("the alternate env spelling also counts", async () => {
    clearEnv()
    process.env["LAMBDA_LABS_API_KEY"] = "secret_abc"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.usable())
    expect(result.providers).toEqual(["lambda"])
  })

  test("a key with NO catalogued skill is not usable", async () => {
    clearEnv()
    process.env["RUNPOD_API_KEY"] = "rpa_abc"
    const result = await withSkills([], () => ComputeMode.usable())
    expect(result.providers).toEqual([])
    expect(result.unusable).toEqual(["runpod"])
  })

  test("a catalogued skill with NO key is not usable", async () => {
    clearEnv()
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.usable())
    expect(result.providers).toEqual([])
    expect(result.unusable).toEqual([])
  })

  test("modal needs BOTH token vars — id alone is not a key", async () => {
    clearEnv()
    process.env["MODAL_TOKEN_ID"] = "ak-abc"
    const result = await withSkills(["modal-serverless-gpu"], () => ComputeMode.usable())
    expect(result.providers).toEqual([])
    expect(result.unusable).toEqual([])
  })

  test("modal with both token vars is usable", async () => {
    clearEnv()
    process.env["MODAL_TOKEN_ID"] = "ak-abc"
    process.env["MODAL_TOKEN_SECRET"] = "as-def"
    const result = await withSkills(["modal-serverless-gpu"], () => ComputeMode.usable())
    expect(result.providers).toEqual(["modal"])
  })

  test("an empty-string key does not count as set", async () => {
    clearEnv()
    process.env["TENSORPOOL_KEY"] = ""
    const result = await withSkills(["tensorpool-gpu-cloud"], () => ComputeMode.usable())
    expect(result.providers).toEqual([])
    expect(result.unusable).toEqual([])
  })

  test("every provider resolves in isolation, given its own skill", async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ["modal", { MODAL_TOKEN_ID: "ak-a", MODAL_TOKEN_SECRET: "as-b" }, "modal-serverless-gpu"],
      ["lambda", { LAMBDA_API_KEY: "k" }, "lambda-labs-gpu-cloud"],
      ["tensorpool", { TENSORPOOL_KEY: "k" }, "tensorpool-gpu-cloud"],
      ["prime", { PRIME_API_KEY: "k" }, "prime-intellect-lab"],
      ["runpod", { RUNPOD_API_KEY: "k" }, "runpod-gpu-cloud"],
      ["vast", { VAST_API_KEY: "k" }, "vast-ai-gpu-cloud"],
    ]
    for (const [id, env, skill] of cases) {
      clearEnv()
      Object.assign(process.env, env)
      const result = await withSkills([skill], () => ComputeMode.usable())
      expect(result.providers).toEqual([id])
    }
  })

  test("SKILLS covers every name in PROVIDERS and nothing else", async () => {
    const declared = Object.values(ComputeMode.PROVIDERS).flatMap((p) => p.skills)
    expect([...ComputeMode.SKILLS].sort()).toEqual([...new Set(declared)].sort())
    expect(ComputeMode.SKILLS.size).toBeGreaterThan(0)
  })

  test("a key injected after the first call is seen on the next call", async () => {
    clearEnv()
    await withSkills(["lambda-labs-gpu-cloud"], async () => {
      expect((await ComputeMode.usable()).providers).toEqual([])
      process.env["LAMBDA_API_KEY"] = "secret_late"
      expect((await ComputeMode.usable()).providers).toEqual(["lambda"])
    })
  })
})
```

Mutations these guard: deleting the skill-presence check (test 3 flips to `["runpod"]`); deleting the env check (test 4 flips to `["lambda"]`); deleting the both-vars-required branch for Modal (test 5 flips to `["modal"]`); deleting the non-empty check (test 7 flips to `["tensorpool"]`); deleting any row from `PROVIDERS` (test 8 fails for that row); caching the env read (test 10's second assertion flips back to `[]`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/cli && bun test test/compute/mode.test.ts`
Expected: FAIL — `Cannot find module '../../src/compute/mode'`.

- [ ] **Step 3: Write the resolver's usable-provider rule**

Create `backend/cli/src/compute/mode.ts`:

```ts
import { Skill } from "@/skill"

/**
 * Runtime resolution of how GPU compute is funded.
 *
 * `billing.compute` used to answer this from config alone, which meant a
 * brand-new user with zero provider keys resolved to "byok" — claiming BYOK
 * with nothing to BYOK with. This module answers it from the environment
 * instead, and can say "none", which is the state we previously handled worst.
 *
 * Resolution deliberately happens ON DEMAND and never at startup. Provider keys
 * reach process.env from three places — the user's shell, the Credentials panel
 * (`applyCredentialEnv`, src/index.ts:102) and the Compute panel
 * (`applyComputeEnv`, src/index.ts:106) — and the latter two are wrapped in
 * `.catch(() => {})`. Detecting at boot would report "none" for a user whose
 * keys are configured through the UI. Both call sites (SkillTool.init and the
 * compute_status tool) run per request, long after those injections, so the
 * ordering constraint cannot be violated and cannot silently regress if someone
 * reorders src/index.ts later.
 */
export namespace ComputeMode {
  export type Source = "byok" | "managed" | "none"

  /**
   * A provider is BYOK-usable only with BOTH a credential and a skill: the agent
   * runs GPU work by loading a provider's skill, so a key with no skill gives it
   * nothing to act on.
   *
   * `env` is a list of ALTERNATIVE groups; a group is satisfied when every var in
   * it is set and non-empty. Modal is the only pair — its single pasted key
   * splits into a token id + secret, and a half-pasted one maps to nothing
   * (mirroring `mapProviderEnv`, server/routes/settings/compute.ts:181).
   *
   * `skills` are frontmatter `name` values, NOT directory names and NOT
   * category-prefixed. Only these names are subject to mode filtering; the other
   * cloud-compute skills (tinker, skypilot, fireworks, together) are inference
   * APIs and orchestrators keyed by their own credentials, not GPU leases this
   * mode governs, and are never hidden.
   */
  export const PROVIDERS: Record<string, { env: string[][]; skills: string[] }> = {
    modal: {
      env: [["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]],
      skills: ["modal-serverless-gpu", "modal-ml-training", "modal-research-gpu"],
    },
    lambda: {
      env: [["LAMBDA_API_KEY"], ["LAMBDA_LABS_API_KEY"]],
      skills: ["lambda-labs-gpu-cloud"],
    },
    tensorpool: {
      env: [["TENSORPOOL_KEY"], ["TENSORPOOL_API_KEY"]],
      skills: ["tensorpool-gpu-cloud"],
    },
    prime: {
      env: [["PRIME_API_KEY"], ["PRIME_INTELLECT_API_KEY"]],
      skills: ["prime-intellect-lab"],
    },
    runpod: {
      env: [["RUNPOD_API_KEY"]],
      skills: ["runpod-gpu-cloud"],
    },
    vast: {
      env: [["VAST_API_KEY"]],
      skills: ["vast-ai-gpu-cloud"],
    },
  }

  /** Every provider skill name — the exact set the catalog filter operates on. */
  export const SKILLS = new Set(Object.values(PROVIDERS).flatMap((p) => p.skills))

  /** Read process.env directly rather than Env.get: applyComputeEnv writes to
   *  process.env first and mirrors to Env only when instance state exists, so
   *  process.env is the one source that is always populated. */
  function keyed(groups: string[][]): boolean {
    return groups.some((group) => group.every((name) => !!process.env[name]))
  }

  /**
   * Split configured providers into those the agent can actually act on and
   * those with a stored key but no catalogued skill. The second list exists so
   * `none` can say *why* — a user who connected a key and is then told no
   * compute is available deserves better than silence.
   */
  export async function usable() {
    const catalog = new Set(await Skill.all().then((all) => all.map((skill) => skill.name)))
    const providers: string[] = []
    const unusable: string[] = []
    for (const [id, spec] of Object.entries(PROVIDERS)) {
      if (!keyed(spec.env)) continue
      if (spec.skills.some((name) => catalog.has(name))) providers.push(id)
      else unusable.push(id)
    }
    return { providers, unusable }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/compute/mode.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Prove each assertion against deletion**

For each mutation named in Step 1, temporarily apply it to `src/compute/mode.ts`, run the suite, confirm the named test fails, then revert. Specifically:

1. In `usable()`, delete the `if (!keyed(spec.env)) continue` line → "a catalogued skill with NO key" must fail.
2. In `usable()`, replace the `spec.skills.some(...)` branch with an unconditional `providers.push(id)` → "a key with NO catalogued skill" must fail.
3. In `keyed()`, change `group.every(...)` to `group.some(...)` → "modal needs BOTH token vars" must fail.
4. In `keyed()`, change `!!process.env[name]` to `name in process.env` → "an empty-string key does not count" must fail.
5. Hoist the `catalog` set to module scope so it is computed once → "a key injected after the first call" still passes (env is not cached), but note this in the commit body: freshness of the _skill_ list is `Instance.state`'s job, and Task 4 covers per-turn catalog freshness.

Record the five results in the commit body.

- [ ] **Step 6: Typecheck, format, commit**

```bash
cd backend/cli && bun run typecheck
bunx prettier --write src/compute/mode.ts test/compute/mode.test.ts
git add src/compute/mode.ts test/compute/mode.test.ts
git commit -m "feat(compute): resolve usable GPU providers from key and skill"
```

---

### Task 1b: Revise the rule to credential-only

Applies Decision 2. A provider is BYOK-usable when it has a credential; the skill conjunction is deleted, and with it the `unusable` concept.

**Files:**

- Modify: `backend/cli/src/compute/mode.ts`
- Modify: `backend/cli/test/compute/mode.test.ts`

**Interfaces:**

- Consumes: `Skill.all()` is **no longer needed by the resolver** — remove the import if nothing else uses it.
- Produces, replacing Task 1's contract:
  - `ComputeMode.PROVIDERS: Record<string, { env: string[][]; skills: string[] }>` — unchanged shape; `runpod` and `vast` now carry `skills: []`.
  - `ComputeMode.SKILLS: Set<string>` — unchanged meaning, now six names.
  - `ComputeMode.usable(): string[]` — **synchronous.** Returns credentialed provider ids in `PROVIDERS` declaration order. No object, no `unusable`, no `Promise`.

- [ ] **Step 1: Update the tests first**

In `backend/cli/test/compute/mode.test.ts`:

- Every `result.providers` becomes `result` (the return is now the array itself).
- Delete the `unusable` assertions and the two tests that exist only to prove the key-without-skill state: "a key with NO catalogued skill is not usable" and the `unusable`-ordering test.
- **Replace** "a key with NO catalogued skill is not usable" with its inverse, which is now the rule:

```ts
test("a key with NO catalogued skill IS usable — the agent drives the provider API directly", async () => {
  clearEnv()
  process.env["RUNPOD_API_KEY"] = "rpa_abc"
  expect(await withSkills([], () => ComputeMode.usable())).toEqual(["runpod"])
})
```

- **Delete** "a catalogued skill with NO key is not usable"? No — keep it. A skill without a credential must still not make a provider usable, and it is now the only guard on the env check. Update it to assert `toEqual([])` against the bare array.
- The `SKILLS` literal drops to six names: `modal-serverless-gpu`, `modal-ml-training`, `modal-research-gpu`, `lambda-labs-gpu-cloud`, `tensorpool-gpu-cloud`, `prime-intellect-lab`.
- Keep the Modal-pair tests, the empty-string test, the declaration-order test, and the mid-session-injection test — all still load-bearing.
- Modal's three-skill-names test no longer proves anything about resolution (Modal resolves on its key alone now). **Delete it**, and instead assert the catalog-facing contract it was really protecting:

```ts
test("PROVIDERS pins the exact skill names the catalog filter matches on", async () => {
  expect([...ComputeMode.SKILLS].sort()).toEqual(
    [
      "lambda-labs-gpu-cloud",
      "modal-ml-training",
      "modal-research-gpu",
      "modal-serverless-gpu",
      "prime-intellect-lab",
      "tensorpool-gpu-cloud",
    ].sort(),
  )
  expect(ComputeMode.PROVIDERS["runpod"].skills).toEqual([])
  expect(ComputeMode.PROVIDERS["vast"].skills).toEqual([])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend/cli && bun test test/compute/mode.test.ts`
Expected: FAIL — `usable()` still returns an object, and RunPod-with-no-skill still resolves to unusable.

- [ ] **Step 3: Apply the rule change**

In `backend/cli/src/compute/mode.ts`:

- Set `runpod` and `vast` to `skills: []`.
- Replace `usable()` with:

```ts
/**
 * The credentialed GPU providers, in declaration order.
 *
 * A credential is the whole test. An earlier revision also required a
 * matching skill, on the theory that a provider with no skill gives the agent
 * nothing to act on — but a capable agent drives a documented cloud API from a
 * key, so that conjunction only produced a false "no compute available" for
 * users holding a perfectly workable key. A skill, where one exists, is a
 * quality boost; the catalog filter still offers a provider's skills only when
 * that provider is credentialed.
 */
export function usable(): string[] {
  return Object.keys(PROVIDERS).filter((id) => keyed(PROVIDERS[id].env))
}
```

Note it is now **synchronous** — it no longer awaits the skill catalog. Keep the call sites `await`-compatible by leaving `resolve()` async (Task 2); do not add a gratuitous `Promise.resolve`.

- Remove the `Skill` import if nothing else in the file uses it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/compute/mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the new assertions against deletion**

1. Delete the `filter((id) => keyed(...))` predicate so every provider is returned → "a catalogued skill with NO key" must fail.
2. Change `group.every` to `group.some` in `keyed()` → the Modal-pair test must fail.
3. Restore the skill conjunction (`&& PROVIDERS[id].skills.some(...)`) → the new RunPod test must fail. This is the specific regression the change exists to prevent.
4. Corrupt one character of any skill string in `PROVIDERS` → the `SKILLS` pin test must fail.

- [ ] **Step 6: Typecheck, format, commit**

```bash
cd backend/cli && bun run typecheck && bun test test/compute/
bunx prettier --write src/compute/mode.ts test/compute/mode.test.ts
git add src/compute/mode.ts test/compute/mode.test.ts
git commit -m "refactor(compute): a credential alone makes a GPU provider usable"
```

---

### Task 2: Managed availability and full resolution

Adds the network half and the override rules, completing the resolver.

**Files:**

- Modify: `backend/cli/src/compute/mode.ts`
- Test: `backend/cli/test/compute/mode.test.ts` (append a `describe`)

**Interfaces:**

- Consumes: `ComputeMode.usable()` **as revised by Task 1b — synchronous, returns `string[]`**; `OpenScience.getSession()` and `OpenScience.API_BASE` from `@/openscience`; `Config.get()` from `@/config/config`.
- Produces, for Tasks 3 and 4:
  - `interface ComputeMode.Resolution { mode: Source; providers: string[]; managed: boolean; balance?: number }` — `balance` is USD and present only when `mode === "managed"`. **There is no `unusable` field** (Decision 2).
  - `ComputeMode.resolve(): Promise<Resolution>`
  - `ComputeMode.invalidate(): void` — drops the availability cache; tests call it in `beforeEach`.

- [ ] **Step 1: Write the failing test**

Append to `backend/cli/test/compute/mode.test.ts`:

```ts
const OPTIONS_URL = "/api/compute/options"
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch

/** Record of every URL the resolver fetched, so "the call is skipped" is a
 *  positive assertion rather than an absence of failure. */
let calls: string[] = []

function stubOptions(body: unknown, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (!url.includes(OPTIONS_URL)) return realFetch(input as never)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

async function signIn() {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(SESSION, JSON.stringify({ api_key: "thk_test.secret", user_id: "u1" }))
}

const MANAGED_ON = {
  options: [],
  providers: [
    { provider: "lambda", has_byok: false, has_operator: true, funding: "managed", count: 3 },
    { provider: "vast", has_byok: false, has_operator: false, funding: "unavailable", count: 0 },
  ],
  resell_enabled: true,
  cli_effective_balance_cents: 1234,
}

const MANAGED_OFF = {
  options: [],
  providers: [{ provider: "lambda", has_byok: false, has_operator: false, funding: "unavailable", count: 0 }],
  resell_enabled: false,
  cli_effective_balance_cents: 1234,
}

describe("ComputeMode.resolve", () => {
  beforeEach(() => {
    clearEnv()
    calls = []
    ComputeMode.invalidate()
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  test("a usable provider resolves to byok WITHOUT calling the availability endpoint", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
    expect(result.providers).toEqual(["lambda"])
    expect(result.balance).toBeUndefined()
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("no keys plus managed available resolves to managed, with the balance", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("managed")
    expect(result.managed).toBe(true)
    expect(result.balance).toBe(12.34)
  })

  test("no keys plus managed unavailable resolves to none", async () => {
    await signIn()
    stubOptions(MANAGED_OFF)
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(result.managed).toBe(false)
    expect(result.balance).toBeUndefined()
  })

  test("a failing availability call resolves to none, not managed", async () => {
    await signIn()
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as typeof fetch
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(result.managed).toBe(false)
  })

  test("a non-ok availability response resolves to none", async () => {
    await signIn()
    stubOptions({ detail: "unauthorized" }, 401)
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
  })

  test("no session means managed is unavailable and no call is made", async () => {
    await fs.rm(SESSION, { force: true }).catch(() => {})
    stubOptions(MANAGED_ON)
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("a key with no skill still resolves to byok and skips the availability call", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["RUNPOD_API_KEY"] = "rpa_x"
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
    expect(result.providers).toEqual(["runpod"])
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("the availability answer is cached within the TTL", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    await withSkills([], async () => {
      await ComputeMode.resolve()
      await ComputeMode.resolve()
    })
    expect(calls.filter((url) => url.includes(OPTIONS_URL)).length).toBe(1)
  })

  test("invalidate() drops the cache", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    await withSkills([], async () => {
      await ComputeMode.resolve()
      ComputeMode.invalidate()
      await ComputeMode.resolve()
    })
    expect(calls.filter((url) => url.includes(OPTIONS_URL)).length).toBe(2)
  })
})

describe("ComputeMode.resolve override", () => {
  beforeEach(() => {
    clearEnv()
    calls = []
    ComputeMode.invalidate()
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  /** Same tmpdir fixture as withSkills, plus an openscience.json setting
   *  billing.compute. */
  async function withOverride<T>(mode: "byok" | "managed", skills: string[], fn: () => Promise<T>): Promise<T> {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const name of skills) {
          await Bun.write(
            path.join(dir, ".openscience", "skill", name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Test fixture for ${name}.\ncategory: cloud-compute\n---\n\n# ${name}\n`,
          )
        }
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ billing: { compute: mode } }))
      },
    })
    return Instance.provide({ directory: tmp.path, fn })
  }

  test("override byok with a usable provider stays byok", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withOverride("byok", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
  })

  test("override byok with NO usable provider narrows to none, never managed", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    const result = await withOverride("byok", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("override managed with managed unavailable narrows to none", async () => {
    await signIn()
    stubOptions(MANAGED_OFF)
    const result = await withOverride("managed", [], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
  })

  test("override managed beats a usable provider when managed IS available", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withOverride("managed", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("managed")
  })
})
```

Add these imports at the top of the file, alongside the existing ones:

```ts
import { beforeEach } from "bun:test"
import fs from "fs/promises"
import { Global } from "../../src/global"
```

Mutations these guard: deleting the `providers.length` short-circuit before the network call (the two "no call is made" assertions fail); flipping the catch/`!res.ok` fallbacks from `false` to `true` (the two failure tests resolve to `managed`); deleting the cache (the TTL test sees 2 calls); deleting `invalidate()`'s body (that test sees 1 call); deleting the override branch entirely (the two narrow-to-none tests resolve to `byok`/`managed`); deleting only the `"byok"` override arm (narrow-to-none returns `managed`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/cli && bun test test/compute/mode.test.ts`
Expected: FAIL — `ComputeMode.resolve is not a function`.

- [ ] **Step 3: Implement resolution**

Append to `backend/cli/src/compute/mode.ts`, inside the `ComputeMode` namespace, and add the imports `import { Config } from "@/config/config"` and `import { OpenScience } from "@/openscience"` at the top:

```ts
export interface Resolution {
  mode: Source
  /** Credentialed BYOK providers, in PROVIDERS declaration order. */
  providers: string[]
  managed: boolean
  /** Wallet balance in USD. Present only when mode === "managed". */
  balance?: number
}

/** Hard ceiling on how long resolution may block an agent turn. Atlas's own
 *  60s default is far too long to sit in front of a tool call; a slow or
 *  hanging backend must degrade to "none", not stall the turn. */
const TIMEOUT = 3_000

/** Short in-process TTL, enough to stop a chatty agent hammering the endpoint
 *  inside one turn and no longer. The whole reason this is a tool rather than
 *  a prompt injection is that the answer changes mid-session, so a long cache
 *  would reintroduce exactly the staleness the tool exists to avoid. */
const TTL = 5_000

let cache: { at: number; value: { managed: boolean; balance?: number } } | undefined

/** Drop the availability cache. Called by tests; also safe after a connect. */
export function invalidate() {
  cache = undefined
}

/**
 * One authenticated call to /api/compute/options, which already annotates each
 * provider with `funding` — "managed" when reselling is on and an operator key
 * exists, else "unavailable". A failed, unauthenticated or timed-out call is
 * treated as UNAVAILABLE: failing toward "none" produces an honest "connect a
 * key" message, whereas failing toward "managed" would reproduce the bug this
 * design exists to fix, promising a capability we never confirmed.
 */
async function available() {
  if (cache && Date.now() - cache.at < TTL) return cache.value
  const value = await probe()
  cache = { at: Date.now(), value }
  return value
}

async function probe(): Promise<{ managed: boolean; balance?: number }> {
  const session = await OpenScience.getSession().catch(() => null)
  if (!session) return { managed: false }
  try {
    const res = await fetch(`${OpenScience.API_BASE}/api/compute/options`, {
      headers: { Authorization: `Bearer ${session.api_key}` },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) return { managed: false }
    const data = await res.json()
    const providers = Array.isArray(data?.providers) ? data.providers : []
    const managed = providers.some((entry: { funding?: string }) => entry?.funding === "managed")
    if (!managed) return { managed: false }
    const cents = data?.cli_effective_balance_cents
    return { managed: true, balance: typeof cents === "number" ? cents / 100 : undefined }
  } catch {
    return { managed: false }
  }
}

/**
 * The single shared entry point. `billing.compute` is an OVERRIDE, not the
 * source of truth: it may narrow the outcome to "none", but it may never
 * manufacture a capability that isn't there.
 */
export async function resolve(): Promise<Resolution> {
  const providers = usable()
  const override = (await Config.get()).billing?.compute

  if (override === "byok") {
    return { mode: providers.length ? "byok" : "none", providers, managed: false }
  }

  if (override === "managed") {
    const managed = await available()
    return {
      mode: managed.managed ? "managed" : "none",
      providers,
      managed: managed.managed,
      balance: managed.managed ? managed.balance : undefined,
    }
  }

  // BYOK wins when a credentialed provider is present: it is free to the user,
  // it works today, and it needs nothing from Atlas. This is also why a BYOK
  // user never pays for the availability call.
  if (providers.length) return { mode: "byok", providers, managed: false }

  const managed = await available()
  return {
    mode: managed.managed ? "managed" : "none",
    providers,
    managed: managed.managed,
    balance: managed.managed ? managed.balance : undefined,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/compute/mode.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Prove each assertion against deletion**

Apply each mutation named in Step 1, confirm the named test fails, revert. Additionally verify the timeout is real: temporarily replace the stub with one that never resolves, assert `resolve()` returns `none` in under 4s, then revert.

- [ ] **Step 6: Typecheck, format, commit**

```bash
cd backend/cli && bun run typecheck && bun test test/compute/
bunx prettier --write src/compute/mode.ts test/compute/mode.test.ts
git add src/compute/mode.ts test/compute/mode.test.ts
git commit -m "feat(compute): resolve byok/managed/none at runtime, config becomes an override"
```

---

### Task 3: The `compute_status` tool

**Files:**

- Create: `backend/cli/src/tool/compute.ts`
- Modify: `backend/cli/src/tool/registry.ts`
- Test: `backend/cli/test/tool/compute-status.test.ts`

**Interfaces:**

- Consumes: `ComputeMode.resolve()` and `ComputeMode.Resolution` from Task 2; `Tool.define` from `./tool`.
- Produces: `ComputeStatusTool` (id `compute_status`) and `export const ComputeTools = [ComputeStatusTool]`, registered in `ToolRegistry`.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/tool/compute-status.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { ComputeStatusTool } from "../../src/tool/compute"
import { ComputeMode } from "../../src/compute/mode"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const ENV = ["LAMBDA_API_KEY", "RUNPOD_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch

const CTX = {
  sessionID: "ses_test",
  messageID: "msg_test",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

function stub(body: unknown, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes("/api/compute/options")) return realFetch(input as never)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

const MANAGED_ON = {
  providers: [{ provider: "lambda", funding: "managed", has_byok: false, has_operator: true, count: 2 }],
  resell_enabled: true,
  cli_effective_balance_cents: 4200,
}
const MANAGED_OFF = { providers: [], resell_enabled: false, cli_effective_balance_cents: 0 }

async function run(skills: string[], fn?: () => Promise<void>) {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const name of skills) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture ${name}.\ncategory: cloud-compute\n---\n\n# ${name}\n`,
        )
      }
    },
  })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fn?.()
      const tool = await ComputeStatusTool.init({})
      return tool.execute({}, CTX as never)
    },
  })
}

describe("compute_status", () => {
  beforeEach(async () => {
    for (const name of ENV) delete process.env[name]
    ComputeMode.invalidate()
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(SESSION, JSON.stringify({ api_key: "thk_t.s", user_id: "u1" }))
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    for (const name of ENV) delete process.env[name]
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  test("byok reports the mode, the usable providers, and byok guidance", async () => {
    stub(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await run(["lambda-labs-gpu-cloud"])
    expect(result.metadata.mode).toBe("byok")
    expect(result.metadata.providers).toEqual(["lambda"])
    expect(result.output).toContain("lambda")
    expect(result.output.toLowerCase()).toContain("do not launch managed")
    expect(result.metadata.balance_usd).toBeUndefined()
  })

  test("managed reports the balance and managed guidance", async () => {
    stub(MANAGED_ON)
    const result = await run([])
    expect(result.metadata.mode).toBe("managed")
    expect(result.metadata.balance_usd).toBe(42)
    expect(result.output).toContain("42")
    expect(result.output.toLowerCase()).toContain("credits")
  })

  test("none tells the agent not to attempt GPU work and how to enable it", async () => {
    stub(MANAGED_OFF)
    const result = await run([])
    expect(result.metadata.mode).toBe("none")
    expect(result.output.toLowerCase()).toContain("do not attempt gpu work")
    expect(result.output).toContain("Settings")
    expect(result.metadata.balance_usd).toBeUndefined()
  })

  test("a provider with a key but no skill is still reported as usable byok", async () => {
    stub(MANAGED_OFF)
    process.env["RUNPOD_API_KEY"] = "rpa_x"
    const result = await run([])
    expect(result.metadata.mode).toBe("byok")
    expect(result.metadata.providers).toEqual(["runpod"])
    expect(result.output).toContain("runpod")
  })

  test("the three modes produce three DIFFERENT guidance strings", async () => {
    stub(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const byok = await run(["lambda-labs-gpu-cloud"])
    delete process.env["LAMBDA_API_KEY"]
    ComputeMode.invalidate()
    const managed = await run([])
    stub(MANAGED_OFF)
    ComputeMode.invalidate()
    const none = await run([])
    const texts = [byok.output, managed.output, none.output]
    expect(new Set(texts).size).toBe(3)
  })

  test("a credential connected between two calls changes the answer, no restart", async () => {
    stub(MANAGED_OFF)
    const before = await run([])
    expect(before.metadata.mode).toBe("none")
    process.env["LAMBDA_API_KEY"] = "connected-mid-session"
    const after = await run(["lambda-labs-gpu-cloud"])
    expect(after.metadata.mode).toBe("byok")
  })

  test("the description instructs the agent to check before running GPU work", async () => {
    const tool = await ComputeStatusTool.init({})
    expect(tool.description.toLowerCase()).toContain("before")
    expect(tool.description.toLowerCase()).toContain("gpu")
    expect(tool.description).toContain("byok")
    expect(tool.description).toContain("managed")
    expect(tool.description).toContain("none")
  })

  test("the tool is registered", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ToolRegistry.ids()).toContain("compute_status")
      },
    })
  })
})
```

Mutations these guard: deleting the `providers` field from the output (test 1); deleting the balance line (test 2); returning one shared guidance string for every mode (test 5); deleting the `unusable` reporting (test 4); deleting the description's "before" instruction (test 7); removing the registry entry (test 8); caching the resolution at module load (test 6).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/cli && bun test test/tool/compute-status.test.ts`
Expected: FAIL — `Cannot find module '../../src/tool/compute'`.

- [ ] **Step 3: Write the tool**

Create `backend/cli/src/tool/compute.ts`:

```ts
import z from "zod"
import { Tool } from "./tool"
import { ComputeMode } from "@/compute/mode"

/**
 * The agent PULLS its compute mode from here; nothing is injected per turn.
 *
 * An earlier design injected mode guidance into every turn. That was wrong for a
 * reason that matters more than token cost: the mode changes mid-session. A user
 * connects a Modal key in Settings ▸ Compute while a session is running, and a
 * reminder injected at turn 3 is false by turn 12. A tool returns the state at
 * the moment it is asked.
 *
 * The DESCRIPTION carries the constraint — it reaches the agent before it starts
 * down a path, which is the one thing an injection did well, and tool definitions
 * are in every request regardless, so it costs nothing extra. The RESULT carries
 * the specifics. Adding rates or a balance to an every-turn injection would be
 * expensive; adding them here is free.
 */

const GUIDANCE: Record<ComputeMode.Source, string> = {
  byok: "Run GPU work on the user's connected providers via the cloud-compute skills. Do not launch managed leases — they bill Credits and are not the funded path here.",
  managed:
    "Run GPU work through managed compute, billed to Credits. Do not use the user's own provider keys — they are not funded here.",
  none: "No compute is available. Do not attempt GPU work. Tell the user to connect a provider key in Settings ▸ Compute, or to top up for managed compute.",
}

export const ComputeStatusTool = Tool.define("compute_status", {
  description: [
    "Check how GPU compute is funded before running any GPU, training, or cluster work.",
    "Returns one of byok, managed, or none, the providers available, and the rule that applies.",
    "Call this first — the answer can change mid-session as the user connects or removes keys.",
  ].join(" "),
  parameters: z.object({}),
  async execute(_params, _ctx) {
    const state = await ComputeMode.resolve()
    const lines = [
      `**mode**: ${state.mode}`,
      `**providers**: ${state.providers.length ? state.providers.join(", ") : "none configured"}`,
      `**managed available**: ${state.managed ? "yes" : "no"}`,
    ]
    if (state.balance !== undefined) lines.push(`**balance**: $${state.balance.toFixed(2)}`)
    lines.push("", GUIDANCE[state.mode])

    return {
      title: `Compute: ${state.mode}`,
      output: lines.join("\n"),
      metadata: {
        mode: state.mode,
        providers: state.providers,
        managed_available: state.managed,
        balance_usd: state.balance,
      },
    }
  },
})

export const ComputeTools = [ComputeStatusTool]
```

- [ ] **Step 4: Register the tool**

In `backend/cli/src/tool/registry.ts`, add the import next to the other tool imports:

```ts
import { ComputeTools } from "./compute"
```

and add `...ComputeTools,` to the array returned by `all()`, immediately after `...ProvenanceTools,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/tool/compute-status.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove each assertion against deletion**

Apply each mutation named in Step 1, confirm the named test fails, revert. In particular, collapse `GUIDANCE` to a single shared string and confirm "the three modes produce three DIFFERENT guidance strings" fails — an inversion would not catch this.

- [ ] **Step 7: Typecheck, format, commit**

```bash
cd backend/cli && bun run typecheck && bun test test/tool/
bunx prettier --write src/tool/compute.ts src/tool/registry.ts test/tool/compute-status.test.ts
git add src/tool/compute.ts src/tool/registry.ts test/tool/compute-status.test.ts
git commit -m "feat(tool): add compute_status so the agent pulls its compute mode"
```

---

### Task 4: Filter the skill catalog by resolved mode

**Files:**

- Modify: `backend/cli/src/tool/skill.ts:32-58`
- Test: `backend/cli/test/tool/skill-compute-filter.test.ts`

**Interfaces:**

- Consumes: `ComputeMode.resolve()`, `ComputeMode.SKILLS`, `ComputeMode.PROVIDERS` from Tasks 1–2.
- Produces: nothing new. `SkillTool.init` keeps its existing shape.

`SkillTool.init` is the right seam for two reasons. `registry.ts:187` calls `await t.init({ agent })` inside `tools()`, so **it runs per request** — a credential connected mid-session appears on the next turn with no cache to invalidate. And by the time a turn is served, every env injection in `src/index.ts` has long since run, so detection cannot observe a half-initialised environment.

**Filter the catalog; do not auto-load the markdown.** Only usable providers' skills are listed, so the agent picks the right one because it is the only one offered. Auto-injecting a provider's markdown would fight the mechanism `tool/skill.ts` exists to provide, and these files run 500+ lines — unprompted injection is expensive on turns that have nothing to do with compute.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/tool/skill-compute-filter.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { SkillTool } from "../../src/tool/skill"
import { ComputeMode } from "../../src/compute/mode"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const ENV = ["LAMBDA_API_KEY", "RUNPOD_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "TENSORPOOL_KEY"]
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch

// Every provider skill, plus two skills that must never be filtered: a
// non-compute one and a cloud-compute skill that maps to no panel provider.
const ALL = [
  ["modal-serverless-gpu", "cloud-compute"],
  ["lambda-labs-gpu-cloud", "cloud-compute"],
  ["tensorpool-gpu-cloud", "cloud-compute"],
  ["prime-intellect-lab", "ml-training"],
  ["tinker-fine-tuning", "cloud-compute"],
  ["rdkit", "chemistry"],
] as const

function stub(managed: boolean) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes("/api/compute/options")) return realFetch(input as never)
    return new Response(
      JSON.stringify({
        providers: managed ? [{ provider: "lambda", funding: "managed" }] : [],
        resell_enabled: managed,
        cli_effective_balance_cents: 500,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
}

async function project(fn: (dir: string) => Promise<unknown>) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      for (const [name, category] of ALL) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture ${name}.\ncategory: ${category}\n---\n\n# ${name}\n`,
        )
      }
      await fn(dir)
    },
  })
}

/** Which of the six provider skills does the tool offer? Read from the tool's
 *  own category listing, which is what the model sees. */
async function offered(): Promise<string[]> {
  const tool = await SkillTool.init({})
  const found: string[] = []
  for (const category of ["cloud-compute", "ml-training"]) {
    const result = await tool
      .execute({ category }, {
        sessionID: "s",
        messageID: "m",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } as never)
      .catch(() => undefined)
    if (result) found.push(result.output)
  }
  const text = found.join("\n")
  return [...ComputeMode.SKILLS].filter((name) => text.includes(`**${name}**`)).sort()
}

async function nonComputeVisible(): Promise<boolean> {
  const tool = await SkillTool.init({})
  const result = await tool.execute({ category: "chemistry" }, {
    sessionID: "s",
    messageID: "m",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as never)
  return result.output.includes("**rdkit**")
}

async function tinkerVisible(): Promise<boolean> {
  const tool = await SkillTool.init({})
  const result = await tool.execute({ category: "cloud-compute" }, {
    sessionID: "s",
    messageID: "m",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as never)
  return result.output.includes("**tinker-fine-tuning**")
}

describe("skill catalog filtering by compute mode", () => {
  beforeEach(async () => {
    for (const name of ENV) delete process.env[name]
    ComputeMode.invalidate()
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(SESSION, JSON.stringify({ api_key: "thk_t.s", user_id: "u1" }))
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    for (const name of ENV) delete process.env[name]
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  test("with only a Modal credential, only Modal's skills are offered", async () => {
    stub(false)
    process.env["MODAL_TOKEN_ID"] = "ak-a"
    process.env["MODAL_TOKEN_SECRET"] = "as-b"
    await using tmp = await project(async () => {})
    const names = await Instance.provide({ directory: tmp.path, fn: offered })
    expect(names).toEqual(["modal-serverless-gpu"])
  })

  test("a RunPod credential is byok but contributes no skills — nobody else's are offered either", async () => {
    stub(false)
    process.env["RUNPOD_API_KEY"] = "rpa_x"
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // RunPod carries skills: [] (Decision 2), so being credentialed makes the
        // user byok without unlocking any other provider's skills.
        expect((await ComputeMode.resolve()).mode).toBe("byok")
        expect(await offered()).toEqual([])
      },
    })
  })

  test("in managed, no BYOK provider skill is offered", async () => {
    stub(true)
    await using tmp = await project(async () => {})
    const names = await Instance.provide({ directory: tmp.path, fn: offered })
    expect(names).toEqual([])
  })

  test("in none, no BYOK provider skill is offered", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    const names = await Instance.provide({ directory: tmp.path, fn: offered })
    expect(names).toEqual([])
  })

  test("non-compute skills are unaffected in every mode", async () => {
    for (const managed of [true, false]) {
      stub(managed)
      ComputeMode.invalidate()
      await using tmp = await project(async () => {})
      expect(await Instance.provide({ directory: tmp.path, fn: nonComputeVisible })).toBe(true)
    }
  })

  test("cloud-compute skills that map to no panel provider are never hidden", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    expect(await Instance.provide({ directory: tmp.path, fn: tinkerVisible })).toBe(true)
  })

  test("a credential added between two init() calls changes the catalog on the second", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await offered()).toEqual([])
        process.env["TENSORPOOL_KEY"] = "tp-late"
        expect(await offered()).toEqual(["tensorpool-gpu-cloud"])
      },
    })
  })

  test("SkillTool.init and compute_status never disagree about usable providers", async () => {
    stub(false)
    process.env["LAMBDA_API_KEY"] = "k"
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = await ComputeMode.resolve()
        const names = await offered()
        const expected = state.providers.flatMap((id) => ComputeMode.PROVIDERS[id].skills)
        expect(names.sort()).toEqual([...new Set(expected)].sort())
      },
    })
  })
})
```

Mutations these guard: deleting the filter entirely (tests 1–4 and 8 fail); widening the filter to the whole `cloud-compute` category (test 6 fails); widening it to every skill (test 5 fails); resolving the mode once at module load instead of inside `init` (test 7's second assertion fails); filtering by provider id instead of skill name (test 1 fails).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/cli && bun test test/tool/skill-compute-filter.test.ts`
Expected: FAIL — every provider skill is offered in all modes.

- [ ] **Step 3: Add the filter**

In `backend/cli/src/tool/skill.ts`, add the import:

```ts
import { ComputeMode } from "@/compute/mode"
```

and replace the `accessibleSkills` block (currently lines 36-42) with:

```ts
// Filter skills by agent permissions if agent provided
const agent = ctx?.agent
const permitted = agent
  ? skills.filter((skill) => {
      const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
      return rule.action !== "deny"
    })
  : skills

// Filter the GPU provider skills by the resolved compute mode, so the agent
// picks the right provider because it is the only one offered. This init runs
// per request (registry.ts calls it inside tools()), which buys two things for
// free: a credential connected mid-session shows up on the next turn with no
// cache to invalidate, and resolution always happens after src/index.ts's env
// injections rather than racing them.
//
// This is a LISTING filter, not a gate. `none` is guidance, not enforcement —
// a hidden skill can still be loaded by exact name, and the agent still has
// bash. Gating the load path is a larger change and is deliberately out of
// scope; see docs/specs/compute-mode-detection-design.md open question 3.
const compute = await ComputeMode.resolve()
const offered = new Set(compute.providers.flatMap((id) => ComputeMode.PROVIDERS[id].skills))
const accessibleSkills = permitted.filter((skill) => !ComputeMode.SKILLS.has(skill.name) || offered.has(skill.name))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/tool/skill-compute-filter.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full suite for regressions**

Run: `cd backend/cli && bun test`
Expected: PASS. `test/skill/` and `test/session/system-skills.test.ts` exercise the same catalog — if any of them go red, the filter is too wide.

- [ ] **Step 6: Prove each assertion against deletion**

Apply each mutation named in Step 1, confirm the named test fails, revert.

- [ ] **Step 7: Typecheck, format, commit**

```bash
cd backend/cli && bun run typecheck
bunx prettier --write src/tool/skill.ts test/tool/skill-compute-filter.test.ts
git add src/tool/skill.ts test/tool/skill-compute-filter.test.ts
git commit -m "feat(skill): offer GPU provider skills only for usable providers"
```

---

### Task 5: Retire the false prompt injection, config text, and dead code

Three things in the current injected text do not hold: `atlas compute:up` is not in the published `@synsci/atlas@0.13.2`; `atlas doctor` reports no compute field at all, so the stated condition is unobservable; and managed compute is off by default server-side (`COMPUTE_RESELL_ENABLED` defaults to `false`). An agent in managed mode runs an unknown command, cannot check the sanctioned signal, and is pointed at "the user's own GPU providers" as the remedy — which in managed mode is precisely the set of keys that does not exist.

**Files:**

- Modify: `backend/cli/src/session/prompt.ts:1546-1564`
- Modify: `backend/cli/src/session/billing-gate.ts:33-36`
- Modify: `backend/cli/src/config/config.ts:1058-1064`
- Test: `backend/cli/test/session/compute-prompt.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `computeBillingMode` no longer exists. `BillingMode`, `llmBillingMode`, `resolveCredentialSource`, `requiresWalletBalance` and `shouldReportUsage` are unchanged.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/session/compute-prompt.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import path from "path"

const root = path.join(import.meta.dir, "..", "..", "src")

async function sources() {
  const files = await Array.fromAsync(
    new Bun.Glob("session/**/*.{ts,txt}").scan({ cwd: root, absolute: true, onlyFiles: true }),
  )
  return Promise.all(files.map(async (file) => [file, await Bun.file(file).text()] as const))
}

describe("compute prompt text", () => {
  test("no prompt or session source references atlas compute:up", async () => {
    const hits = (await sources()).filter(([, text]) => text.includes("compute:up"))
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("no prompt or session source uses atlas doctor as the compute availability signal", async () => {
    const hits = (await sources()).filter(([, text]) => /atlas doctor/i.test(text))
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("the compute reminder points at compute_status and carries no mode", async () => {
    const text = await Bun.file(path.join(root, "session", "prompt.ts")).text()
    expect(text).toContain("compute_status")
    // The reminder must be stateless — a mode baked into an injected string is
    // false the moment the user connects a key mid-session.
    expect(text).not.toContain("Compute spend is set to")
  })

  test("computeBillingMode is gone and nothing imports it", async () => {
    const gate = await Bun.file(path.join(root, "session", "billing-gate.ts")).text()
    expect(gate).not.toContain("computeBillingMode")
    const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true, onlyFiles: true }))
    const importers = (
      await Promise.all(
        files.map(async (file) => ((await Bun.file(file).text()).includes("computeBillingMode") ? file : undefined)),
      )
    ).filter(Boolean)
    expect(importers).toEqual([])
  })

  test("the billing.compute config description no longer claims 'Unset = byok'", async () => {
    const text = await Bun.file(path.join(root, "config", "config.ts")).text()
    expect(text).not.toContain("Unset = byok")
    expect(text).toContain("auto-detect")
  })
})
```

Mutations these guard: leaving either false claim in any session prompt (tests 1–2); re-introducing a mode-carrying injection (test 3); leaving `computeBillingMode` behind as dead code (test 4); forgetting the config description (test 5).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/cli && bun test test/session/compute-prompt.test.ts`
Expected: FAIL on tests 1, 2, 3, 4 and 5 — all five conditions currently hold in the wrong direction.

- [ ] **Step 3: Replace the injection**

In `backend/cli/src/session/prompt.ts`, replace the whole block currently at lines 1550-1564 (from the `// Compute spend preference` comment through the closing `}` of the `if`) with:

```ts
// Compute funding is PULLED from the `compute_status` tool, not injected —
// the mode changes mid-session (a key connected in Settings ▸ Compute at
// turn 3 makes a reminder injected then false by turn 12). This line is a
// stateless pointer: it carries no mode, so it can never go stale, and it
// closes the gap where an agent reaches for bash without ever looking.
if (COMPUTE_AGENTS.has(input.agent.name)) {
  userMessage.parts.push({
    id: Identifier.ascending("part"),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: "<system-reminder>Call `compute_status` before running GPU, training, or cluster work. It reports how compute is funded and which providers are usable right now.</system-reminder>",
    synthetic: true,
  })
}
```

Then delete the now-unused import on line 46: `import { computeBillingMode } from "./billing-gate"`.

- [ ] **Step 4: Delete the dead function**

In `backend/cli/src/session/billing-gate.ts`, delete lines 33-36:

```ts
/** The user-facing compute spend toggle. Defaults to "byok" (own GPU providers). */
export async function computeBillingMode(): Promise<BillingMode> {
  return (await Config.get()).billing?.compute ?? "byok"
}
```

`prompt.ts:1554` was its only consumer. `Config` is still imported for `llmBillingMode`, so leave the import.

- [ ] **Step 5: Correct the config description**

In `backend/cli/src/config/config.ts`, replace the `compute` field's `.describe(...)` string (line 1062) with:

```ts
              "How GPU/compute is paid for. 'managed' runs on Atlas-provisioned compute billed to your wallet; 'byok' uses your own connected GPU providers (Modal, Lambda Labs, TensorPool, Prime Intellect, RunPod, Vast.ai). Unset = auto-detect from your connected providers. Setting this can only narrow the result — if the mode you pick isn't actually available, compute resolves to none rather than pretending.",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/session/compute-prompt.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full suite**

Run: `cd backend/cli && bun test && bun run typecheck`
Expected: PASS. Any test asserting the old injected text must be updated to the new reminder, not deleted.

- [ ] **Step 8: Prove each assertion against deletion**

Apply each mutation named in Step 1, confirm the named test fails, revert.

- [ ] **Step 9: Format and commit**

```bash
cd backend/cli
bunx prettier --write src/session/prompt.ts src/session/billing-gate.ts src/config/config.ts test/session/compute-prompt.test.ts
git add src/session/prompt.ts src/session/billing-gate.ts src/config/config.ts test/session/compute-prompt.test.ts
git commit -m "fix(prompt): drop the false atlas compute:up guidance for a compute_status pointer"
```

---

### Task 5b: Finish acceptance criterion 12 in the agent prompts

Task 5 discharged criterion 12 for `src/session/**` only. Its tests glob `session/**/*.{ts,txt}`, which excludes `src/agent/prompt/*.txt` — and the primary `research` agent's prompt still gates managed compute on `atlas doctor`, the same false signal Task 5 just removed from `prompt.ts`. Both the Task 5 implementer and its reviewer surfaced this independently.

**Files:**

- Modify: `backend/cli/src/agent/prompt/research.txt` (Stage 5: COMPUTE, lines 252-261)
- Modify: `backend/cli/test/session/compute-prompt.test.ts`

**Interfaces:** none — prompt text and test scope only.

**What is wrong, precisely.** `research.txt:253-257` currently reads:

```
- Managed compute (Daytona-backed) runs through the bundled `atlas` CLI when your Atlas
  session is active. Run `atlas doctor --format=json` first; if it reports the CLI is
  unavailable/unauthenticated, print a one-line note and fall back to the BYOK cloud-compute
  skills below (Modal, Tinker, TensorPool, Prime Intellect, HF Jobs) — never block on it.
```

`atlas doctor` reports `config_path`, `profile`, `base_url`, `auth`, `backend`, `package.skills`, `integrations`, `spool`, `warnings`, `ok` — **nothing about compute**. Using CLI auth as a proxy for managed-compute availability is the wrong signal in the worst direction: managed compute is off behind `COMPUTE_RESELL_ENABLED=false` regardless of authentication, so an authenticated user is told managed compute works when it does not.

**Out of scope, deliberately.** `research.txt:81-84` also runs `atlas doctor`, to check whether the `atlas` CLI is present and authenticated before loading graph state. That is a valid use of a signal the command genuinely reports — leave it alone. The absence tests must not become so broad that they forbid it.

- [ ] **Step 1: Widen the test scope to prove the gap exists**

In `backend/cli/test/session/compute-prompt.test.ts`, change `sources()` to scan agent prompts as well as session ones:

```ts
async function sources() {
  const globs = ["session/**/*.{ts,txt}", "agent/prompt/*.txt"]
  const files = (
    await Promise.all(
      globs.map((pattern) =>
        Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true })),
      ),
    )
  ).flat()
  return Promise.all(files.map(async (file) => [file, await Bun.file(file).text()] as const))
}
```

Then replace the blanket `atlas doctor` test with one that forbids it **as a compute signal** while still permitting the CLI-availability check:

```ts
test("the file set is non-empty and covers both prompt trees", async () => {
  const files = (await sources()).map(([file]) => path.relative(root, file))
  expect(files.length).toBeGreaterThan(20)
  expect(files).toContain("session/prompt.ts")
  expect(files).toContain("agent/prompt/research.txt")
})

test("no prompt uses atlas doctor as the compute availability signal", async () => {
  // `atlas doctor` legitimately reports whether the atlas CLI is present and
  // authenticated (research.txt uses it that way before loading graph state).
  // What it does NOT report is anything about compute — so any paragraph that
  // mentions both compute and `atlas doctor` is reading a signal that isn't there.
  const hits = (await sources()).filter(([, text]) =>
    text.split(/\n\s*\n/).some((para) => /atlas doctor/i.test(para) && /\bcompute\b/i.test(para)),
  )
  expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
})

test("agent prompts point at compute_status for GPU funding", async () => {
  const text = await Bun.file(path.join(root, "agent", "prompt", "research.txt")).text()
  expect(text).toContain("compute_status")
})

test("prompts name skills that exist in the provider map", async () => {
  // `modal` is not a skill name — the real ones are modal-serverless-gpu,
  // modal-ml-training, modal-research-gpu. A prompt naming a skill the catalog
  // does not have sends the agent to load something that cannot resolve.
  const text = await Bun.file(path.join(root, "agent", "prompt", "research.txt")).text()
  expect(text).not.toMatch(/`modal`/)
})
```

Keep the existing `compute:up`, `compute_status`-in-`prompt.ts`, `computeBillingMode`, and config-description tests unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend/cli && bun test test/session/compute-prompt.test.ts`
Expected: FAIL on "no prompt uses atlas doctor as the compute availability signal" (naming `agent/prompt/research.txt`), on "agent prompts point at compute_status", and on "prompts name skills that exist in the provider map".

- [ ] **Step 3: Rewrite the COMPUTE stage guidance**

In `backend/cli/src/agent/prompt/research.txt`, replace lines 254-257 (the four-line `Managed compute (Daytona-backed) …` bullet) with:

```
- Call the `compute_status` tool before launching any GPU work. It reports how compute is
  funded right now — `byok`, `managed`, or `none` — which providers are usable, and the rule
  that applies. Do not infer this from `atlas doctor`; it reports nothing about compute.
- If it returns `byok`, load the cloud-compute skill for one of the providers it lists.
  If `managed`, run the work through managed compute. If `none`, do not launch GPU work —
  tell the user to connect a provider key in Settings ▸ Compute.
```

Then correct the stale skill name on the following line — `modal` is not a skill; the catalog has `modal-serverless-gpu`:

```
- Load: `modal-serverless-gpu` for general serverless GPU (inference, serving)
```

Leave lines 81-84 untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend/cli && bun test test/session/compute-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove each new assertion against deletion**

1. Re-add the phrase `Run \`atlas doctor --format=json\` first`into the COMPUTE bullet → "no prompt uses atlas doctor as the compute availability signal" must fail, naming`agent/prompt/research.txt`.
2. Confirm the _inverse_: the untouched graph-state use at lines 81-84 must **not** trip that test. Verify the paragraph containing it has no `compute` mention, so the test permits a legitimate `atlas doctor` call. If it does trip, the test is too broad — fix it.
3. Remove `compute_status` from `research.txt` → "agent prompts point at compute_status" must fail.
4. Restore `` `modal` `` in the load line → "prompts name skills that exist in the provider map" must fail.
5. Point `sources()` at a non-existent directory → "the file set is non-empty" must fail. This guards the whole absence-test family against passing on an empty glob.

- [ ] **Step 6: Full suite, format, commit**

```bash
cd backend/cli && bun test && bun run typecheck
bunx prettier --write test/session/compute-prompt.test.ts
git add src/agent/prompt/research.txt test/session/compute-prompt.test.ts
git commit -m "fix(prompt): research agent checks compute_status, not atlas doctor"
```

Note: `research.txt` is a `.txt` prompt file — do not run prettier on it.

---

### Tasks 6 and 7: RunPod and Vast.ai skills — DELETED

Superseded by Decision 2. The user ruled that a provider skill is overkill —
a capable agent drives a documented cloud API from a bare key. With the skill
conjunction gone from the resolver, a RunPod or Vast credential already makes
a user BYOK-usable, so there is nothing left for these tasks to fix.

`PROVIDERS.runpod.skills` and `PROVIDERS.vast.skills` are `[]`, which is the
honest statement of the situation: those providers have credentials and no
catalogued skill, and that is fine.

---

## Final verification

Run before declaring the branch complete. Evidence before assertions — paste the actual output, do not summarise it.

- [ ] `cd backend/cli && bun test` — full suite green, no network.
- [ ] `cd backend/cli && bun run typecheck` — clean. If it fails only inside the untracked `test/provider/synthetic-model.test.ts`, that is the user's WIP and is expected; note it rather than fixing it.
- [ ] `bunx prettier --check .` from the repo root — CI's Format job runs over the whole repo.
- [ ] Walk the spec's 14 acceptance criteria and name the test that proves each.

**Pushing is blocked twice.** The husky pre-push hook pins a bun version from `package.json` `packageManager` and runs `bun typecheck`, which fails on the untracked `synthetic-model.test.ts`. The prior session's workaround was `git stash push -u` on that one path, push, then `git stash pop`. **Restore it immediately; do not leave it stashed, and do not use `--no-verify`** — the user declined that explicitly.

## Acceptance criteria → task map

| #   | Criterion                                                                                                                       | Proven by                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Runtime resolver, single shared implementation                                                                                  | Task 1 + Task 2; Task 4 "SkillTool.init and compute_status never disagree"                                                        |
| 2   | **REVISED by Decision 2** — a credential alone makes a provider usable; a half-configured Modal credential still does not count | Task 1b: "a key with NO catalogued skill IS usable", "a catalogued skill with NO key", the Modal-pair test, the empty-string test |
| 3   | Catalog lists usable providers only; none in managed/none; non-compute unaffected                                               | Task 4 tests 1–6                                                                                                                  |
| 4   | Markdown never auto-injected                                                                                                    | Task 4 — the filter touches the listing only; no auto-load path is added anywhere                                                 |
| 5   | No keys + managed unavailable (incl. a failed check) → `none`                                                                   | Task 2 tests 3, 4, 5, 6                                                                                                           |
| 6   | Override can narrow to `none`, never manufacture                                                                                | Task 2 override tests 2 and 3                                                                                                     |
| 7   | A key injected by either settings panel at boot is detected                                                                     | Task 1 test 10 + Task 2's on-demand resolution (never at startup)                                                                 |
| 8   | Availability call skipped when a usable provider is present                                                                     | Task 2 test 1 (positive assertion on the recorded call list)                                                                      |
| 9   | `compute_status` returns mode, providers, guidance, resolved per call                                                           | Task 3 tests 1–5                                                                                                                  |
| 10  | Mid-session credential reflected without restart                                                                                | Task 3 test 6; Task 4 test 7                                                                                                      |
| 11  | Nothing mode-carrying injected per turn; description carries the instruction                                                    | Task 5 test 3; Task 3 test 7                                                                                                      |
| 12  | No prompt references `atlas compute:up` or `atlas doctor`                                                                       | Task 5 tests 1, 2                                                                                                                 |
| 13  | `none` says don't attempt GPU work and how to enable it                                                                         | Task 3 tests 3, 4                                                                                                                 |
| 14  | `bun test` passes with no network                                                                                               | Final verification                                                                                                                |
