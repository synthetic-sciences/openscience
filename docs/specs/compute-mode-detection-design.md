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
detecting too early reports `none` for a user who has keys configured through the UI. Detection should be lazy
(resolved on first use, cached) rather than computed during boot, so ordering cannot regress silently.

### Determining whether managed is available

One authenticated call to `GET /api/compute/options`, which already annotates each provider with `funding`
(`managed` when reselling is on and an operator key exists, else `unavailable`). If no provider reports
`managed`, managed is unavailable.

Cache the result for the process lifetime with a short TTL. Treat a failed or unauthenticated call as
**unavailable** — failing toward `none` produces an honest "connect a key" message, whereas failing toward
`managed` reproduces today's bug of promising a capability we haven't confirmed.

**This is only reached when no provider keys are present**, so a BYOK user never pays the network call.

### Prompt behaviour

Inject for `COMPUTE_AGENTS` on **every** turn, not only when the config is explicitly set — the agent needs to
know how compute is funded regardless of whether the user has expressed a preference.

- **byok** — run GPU work on the user's connected providers via the cloud-compute skills. Never launch managed
  leases.
- **managed** — run GPU work through managed compute, billed to Credits. Do not fall back to the user's own
  providers.
- **none** — no compute is available. Do not attempt GPU work. Tell the user to connect a provider key in
  Settings → Compute, or to top up for managed compute.

Remove the `atlas compute:up` instruction and the `atlas doctor` condition. Neither is currently true, and
mode resolution now answers the question the `doctor` check was trying to answer.

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
- The prompt text differs across all three modes and mentions neither `compute:up` nor `atlas doctor`.

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
7. `COMPUTE_AGENTS` receive mode guidance on every turn, including when `billing.compute` is unset.
8. No prompt references `atlas compute:up` or `atlas doctor` for compute availability.
9. In `none`, the agent is instructed not to attempt GPU work and to tell the user how to enable it.
10. `bun test` passes with no network access.

## Open questions for review

1. **Should a BYOK user with keys for one provider but asking about another get `byok` or a
   partial answer?** This design says `byok` if any provider is configured, and leaves provider choice to the
   agent and the skills. A per-provider resolution would be more precise and more complex.
2. **Should `none` be a hard block or a warning?** Currently the agent is told not to attempt GPU work, but
   nothing enforces it — it still has `bash`. Enforcement would mean gating the cloud-compute skills, which is
   a larger change.
3. **TTL on the availability cache.** Process lifetime is simplest. A user who tops up or connects an operator
   key mid-session would need a restart to see `managed` appear.
4. **Does the `billing.compute` description need updating** in the config schema? It currently says
   _"Unset = byok"_, which this change makes false.

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
