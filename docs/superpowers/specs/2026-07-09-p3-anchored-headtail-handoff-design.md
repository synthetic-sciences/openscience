# P3.1 + P3.2 — Anchored Summary & Head/Tail Protection (Design)

- **Status:** Draft (approved for implementation)
- **Created:** 2026-07-09
- **Owner:** KB
- **Related:** [[2026-07-08-context-management-architecture-design]] (the roadmap; this is the detailed design for its **P3.1** and **P3.2**). Touches `backend/cli/src/session/{compaction,message-v2}.ts`.
- **Prior art (re-read 2026-07-09):** `~/codes/opencode`, `~/codes/claude-code` (leaked TS source), `~/.hermes/hermes-agent`.

---

## 1. Problem & scope

Today `SessionCompaction.process()` **regenerates** the whole handoff from scratch via one LLM call over the *entire* history every time it fires, and **keeps nothing verbatim** — post-compaction the summary replaces everything. Two consequences:

1. **Drift / re-derivation.** Each compaction re-summarizes from zero, so the handoff can drift (the anchor fixes in `f6b74ff` mitigate but don't remove this), and repeated compactions in a long session re-pay full cost each time.
2. **Re-catch-up + task-disappearance.** Because recent turns are summarized away, the agent loses recent working context (re-reads to rebuild it) and — critically — the *current user request* can be summarized away, which is the structural root of the task-drift we kept hitting (hermes documents this as bug #10896: *"the task effectively disappears from the active context"*).

**This spec covers P3.1 + P3.2 only.** P3.3 (background maintenance) and P3.4 (no-LLM-when-fresh) are **deferred** to their own spec — they carry the real dev/test cost (background cadence, freshness gating, aux-model plumbing). Deferring P3.4 removes the need for any `coveredThrough`/freshness machinery here.

Both features are near-direct ports from **opencode**, whose `compaction.ts`/`filterCompacted` is the same lineage as ours (identical `PRUNE_PROTECT=40k`/`PRUNE_MINIMUM=20k`), plus one mechanism from **hermes**. Low risk.

---

## 2. Prior art (distilled, with citations)

**Anchored/incremental summary — all three do it.**
- opencode: `buildPrompt` injects a `<previous-summary>` block: *"Update the anchored summary below … preserve still-true details, remove stale details, merge in new facts"* (`core/src/session/compaction.ts:161-168`); prior summary found via `completedCompactions()` (`opencode/src/session/compaction.ts:334-348`).
- claude-code: Session Memory injects `<current_notes_content>` and updates in place (`SessionMemory/prompts.ts:43-81`).
- hermes: `PREVIOUS SUMMARY:` block with *"Update … PRESERVE … ADD new completed to the numbered list … Move In-Progress→Completed"* (`context_compressor.py:1343-1357`), persisted (`:1404`), rehydrated on resume (`:1902-1911`).

**Head+tail protection — all three do it.**
- opencode: `select()` keeps last `tail_turns` (default 2) turns within `preserve_recent_tokens` (~25% usable, clamped 2–8k); head → summarizer, tail preserved verbatim via `tail_start_id`; `filterCompacted()` re-splices `[compaction-user, summary, …tail…, continuation]` (`opencode/src/session/compaction.ts:188-239`, `message-v2.ts:521-572`).
- claude-code: tail expands backward to ≥10k tokens **and** ≥5 text messages, cap 40k; `adjustIndexToPreserveAPIInvariants` never splits a tool_use/tool_result pair (`sessionMemoryCompact.ts:232-397`).
- hermes: **`_ensure_last_user_message_in_tail`** force-anchors the most recent user message into the protected tail (`context_compressor.py:1698-1743`) — the direct cure for task-disappearance.

**Not in scope here:** claude-code's `trySessionMemoryCompaction` (zero-API compaction) and its background Session-Memory pass → that's P3.4/P3.3, deferred.

---

## 3. Design

### 3.1 Anchored/incremental summary (P3.1)

In `SessionCompaction.process()`:

1. **Find the prior summary.** Scan `input.messages` backwards for the most recent assistant message with `summary === true`; take its text (its persisted handoff). Add a small helper `previousSummary(messages)` (mirrors opencode `completedCompactions().at(-1)`).
2. **Branch the prompt.** The existing `defaultPrompt` becomes the *create* branch. Add an *update* branch used when a prior summary exists: it embeds the prior handoff in a `<previous-summary>` block and instructs an in-place update of the same section structure (Objective / Constraints & Decisions / Work State / Next Move / Key Files), carrying the existing anchor rules:
   > Update the handoff below to reflect the new turns since it was written. PRESERVE still-true items verbatim; move `In progress` items to `Done (verified)` once completed; move resolved blockers out of `Blocked / open`; drop stale detail; append genuinely new facts. Keep **Objective** bound to the user's EXPLICIT request — do not broaden it. Re-emit the exact same section structure.
   > `<previous-summary>` … prior handoff … `</previous-summary>`
3. Everything else (writing `.openscience/handoffs/<id>.md`, auto-resume, `requestAnswered`-style yield behavior already shipped) is unchanged.

Plugin override (`experimental.session.compacting` → `compacting.prompt`) still wins, as today.

### 3.2 Head/tail protection (P3.2)

New split step in `compaction.ts`, ported from opencode `select()`:

- **`selectTail(messages, model, cfg)` → `{ tailStartId?: string }`.** Walk turns newest-first, accumulating tokens; keep whole turns whose cumulative size fits the tail budget, with a minimum turn count. Align the boundary so it never falls *inside* a tool_use/tool_result group (extend outward to include the whole group). Then **force the last user message into the tail**: if the computed `tailStartId` is newer than the last real user message, move it back to include that message (hermes `_ensure_last_user_message_in_tail`). If the tail would cover everything (nothing left to summarize) or there are no prior turns, return `tailStartId: undefined` → summarize all (current behavior).
- **Summarize only the head+middle.** The summary request is built from `messages` up to (not including) `tailStartId`, instead of all `input.messages`.
- **Persist `tailStartId`** as a new optional field on the **summary assistant message** (set in `process()` when that message is created — the tail is computed there, after the `CompactionPart` carrier already exists) so the re-splice knows where the verbatim tail begins.
- **`filterCompacted()` (message-v2.ts) re-splice.** Extend it to, after the compaction boundary + summary, append the verbatim messages from `tailStartId` onward (opencode `message-v2.ts:521-572`). Result order: `[compaction marker] [summary] [verbatim tail …] [continuation]`. When `tailStartId` is absent it degrades to today's behavior (summary replaces all).

Head verbatim (system prompt) is already separate from the summarized message stream, so no change needed there. Protecting the *first user message* verbatim (hermes-style) is a possible small extension but is **out of scope** for this slice — the anchored `Objective` (P3.1) covers it.

### 3.3 Constants / config

Add under the existing `compaction` config block (all overridable):
- `tailTurns` — minimum recent turns kept verbatim. Default **2** (opencode).
- `tailTokens` — tail token budget. Default **`clamp(0.20 · usable, 8_000, 32_000)`** (blends opencode 2–8k / claude-code 10–40k / hermes ~20%; scaled up for our 0.75 threshold + larger windows).

`usable` is the same value `isOverflow` already computes.

---

## 4. Files

- `backend/cli/src/session/compaction.ts` — `previousSummary()` + prompt branch (P3.1); `selectTail()` + summarize-head-only + persist `tailStartId` (P3.2); config constants.
- `backend/cli/src/session/message-v2.ts` — extend `filterCompacted()` to re-splice the verbatim tail; add the optional `tailStartId` field to the summary (assistant) message schema.
- `backend/cli/src/config/config.ts` — `compaction.tailTurns`, `compaction.tailTokens`.

---

## 5. Testing

Pure/unit-testable pieces (no live model):
- **`selectTail()`** (`test/session/`): tail budget respected; ≥`tailTurns` kept; never splits a tool_use/result group; **last user message always in the tail** even when it would fall in the middle; returns `undefined` when nothing to summarize; degrades safely with 0–1 prior turns.
- **`previousSummary()`**: returns the newest `summary:true` message text; `undefined` when none.
- **`filterCompacted()` re-splice**: with a `tailStartId`, output is `[marker, summary, …tail verbatim…, continuation]`; without it, unchanged from today (regression-guarded by existing tests).
- **Prompt branch**: given a prior summary, the produced prompt contains `<previous-summary>` and the update instruction; without, the create prompt (assert on the string builder, no model call).

Live (real binary): a long-enough session that compacts twice — confirm (a) the second compaction *updates* the first handoff (Objective/Constraints stable, Done grows), (b) recent turns + the current request are present verbatim after compaction (no re-catch-up, no task-disappearance).

---

## 6. Acceptance criteria

- After compaction, the last user message and the recent tail (within budget) are present **verbatim**, not summarized.
- A session that compacts more than once produces a handoff that is **updated**, not regenerated (prior Objective/Constraints preserved; Done accumulates).
- No `filterCompacted` regression when `tailStartId` is absent.
- `bun test test/session/` green; typecheck clean.

---

## 7. Risks & mitigations

- **Tail budget too large → compaction reclaims too little** (keeps so much verbatim it doesn't get under threshold). Mitigate: budget is a fraction of `usable` and clamped; the reactive overflow-error backstop + circuit breaker (P2.5) still catch the degenerate case.
- **Boundary splits a tool_use/tool_result pair → provider 400.** Mitigate: `selectTail` aligns outward to whole tool groups (claude-code `adjustIndexToPreserveAPIInvariants`); covered by a unit test.
- **`filterCompacted` re-splice ordering bug → dangling tool_result or duplicated turns.** Mitigate: port opencode's proven ordering; unit-test the spliced sequence; the `tailStartId`-absent path is unchanged (safe default).
- **Anchored update drifts across many compactions** (stale items linger). Mitigate: the update prompt explicitly instructs removing stale detail and moving Done items; the Objective stays anchored to the explicit request.

---

## 8. Deferred (own spec)

- **P3.3** background maintenance — inline async aux-model pass keeping `handoff.md` current on a token/tool-call cadence.
- **P3.4** no-LLM-when-fresh — `trySessionMemoryCompaction`-style reuse of a current handoff with zero API call, gated on a `coveredThrough` freshness marker; `session.compaction` telemetry gains a `"reuse"` mechanism.
