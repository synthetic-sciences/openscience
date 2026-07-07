# Auto-Compaction at 75% of the Model Context Window — Design

**Date:** 2026-07-07
**Status:** Draft → ready for plan
**Author:** KB (with Claude)
**Supersedes attempt:** `fix/codex-context-overflow-retry-loop` (over-scoped, buggy; this is a fresh, focused implementation — best ideas re-implemented, not copied)

## Problem

A user hit a permanent **"Provider server error"** loop. The log
(`~/Downloads/2026-07-06T143620.log`) shows the real cause: Codex `gpt-5.5`
rejecting the request with

```
invalid_request_error / code=context_length_exceeded
"Your input exceeds the context window of this model."
```

repeating every ~10–30s indefinitely (lines 760, 803, 843, 886, 934, 990,
1060, …). The request is rejected **before** any response is produced.

openscience's overflow detection (`SessionCompaction.isOverflow`) only reads
token usage from a **completed** assistant turn. On a hard rejection there is
no completed turn, so:

- overflow is never detected,
- the loop retries the identical oversized input,
- it fails identically, forever.

This bug is **inherited from opencode**, which is likewise purely reactive and
has no handling for a context-window rejection error (confirmed against
opencode `dev`).

### Three concrete defects on `main`

1. **`backend/cli/src/session/compaction.ts:38`** — `return count > usable`.
   Fires at **100%** of the usable budget, and only *reactively* (needs a prior
   completed turn's real token count). No headroom for the next turn's growth.
2. **No detection of the provider context-overflow error.** A deterministic
   "input too big" rejection is treated like any transient error and retried →
   infinite loop.
3. **`compaction.ts:33`** — `if (context === 0) return false`. Locally-added,
   OpenAI-compatible, and Codex models frequently report `limit.context = 0`
   (see `provider.ts:1020`, which defaults unknown context to `0`). The overflow
   check is then silently disabled — the user's *"we don't have an actual
   context window limit enforced by each provider."*

## Goal

Auto-compaction that fires **proactively at 75%** of a model's usable context,
that **recovers from context-overflow rejections instead of looping**, and a
**user-facing `/compact`** command. Keep the change small and correct; keep the
existing summarize-everything compaction body unchanged.

## Non-goals (explicitly out of scope)

Lifted-and-dropped from the failed branch to avoid its bug surface:

- Head/tail-verbatim context rebuild (`[head, summary, tail]`).
- Iterative summary-of-summary evolution.
- Persisting handoff documents to disk.
- The three-flag back-off state machine + `backoffNotice` assistant message.
- Any UI/workspace changes.

## Approach

**Reactive-early + hard-error backstop + limit-0 fallback.** (Chosen over a
pre-send `Token.estimate()` because the hard-error backstop already covers the
only case an estimate would add — a single oversized first message — without an
inaccurate guess.)

Three cooperating layers:

- **Layer A — proactive threshold.** Lower the reactive check from 100% → 75%
  of usable context, using the *real* provider token count from the last
  completed turn. Firing with ~25% headroom means the next turn (plus its
  output) will not blow the hard limit before compaction runs.
- **Layer B — hard-error backstop.** When a request is nonetheless rejected
  with a context-overflow error (huge first message, or a model whose limit we
  couldn't know), classify it deterministically, compact, and **resume the same
  turn once**. If it overflows *again*, or the summarization itself overflows,
  fail with an actionable terminal error — never loop.
- **Layer C — limit-0 fallback.** When `model.limit.context === 0`, assume a
  **128 000**-token window (matching the existing fallback at `provider.ts:770`)
  so Layers A/B function for local / OpenAI-compatible / Codex models.

## Components

### 1. `backend/cli/src/session/retry.ts` — `isContextOverflow(error)`

New exported classifier (with a small private `normalize()` helper) added to the
existing `SessionRetry` namespace (which already holds `retryable`, `delay`,
`sleep`).

- `normalize(error)` → `{ statusCode, code, message }`, flattening the differing
  provider JSON shapes (in-stream error chunk vs. HTTP `responseBody`).
- `isContextOverflow(error): boolean`
  - `false` if `statusCode >= 500` (genuine server fault stays retryable).
  - `true` if `code ∈ { "context_length_exceeded", "string_above_max_length" }`.
  - else `true` if the human message matches a context-window pattern
    (`"context length"`, `"context window"`, `"maximum context"`,
    `"exceeds the context"`, `"prompt is too long"`, `"input is too long"`,
    `"too many tokens"`, `"maximum number of tokens"`, `"reduce the length"`,
    `"reduce your prompt"`, …). This is the cross-provider fallback: Anthropic
    returns no dedicated code, Gemini uses the generic `INVALID_ARGUMENT`, but
    the message always describes the condition.
  - Deliberately **excludes** generic buckets like bare `invalid_request_error`
    (also covers unrelated bad-param errors).

### 2. `backend/cli/src/session/compaction.ts`

- `export const DEFAULT_THRESHOLD = 0.75`
- `export const FALLBACK_CONTEXT = 128_000`
- `isOverflow`:
  - `const context = input.model.limit.context || FALLBACK_CONTEXT` (replaces the
    `if (context === 0) return false` early-out; `config.compaction.auto === false`
    still short-circuits to `false`).
  - `const threshold = config.compaction?.threshold ?? DEFAULT_THRESHOLD`
  - `return count > usable * threshold`
    (`count`, `output`, `usable` computed exactly as today).
- `process()`: when the summarization request itself is rejected for overflow
  (its processor returns `"overflow"`), return `"overflow"` so the caller fails
  the turn instead of re-summarizing something that can never fit.
- `process()` already accepts an optional `focus?: string` (threaded into the
  summarizer prompt for `/compact <topic>`); `create()` gains a matching
  optional `focus` and writes it onto the compaction part.

### 2a. `backend/cli/src/session/message-v2.ts`

`CompactionPart` (`:161`) currently carries only `type` + `auto`. Add an optional
`focus: z.string().optional()` so a `/compact <topic>` task can persist its focus
and `prompt.ts` can read `task.focus`. Backward-compatible (optional).

### 3. `backend/cli/src/session/processor.ts`

In the stream `catch` block (around `main:423`), **before** calling
`SessionRetry.retryable(error)`:

```
if (SessionRetry.isContextOverflow(error)) { overflow = true }
else { /* existing retryable() / error-publish path, unchanged */ }
```

Add a per-`process()` `overflow` flag (reset alongside `needsCompaction`), and
extend the return union with `"overflow"` (return it before `"stop"`/`"continue"`).
`SessionProcessor.process` return type becomes
`"continue" | "compact" | "stop" | "overflow"`.

### 4. `backend/cli/src/session/prompt.ts`

Session loop (`SessionPrompt.run`):

- **Overflow resume-once guard.** A `let overflowCompactions = 0` counter for the
  current unanswered turn.
  - `result === "overflow"` from normal processing → `overflowCompactions++`;
    if `> 1`, call `failTooLarge()` and `break`; else `SessionCompaction.create({ auto: true })`
    and `continue`.
  - Reset `overflowCompactions = 0` on any non-overflow result.
  - The pending-compaction branch: if `SessionCompaction.process` returns
    `"overflow"`, call `failTooLarge()` and `break`.
- **`failTooLarge()`** helper: publish `Session.Event.Error` with an actionable
  message (*"This message is too large for the model's context window, even after
  summarizing earlier history. Shorten it or start a new session."*) and write a
  terminal errored assistant message. This is the loop terminator.
- **Minimal anti-thrash latch (single flag).** `let compactionArmed = true`.
  When the 0.75 reactive path is over threshold: if `compactionArmed`, disarm and
  compact; else (already compacted, still over threshold — fixed overhead exceeds
  75%, so re-compacting is futile) **log and proceed silently** — the real model
  window + the Layer-B overflow path are the backstop. Re-arm
  (`compactionArmed = true`) when a completed turn drops back under threshold.
  *No user-facing back-off notice* (decision: silent).
- **`/compact` interception** at the **top** of `SessionPrompt.command` (before
  the template/placeholder machinery): when `input.command === Command.Default.COMPACT`,
  resolve model/agent, enqueue a compaction task
  (`SessionCompaction.create({ auto: false, focus })`), run the loop to process it —
  the same machinery as auto-compaction — and return the resulting summary message
  (consistent with `command()`'s existing return type). The `focus` is the raw
  text after the command (`input.arguments`), so `/compact rewrite the loss fn`
  focuses the handoff. No `CommandInput` schema change needed — focus rides in
  `arguments`.

### 5. `backend/cli/src/command/index.ts`

Register the action command:

```
COMPACT: "compact",           // added to Default
[Default.COMPACT]: {
  name: Default.COMPACT,
  description: "summarize the conversation so far to free up context",
  template: "",               // never used; command() intercepts it
  hints: [],
},
```

### 6. `backend/cli/src/config/config.ts`

Extend the existing `compaction` object (currently `auto`, `prune`):

```
threshold: z.number().min(0).max(1).optional()
  .describe("Compact when context exceeds this fraction of the model window (default: 0.75)"),
```

`FALLBACK_CONTEXT` stays a constant (decision: not configurable for now).

## Data flow

```
completed turn ──usage.tokens──▶ isOverflow(count > usable*0.75)?
                                     │ yes + armed
                                     ▼
                             SessionCompaction.create(auto) ──▶ summary ──▶ resume turn
request rejected ──▶ isContextOverflow(error)?
                        │ yes                      │ no
                        ▼                          ▼
              return "overflow"            existing retryable()/error path
                        │
        ┌───────────────┴────────────────┐
   1st overflow this turn          2nd overflow this turn
        │                                │
   compact + resume once          failTooLarge() → terminal error, break
```

## Error handling & loop-termination invariants

- A context-overflow error is **never retried** (deterministic — same input
  fails identically).
- Compaction is attempted **at most once per unanswered turn** in response to an
  overflow (`overflowCompactions` counter).
- If compaction cannot help (summarization overflows, or input still overflows
  after one compaction), the turn ends in a **terminal, user-actionable error** —
  no path loops.
- The 0.75 reactive path cannot thrash: the single `compactionArmed` latch blocks
  back-to-back compactions until context genuinely drops back under threshold.

## Testing (real implementations, no mocks — per AGENTS.md)

`backend/cli/test/session/retry.test.ts`
- `isContextOverflow` true for: OpenAI `code:"context_length_exceeded"`; a
  Gemini-style `INVALID_ARGUMENT` message containing "exceeds the context";
  an Anthropic-style "prompt is too long" message; `string_above_max_length`.
- `isContextOverflow` false for: a 5xx server error whose body happens to mention
  "context"; a plain rate-limit; a bad-parameter `invalid_request_error` with no
  overflow wording.

`backend/cli/test/session/compaction.test.ts`
- `isOverflow` true when `count > usable * 0.75`, false just below.
- `isOverflow` respects `config.compaction.threshold` override.
- `isOverflow` uses the 128k fallback when `model.limit.context === 0` (previously
  always `false`).
- `isOverflow` returns `false` when `config.compaction.auto === false`.

Loop guard (integration-level where feasible): a turn that overflows twice ends in
`failTooLarge()` rather than looping (assert a single terminal error message and no
further compaction tasks).

## Rollout / safety

- Default behaviour changes for **all** users: auto-compaction now fires at 75%
  and recovers from overflow. `config.compaction.auto = false` still fully
  disables it. `config.compaction.threshold` tunes the fraction.
- No schema migration; `threshold` is optional and backward-compatible.
