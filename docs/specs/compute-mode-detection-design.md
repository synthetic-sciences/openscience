# Compute mode detection — design

Status: proposed, for review
Date: 2026-07-30
Scope: `openscience` only. **No Atlas changes required.**
Roadmap: contributes to **5** (fix existing compute gaps); unblocks honest messaging for **55**/**103**

## Summary

OpenScience decides how GPU work gets paid for using a config value that never checks whether the user
actually has any provider keys. This replaces that with **runtime detection**: if provider credentials are
present, we're in BYOK mode; if not, managed; and if neither is usable, we say so instead of guessing.

The change is small and self-contained. Its value is that it makes one currently-unrepresentable state —
_"there is no compute available"_ — expressible, which is the state we handle worst today.

## Problem

### 1. The mode is a config value that can contradict reality

```ts
// src/session/billing-gate.ts:34
export async function computeBillingMode(): Promise<BillingMode> {
  return (await Config.get()).billing?.compute ?? "byok"
}
```

It never inspects the environment. A brand-new user with zero provider keys resolves to `"byok"` — claiming
BYOK with nothing to BYOK with.

Note the asymmetry with LLM billing, which already does this correctly. From the config schema
(`src/config/config.ts`):

- `billing.llm` — _"Unset or null = **auto-detect** from the resolved credential."_ Backed by
  `resolveCredentialSource(providerID, modelID)`, which inspects the actual credential and returns
  `byok | managed | oauth-free`.
- `billing.compute` — _"**Unset = byok**."_ A static default. No detection function exists.

**This design makes compute behave the way LLM already does.**

### 2. The "no compute available" state cannot be expressed

`BillingMode` is `"managed" | "byok"`. There is no third value, so the case _"the user has no keys **and**
managed compute isn't available"_ has nowhere to live. Today it silently resolves to one of the two working
modes and the agent is told to use a path that cannot work.

### 3. The prompt is only injected when the mode is explicitly set — and is wrong when it is

```ts
// src/session/prompt.ts:1553
if (COMPUTE_AGENTS.has(input.agent.name) && (await Config.get()).billing?.compute) {
```

`COMPUTE_AGENTS` is `research`, `biology`, `physics`, `ml`. Two distinct problems:

**When `billing.compute` is unset (the default), no guidance is injected at all.** The agent receives no
information about how compute is funded and picks an approach from the skill catalog with no idea whether the
user's keys exist.

**When it is set to `managed`, the injected text is inaccurate:**

> _"Run GPU/training work through the bundled `atlas compute` CLI (e.g. `atlas compute:up`), which bills
> Credits. Do not fall back to the user's own GPU providers unless `atlas doctor` reports managed compute
> unavailable."_

Three things in that sentence do not hold:

- **`atlas compute:up` is not in the published CLI.** `@synsci/atlas@0.13.2` on npm contains no `compute:`
  command. The Atlas repo's `cli/` does (`commands.mjs:922`), at the _same version number_ — so the source
  and the published artifact disagree and the pin `^0.13.2` resolves to the one without it.
- **`atlas doctor` reports nothing about compute.** Verified against a live run: the keys are
  `config_path`, `profile`, `base_url`, `auth`, `backend`, `package.skills`, `integrations`, `spool`,
  `warnings`, `ok`. There is no compute field, so the stated condition is unobservable.
- **Managed compute is off by default server-side.** Atlas gates it on `COMPUTE_RESELL_ENABLED`, which
  defaults to `false` (`backend/app/config.py:383`), plus a configured operator key. Without both, every
  provider reports `funding: "unavailable"`.

So an agent in managed mode runs an unknown command, cannot check the sanctioned availability signal, and is
pointed at _"the user's own GPU providers"_ as the remedy — which in managed mode is precisely the set of keys
that doesn't exist. Where keys _do_ exist, that fallback spends on the user's own uncapped provider account.

## Design

### Three states, detected at runtime

```ts
export type ComputeSource = "byok" | "managed" | "none"
```

| Provider keys present? | Managed available? | Resolved  | Agent is told                                                    |
| ---------------------- | ------------------ | --------- | ---------------------------------------------------------------- |
| yes                    | —                  | `byok`    | use the user's connected providers via the cloud-compute skills  |
| no                     | yes                | `managed` | use managed compute, billed to the wallet                        |
| no                     | no                 | `none`    | **no compute is available — connect a provider key in Settings** |

BYOK wins when keys are present. It is free to the user, it works today, and it needs nothing from Atlas.

### `billing.compute` becomes an override, not the source of truth

Detection supplies the default; the existing setting still lets a user force a mode. This keeps the config
meaningful without letting it assert something false.

- unset → use detection
- `"byok"` → force BYOK. If no keys are present, resolve to `none` rather than pretending.
- `"managed"` → force managed. If managed is unavailable, resolve to `none`.

An override may narrow the outcome to `none`; it may never manufacture a capability that isn't there.

### What counts as a provider key

From `PROVIDER_ENV` in `src/server/routes/settings/compute.ts:170` plus Modal's pair:

| Provider        | Env vars                                                      |
| --------------- | ------------------------------------------------------------- |
| Modal           | `MODAL_TOKEN_ID` **and** `MODAL_TOKEN_SECRET` (both required) |
| Lambda          | `LAMBDA_API_KEY` or `LAMBDA_LABS_API_KEY`                     |
| RunPod          | `RUNPOD_API_KEY`                                              |
| Vast            | `VAST_API_KEY`                                                |
| Prime Intellect | `PRIME_API_KEY` or `PRIME_INTELLECT_API_KEY`                  |
| TensorPool      | `TENSORPOOL_KEY` or `TENSORPOOL_API_KEY`                      |

Any one provider fully configured is sufficient for `byok`. Modal is the only pair — a half-pasted Modal
credential maps to nothing and must not count, which mirrors the existing behaviour at `compute.ts:185`.

### Ordering requirement — the main footgun

Keys reach `process.env` from three places, all legitimate BYOK:

1. The user's shell or `.env`
2. The **Credentials** settings panel — injected by `applyCredentialEnv()` at `src/index.ts:102`
3. The **Compute** settings panel — injected by `ComputeSettings.applyComputeEnv()` at `src/index.ts:106`

**Detection must run after line 106.** Both injections are wrapped in `.catch(() => {})` and fail silently, so
detecting too early reports `none` for a user who has keys configured through the UI.

The robust way to guarantee that is not to order boot steps carefully — it is to **resolve on demand, when the
tool is called, and never at startup.** By then every injection has run, so the ordering constraint cannot be
violated and cannot silently regress if someone reorders `src/index.ts` later. This is the same property that
makes a tool the right shape in the first place.

### Determining whether managed is available

One authenticated call to `GET /api/compute/options`, which already annotates each provider with `funding`
(`managed` when reselling is on and an operator key exists, else `unavailable`). If no provider reports
`managed`, managed is unavailable.

Treat a failed, unauthenticated, or timed-out call as **unavailable** — failing toward `none` produces an honest
"connect a key" message, whereas failing toward `managed` reproduces today's bug of promising a capability we
haven't confirmed.

**This is only reached when no provider keys are present**, so a BYOK user never pays the network call.

**Caching:** a short in-process TTL (single-digit seconds) is fine to stop a chatty agent hammering the endpoint
within one turn, but it must not be a startup-time or process-lifetime cache. The whole reason this is a tool
rather than a prompt injection is that the answer changes mid-session — a long cache reintroduces exactly the
staleness the tool exists to avoid. Key detection itself reads `process.env` and needs no cache at all.

### How the agent learns the mode: a tool, not a prompt injection

**The agent pulls the mode from a tool. Nothing is injected per turn.**

An earlier draft injected mode guidance into every turn for `COMPUTE_AGENTS`. That was wrong for a reason that
matters more than token cost: **the mode can change mid-session.** A user connects a Modal key in
Settings → Compute while a session is running, and a reminder injected at turn 3 is false by turn 12. A tool
returns the state at the moment it is asked.

It also composes with action. The agent needs the mode only because it is about to run GPU work, so a call at
that moment can return the mode _and_ the specifics worth having — which providers are configured, whether
managed is available, and the balance and rates when it is. Injected prose is information divorced from the
decision, and it does not scale: adding rates or balance to an every-turn injection is expensive, while adding
them to a tool result is free.

This also matches the pattern this codebase already treats as correct. `tool/science.ts` exposes three tools
over 42 connectors rather than 42 tool definitions — capability discovered on demand, tool count flat.

#### `compute_status`

No parameters. Returns the resolved mode plus what the agent needs to act on it:

```ts
{
  mode: "byok" | "managed" | "none",
  providers: string[],        // configured BYOK providers, e.g. ["modal", "runpod"]
  managed_available: boolean,
  guidance: string,           // the mode-specific rule, see below
  balance_usd?: number        // managed only
}
```

`guidance` carries the behavioural rule, delivered at the point of relevance:

| mode      | guidance                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `byok`    | Run GPU work on the user's connected providers via the cloud-compute skills. Do not launch managed leases.                                         |
| `managed` | Run GPU work through managed compute, billed to Credits. Do not use the user's own provider keys — they are not funded here.                       |
| `none`    | No compute is available. Do not attempt GPU work. Tell the user to connect a provider key in Settings → Compute, or to top up for managed compute. |

#### The tool description is the prompt

Constraints have to reach the agent _before_ it starts down a path, which is the one thing an injection did
well. The tool **description** does that job at no extra per-turn cost, because tool definitions are in every
request regardless: _"Check how GPU compute is funded before running any GPU work. Returns byok, managed, or
none, with the providers available and the rule that applies."_

So the description constrains and the result informs. Nothing needs injecting.

#### Prompt changes

Delete the `atlas compute:up` instruction and the `atlas doctor` condition from `prompt.ts:1554-1562`. Both are
false today, independent of this design, and mode resolution now answers the question the `doctor` check was
reaching for.

Whether to keep a minimal pointer in the prompt is left open — see the open questions. The default position is
no injection at all.

#### Relationship to roadmap 51/2

This is the read half of the agent-facing compute tool. `compute_status` now; a `compute_submit` alongside it
when managed compute is actually switched on and the budget cap from
`docs/specs/compute-guardrails-design.md` is sound. Same seam, so the later work adds a tool rather than
reshaping this one.

## Testing

House pattern: no mocks, exercise the real resolver, no network in tests.

- Each provider in isolation resolves to `byok`.
- **Modal with only `MODAL_TOKEN_ID` and no other provider** does not resolve to `byok` — it falls through to
  the managed/none branch exactly as if no key were set.
- No keys plus managed available → `managed`.
- No keys plus managed unavailable → `none`.
- No keys plus a failed availability call → `none`.
- Override `"byok"` with no keys → `none`.
- Override `"managed"` with managed unavailable → `none`.
- Keys present → the availability call is **not** made.
- Detection reflects a key injected by `applyComputeEnv()` after startup (the ordering guarantee).
- **A key connected mid-session changes the answer on the next call** — the staleness property that motivated a
  tool over an injection. Resolve, inject a key, resolve again, assert the mode changed.

For the tool, following the house pattern of stubbing `globalThis.fetch` and exercising the real tool:

- `compute_status` returns each of the three modes with matching `guidance` text.
- `byok` lists the configured providers in `providers`.
- `managed` includes `balance_usd`; `byok` and `none` do not.
- No prompt in `session/prompt/*.txt` or `prompt.ts` references `compute:up` or `atlas doctor` for compute
  availability.

Every new assertion must be demonstrated failing against the specific mutation it guards — ideally the
_deletion_ of the logic, not merely its inversion. On the preceding `science_fetch` branch seven assertion
defects were found and all seven were in plan-authored test code; the ones that held up were the ones proven
against deletion.

## Out of scope

- **The managed-compute budget cap** (roadmap 55/103). Parked in
  `docs/specs/compute-guardrails-design.md`, which an Opus review found unsound; it also cannot be validated
  until managed compute is actually switched on somewhere.
- **Turning managed compute on** — an Atlas deployment decision (`COMPUTE_RESELL_ENABLED` plus operator keys).
- **Publishing `compute:up`**, and the source/npm version divergence at `0.13.2`. Worth an independent fix:
  a consumer pinning `^0.13.2` cannot tell which artifact they'll get.
- **Roadmap 61** (per-job secrets, never into logs) — the local runner `compute/jobs.ts`, unrelated to billing.
- Any change to how `billing.llm` resolves.

## Acceptance criteria

1. A resolver returns `byok | managed | none` from the runtime environment, not from a static default.
2. Any single fully-configured provider yields `byok`; a half-configured Modal credential does not.
3. With no keys and managed unavailable — including when the availability check fails — the result is `none`.
4. `billing.compute` can narrow the result to `none` but can never assert an unavailable capability.
5. A key injected by either settings panel at boot is detected (resolution happens after `src/index.ts:106`).
6. The availability call is skipped entirely when provider keys are present.
7. A `compute_status` tool returns the mode, the configured providers, and mode-specific `guidance`, resolving
   on each call rather than from a value cached at startup.
8. A credential connected mid-session is reflected on the next `compute_status` call without a restart.
9. Nothing is injected into the prompt per turn for compute mode; the tool's description carries the
   "check before running GPU work" instruction.
10. No prompt references `atlas compute:up` or `atlas doctor` for compute availability.
11. In `none`, the tool's `guidance` tells the agent not to attempt GPU work and how the user can enable it.
12. `bun test` passes with no network access.

## Open questions for review

1. **Should a BYOK user with keys for one provider but asking about another get `byok` or a
   partial answer?** This design says `byok` if any provider is configured, and leaves provider choice to the
   agent and the skills. A per-provider resolution would be more precise and more complex.
2. **Should `none` be a hard block or a warning?** The tool's `guidance` tells the agent not to attempt GPU
   work, but nothing enforces it — it still has `bash` and the cloud-compute skills. Enforcement would mean
   gating those skills, which is a larger change. Worth deciding explicitly rather than by omission.
3. **Should the prompt keep a one-line pointer to the tool?** The default position here is no injection at all,
   on the grounds that the tool description already carries the instruction. The risk is an agent that never
   calls the tool and reaches for `bash` directly. A single line — _"call `compute_status` before GPU work"_ —
   would cost a handful of tokens per turn and close that gap. This is the one place where the tool-versus-prompt
   trade-off is genuinely unresolved.
4. **Does the `billing.compute` description need updating** in the config schema? It currently says
   _"Unset = byok"_, which this change makes false.
5. **How long may `compute_status` block?** In `none`/`managed` it makes one authenticated call to
   `/api/compute/options`. A slow or hanging Atlas would stall the agent mid-turn, so it needs a short timeout
   with `none` as the timeout result — but "short" should be a stated number, not left to the implementer.

## Appendix: what was verified, and how

Every claim above was checked against code or a live run rather than inferred. Recorded because three earlier
conclusions in this investigation were wrong, and the corrections are the reason this design exists.

| Claim                                                  | Verified by                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `computeBillingMode()` reads config only               | `src/session/billing-gate.ts:34`                                                                  |
| Prompt injects only when explicitly set                | `src/session/prompt.ts:1553`                                                                      |
| `COMPUTE_AGENTS` = research, biology, physics, ml      | `src/session/prompt.ts:75`                                                                        |
| Env injection order and silent failure                 | `src/index.ts:102,106`                                                                            |
| Provider env var names                                 | `src/server/routes/settings/compute.ts:170-176,185`                                               |
| `compute:up` absent from published npm 0.13.2          | `npm pack @synsci/atlas`, grep of the tarball                                                     |
| `compute:up` present in Atlas repo at the same version | `atlas` `origin/main:cli/src/atlas-runtime/commands.mjs:922`; `cli/package.json` version `0.13.2` |
| `atlas doctor` reports no compute field                | live `atlas doctor` output                                                                        |
| Managed compute off by default                         | `atlas` `origin/main:backend/app/config.py:383`                                                   |
| `funding` derivation                                   | `atlas` `origin/main:backend/app/routes/compute.py:117-122`                                       |
| LLM billing already auto-detects                       | `src/config/config.ts` `billing.llm`; `billing-gate.ts:63`                                        |
