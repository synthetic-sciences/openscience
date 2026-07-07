# Auto-Compaction at 75% of the Model Context Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-compaction that fires proactively at 75% of a model's usable context, recovers from provider context-overflow rejections instead of looping forever, and exposes a user-facing `/compact` command.

**Architecture:** Three cooperating layers in the existing session loop — (A) lower the reactive overflow threshold from 100% → 75% on real last-turn token usage; (B) a deterministic context-overflow error classifier that makes the loop compact-and-resume once, then fail with an actionable error rather than retry; (C) a 128k fallback context window when a provider reports `limit.context = 0`. Plus a `/compact [topic]` command that enqueues a manual compaction task through the same machinery.

**Tech Stack:** Bun + TypeScript, Zod schemas, `bun:test`. Files live in `backend/cli/src/session/`.

## Global Constraints

Copied verbatim from `AGENTS.md` / spec — every task's requirements implicitly include these:

- No `any` type. Rely on type inference; avoid explicit annotations.
- Prefer `const` over `let`; avoid `else`; single-word variable names where natural.
- Use Bun APIs (`Bun.file()`, `Bun.write()`).
- No mocks in tests — test real implementations.
- `DEFAULT_THRESHOLD = 0.75`, `FALLBACK_CONTEXT = 128_000` (non-configurable constant).
- Back-off is **silent** (log only, no user notice message).
- Overflow-error classification must exclude generic buckets (bare `invalid_request_error`) and treat any `statusCode >= 500` as retryable, not overflow.
- All commands run from `backend/cli/`.

---

### Task 1: Context-overflow error classifier (`SessionRetry.isContextOverflow`)

Deterministically decide whether a provider error means "input exceeds the context window". This is the piece that stops the infinite retry loop: today `SessionRetry.retryable()` returns `"Provider Server Error"` for essentially any error carrying `json.error` (`retry.ts:96` — `!!json.error`), so a `context_length_exceeded` gets treated as retryable and loops.

**Files:**
- Modify: `backend/cli/src/session/retry.ts` (add exports inside `namespace SessionRetry`, before `retryable`)
- Test: `backend/cli/test/session/retry.test.ts` (create)

**Interfaces:**
- Consumes: `MessageV2.APIError` (`{ name:"APIError", data:{ message, statusCode?, isRetryable, responseHeaders?, responseBody? } }`), `NamedError.Unknown` (`{ name:"UnknownError", data:{ message } }`), `iife`.
- Produces: `SessionRetry.isContextOverflow(error: ReturnType<NamedError["toObject"]>): boolean`

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/session/retry.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { NamedError } from "@synsci/util/error"

const api = (data: Partial<MessageV2.APIError> & { message?: string }) =>
  new MessageV2.APIError({ message: "", isRetryable: true, ...data }).toObject()

const stream = (message: string) => new NamedError.Unknown({ message }).toObject()

describe("SessionRetry.isContextOverflow", () => {
  test("true for OpenAI/Codex context_length_exceeded code in responseBody", () => {
    const err = api({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." },
      }),
    })
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("true for string_above_max_length code", () => {
    const err = api({ statusCode: 400, responseBody: JSON.stringify({ error: { code: "string_above_max_length", message: "too long" } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("true for Anthropic-style 'prompt is too long' message (no code)", () => {
    const err = stream(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }))
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("true for Gemini-style INVALID_ARGUMENT message that mentions the context window", () => {
    const err = stream(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "The input token count exceeds the maximum number of tokens allowed." } }))
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("false for a 5xx server error even if its body mentions context", () => {
    const err = api({ statusCode: 503, responseBody: JSON.stringify({ error: { message: "context service temporarily unavailable" } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for a plain rate limit", () => {
    const err = api({ statusCode: 429, responseBody: JSON.stringify({ error: { type: "too_many_requests", message: "Rate limited" } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for an unrelated bad-parameter invalid_request_error", () => {
    const err = api({ statusCode: 400, responseBody: JSON.stringify({ error: { type: "invalid_request_error", message: "Unknown parameter: 'foo'." } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/retry.test.ts`
Expected: FAIL — `SessionRetry.isContextOverflow is not a function`.

- [ ] **Step 3: Implement the classifier**

In `backend/cli/src/session/retry.ts`, add the following inside `export namespace SessionRetry`, immediately **before** `export function retryable(`:

```ts
  // Codes that unambiguously mean "input too big". Deliberately small — never
  // generic buckets like `invalid_request_error`, which also cover bad params.
  const OVERFLOW_CODES = new Set(["context_length_exceeded", "string_above_max_length"])

  // Substrings from the human-readable message of a context-window rejection.
  // Cross-provider fallback: Anthropic has no dedicated code, Gemini uses the
  // generic INVALID_ARGUMENT — but the message always describes the condition.
  const OVERFLOW_PATTERNS = [
    "context length",
    "context window",
    "maximum context",
    "exceeds the context",
    "prompt is too long",
    "input is too long",
    "too long for",
    "input token count",
    "maximum number of tokens",
    "too many tokens",
    "reduce the length",
    "reduce your prompt",
  ]

  const asString = (value: unknown) => (typeof value === "string" ? value : "")

  // Flatten any provider error — HTTP responseBody or in-stream error chunk —
  // into one canonical { statusCode, code, message } so a single classifier
  // runs over every provider's differing JSON shape.
  function normalizeOverflow(error: ReturnType<NamedError["toObject"]>) {
    const isApi = MessageV2.APIError.isInstance(error)
    const statusCode = isApi ? error.data.statusCode : undefined
    const raw = asString(error.data?.message)
    let code = ""
    let message = raw
    for (const source of [isApi ? error.data.responseBody : undefined, raw]) {
      if (!source) continue
      const json = iife(() => {
        try {
          return JSON.parse(source)
        } catch {
          return undefined
        }
      })
      if (!json || typeof json !== "object") continue
      const err = json.error && typeof json.error === "object" ? json.error : json
      code = asString(err.code) || asString(err.type) || asString(json.code) || asString(json.type) || code
      message = asString(err.message) || asString(json.message) || message
      break
    }
    return { statusCode, code, message }
  }

  // True when an error means the request exceeded the model's context window.
  // Deterministic: retrying the same input can only fail again, so the caller
  // should compact + resume rather than retry.
  export function isContextOverflow(error: ReturnType<NamedError["toObject"]>): boolean {
    const { statusCode, code, message } = normalizeOverflow(error)
    // A context-window rejection is always a client error (400/413). A 5xx is a
    // genuine server fault — retryable, not overflow.
    if (statusCode && statusCode >= 500) return false
    if (OVERFLOW_CODES.has(code)) return true
    const lower = message.toLowerCase()
    return OVERFLOW_PATTERNS.some((pattern) => lower.includes(pattern))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session/retry.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/session/retry.ts backend/cli/test/session/retry.test.ts
git commit -m "feat(compaction): classify context-overflow errors (isContextOverflow)"
```

---

### Task 2: 0.75 threshold + 128k fallback + config option (`SessionCompaction.isOverflow`)

Fire at 75% of usable context instead of 100%, and make the check work for models that report `limit.context = 0` (local / OpenAI-compatible / Codex). Lowering to 0.75 changes two existing test expectations — both are updated here.

**Files:**
- Modify: `backend/cli/src/session/compaction.ts:30-39` (constants + `isOverflow`)
- Modify: `backend/cli/src/config/config.ts:1113-1118` (add `threshold` to the `compaction` object)
- Test: `backend/cli/test/session/compaction.test.ts` (update 2 existing tests, add 3)

**Interfaces:**
- Consumes: `Config.get()`, `SessionPrompt.OUTPUT_TOKEN_MAX`, `Provider.Model.limit`.
- Produces: `SessionCompaction.DEFAULT_THRESHOLD = 0.75`, `SessionCompaction.FALLBACK_CONTEXT = 128_000`; `isOverflow` now returns `count > usable * threshold` and uses the fallback when context is 0.

- [ ] **Step 1: Update + add the failing tests**

In `backend/cli/test/session/compaction.test.ts`:

Replace the body of the test `"returns false when input/output are within input caps"` (currently `input: 200_000`) so it stays under 75% of the 272k input cap:

```ts
  test("returns false when input/output are within input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        // count = 150_000 + 20_000 + 10_000 = 180_000; 0.75 * 272_000 = 204_000 → false
        const tokens = { input: 150_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })
```

Replace the test `"returns false when model context limit is 0"` with the new fallback behavior:

```ts
  test("uses 128k fallback context when model reports context limit 0", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 0, output: 32_000 })
        // fallback usable = 128_000 - 32_000 = 96_000; count = 110_000 > 0.75 * 96_000 = 72_000 → true
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("fallback context does not over-trigger when usage is small", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 0, output: 32_000 })
        // fallback usable = 96_000; count = 35_000 < 0.75 * 96_000 = 72_000 → false
        const tokens = { input: 30_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })
```

Add a threshold-override test at the end of the `describe("session.compaction.isOverflow", …)` block:

```ts
  test("respects config.compaction.threshold override", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ compaction: { threshold: 0.5 } }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        // usable = 68_000; count = 40_000. Over 0.5*68_000=34_000 (true) but under default 0.75*68_000=51_000.
        const tokens = { input: 35_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })
```

- [ ] **Step 2: Run tests to verify the updated/new ones fail**

Run: `bun test test/session/compaction.test.ts`
Expected: FAIL — `uses 128k fallback…` and `respects config.compaction.threshold` fail against the current `count > usable` / `context === 0 → false` logic.

- [ ] **Step 3: Implement the threshold + fallback**

In `backend/cli/src/session/compaction.ts`, replace `isOverflow` (lines 30-39) with:

```ts
  // Fraction of the usable context budget at which auto-compaction fires. 0.75
  // matches Claude Code / opencode: ~25% headroom so the NEXT turn (plus its
  // output) can't blow the hard limit before compaction runs. Overridable via
  // config.compaction.threshold.
  export const DEFAULT_THRESHOLD = 0.75

  // Assumed context window when a provider reports 0 (local / OpenAI-compatible
  // / Codex). Matches the existing unknown-model fallback at provider.ts:770.
  export const FALLBACK_CONTEXT = 128_000

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context || FALLBACK_CONTEXT
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = input.model.limit.input || context - output
    const threshold = config.compaction?.threshold ?? DEFAULT_THRESHOLD
    return count > usable * threshold
  }
```

In `backend/cli/src/config/config.ts`, extend the `compaction` object (lines 1113-1118) to add `threshold`:

```ts
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Compact when context exceeds this fraction of the model window (default: 0.75)"),
        })
        .optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/session/compaction.test.ts`
Expected: PASS (all isOverflow tests, including the updated and new ones).

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/session/compaction.ts backend/cli/src/config/config.ts backend/cli/test/session/compaction.test.ts
git commit -m "feat(compaction): fire at 0.75 threshold + 128k fallback for context=0 models"
```

---

### Task 3: Processor returns `"overflow"` on a context-window rejection

Wire the classifier into the stream error handler so a context-overflow rejection is signalled to the session loop instead of being retried as a generic "Provider Server Error".

**Files:**
- Modify: `backend/cli/src/session/processor.ts` (declare `overflow`, reset it, branch in the `catch`, return `"overflow"`)

**Interfaces:**
- Consumes: `SessionRetry.isContextOverflow` (Task 1).
- Produces: `SessionProcessor.create(...).process(...)` return union extends to `"continue" | "compact" | "stop" | "overflow"`.

- [ ] **Step 1: Declare and reset the `overflow` flag**

In `backend/cli/src/session/processor.ts`, next to `let needsCompaction = false` (line 62), add:

```ts
    let overflow = false
```

Inside `async process(streamInput: LLM.StreamInput)`, next to the existing `needsCompaction = false` reset (line 73), add:

```ts
        overflow = false
```

- [ ] **Step 2: Branch the catch block on overflow (before `retryable`)**

Replace the current catch body (lines 429-457, from `const error = MessageV2.fromError(...)` through the `Bus.publish(Session.Event.Error …)` block) with:

```ts
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            // A context-window overflow is deterministic — retrying the same
            // oversized input can only fail again. Signal the outer loop (via the
            // "overflow" return below) to compact + resume instead of burning
            // retries or surfacing an error. Checked BEFORE retryable() so it
            // isn't swallowed by the generic "Provider Server Error" bucket.
            if (SessionRetry.isContextOverflow(error)) {
              log.info("context overflow — compacting instead of retrying", { sessionID: input.sessionID })
              overflow = true
            } else {
              const retry = SessionRetry.retryable(error)
              if (retry !== undefined && attempt < MAX_RETRY_ATTEMPTS) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              input.assistantMessage.error = error
              // A user-initiated abort is a clean cancellation, not a failure —
              // record it on the message but don't fire the session Error event.
              if (!MessageV2.AbortedError.isInstance(error)) {
                Bus.publish(Session.Event.Error, {
                  sessionID: input.assistantMessage.sessionID,
                  error: input.assistantMessage.error,
                })
              }
            }
```

- [ ] **Step 3: Return `"overflow"` before the other terminal returns**

Replace the trailing return block (lines 492-495) with:

```ts
          if (overflow) return "overflow"
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS. (No unit test here — the branch is exercised end-to-end by Task 5; the return-type change is what later tasks consume.)

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/session/processor.ts
git commit -m "feat(compaction): processor signals context-overflow instead of retrying"
```

---

### Task 4: Compaction accepts `focus` and propagates `"overflow"`

Let a compaction task carry an optional focus string (for `/compact <topic>`), and make `process()` surface `"overflow"` when the summarization request itself is too big to send.

**Files:**
- Modify: `backend/cli/src/session/message-v2.ts:161-166` (`CompactionPart` gains `focus`)
- Modify: `backend/cli/src/session/compaction.ts` (`process` return + focus; `create` input + part write)

**Interfaces:**
- Consumes: `SessionProcessor…process()` returning `"overflow"` (Task 3).
- Produces: `SessionCompaction.process(input & { focus?: string })` returns `"stop" | "continue" | "overflow"`; `SessionCompaction.create({ …, focus? })` persists `focus` on the compaction part; `MessageV2.CompactionPart.focus?: string`.

- [ ] **Step 1: Add `focus` to the CompactionPart schema**

In `backend/cli/src/session/message-v2.ts`, update `CompactionPart` (lines 161-166):

```ts
  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    focus: z.string().optional(),
  }).meta({
    ref: "CompactionPart",
  })
```

- [ ] **Step 2: Thread `focus` and `"overflow"` through `process`**

In `backend/cli/src/session/compaction.ts`, add `focus?: string` to the `process` input object (after `auto: boolean` at line 99):

```ts
    auto: boolean
    focus?: string
```

Replace the `defaultPrompt` / `promptText` lines (143-145) with:

```ts
    const defaultPrompt =
      "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
    const focusLine = input.focus?.trim()
      ? `\n\nThe next session will focus on: ${input.focus.trim()}. Tailor the summary toward that.`
      : ""
    const promptText = compacting.prompt ?? [defaultPrompt + focusLine, ...compacting.context].join("\n\n")
```

Immediately after the `const result = await processor.process({ … })` call (after line 166), add:

```ts
    // The summarization request itself exceeded the context window — no summary
    // was produced. Surface it so the caller fails the turn instead of
    // re-attempting a compaction that can never succeed.
    if (result === "overflow") return "overflow"
```

- [ ] **Step 3: Add `focus` to `create` and persist it on the part**

In `backend/cli/src/session/compaction.ts`, extend the `create` zod input (after `auto: z.boolean(),` at line 205):

```ts
      auto: z.boolean(),
      focus: z.string().optional(),
```

And in the same `create` body, add `focus` to the `updatePart` call for the compaction part (after `auto: input.auto,` near line 223):

```ts
        type: "compaction",
        auto: input.auto,
        focus: input.focus,
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/session/compaction.ts backend/cli/src/session/message-v2.ts
git commit -m "feat(compaction): thread focus + propagate overflow through process/create"
```

---

### Task 5: Session-loop recovery — resume-once, terminal fail, anti-thrash latch

Wire everything into the loop so: (a) an overflow compacts and resumes once, then fails terminally; (b) the 0.75 reactive path can't thrash; (c) the summarization-overflow case fails loudly.

**Files:**
- Modify: `backend/cli/src/session/prompt.ts` (`loop`, around lines 300-730)

**Interfaces:**
- Consumes: `SessionCompaction.isOverflow` / `.create` / `.process` (Tasks 2, 4), processor `"overflow"` return (Task 3), `NamedError.Unknown`, `MessageV2.nextMessageID`, `Instance`.
- Produces: loop-proof context-overflow recovery. No new exports.

- [ ] **Step 1: Declare loop-scoped guards**

In `backend/cli/src/session/prompt.ts`, next to `let step = 0` (line ~301), add:

```ts
    // Consecutive context-overflow compactions for the current unanswered turn.
    // Reset on any non-overflow result; a second overflow means the pending
    // message itself is too large to ever fit.
    let overflowCompactions = 0
    // Compact once, then don't compact again until context drops back under the
    // threshold. Prevents an infinite compaction loop when fixed system+tool+
    // summary overhead alone already exceeds the 0.75 threshold.
    let compactionArmed = true
```

- [ ] **Step 2: Add the `failTooLarge` terminal helper**

Immediately after the existing `if (!lastUser) throw new Error("No user message found in stream. This should never happen.")` (line ~335), add:

```ts
      const user = lastUser
      // Terminal for "input exceeds the window and compaction can't help":
      // either the summarization itself overflowed, or the input is still too
      // big after one compaction. Surface an actionable error, never loop.
      const failTooLarge = async () => {
        const error = new NamedError.Unknown({
          message:
            "This message is too large for the model's context window, even after summarizing earlier history. Shorten it or start a new session.",
        }).toObject()
        Bus.publish(Session.Event.Error, { sessionID, error })
        await Session.updateMessage({
          id: await MessageV2.nextMessageID(sessionID),
          role: "assistant",
          parentID: user.id,
          sessionID,
          mode: user.agent,
          agent: user.agent,
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: user.model.modelID,
          providerID: user.model.providerID,
          error,
          time: { created: Date.now(), completed: Date.now() },
        })
      }
```

- [ ] **Step 3: Handle `"overflow"` in the pending-compaction branch**

Replace the pending-compaction branch (lines 566-577):

```ts
      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
          focus: task.focus,
        })
        if (result === "stop") break
        // The summarization request itself exceeded the window — the pending
        // turn is too large to even compact. Fail loudly, don't re-attempt.
        if (result === "overflow") {
          await failTooLarge()
          break
        }
        continue
      }
```

- [ ] **Step 4: Add the anti-thrash latch to the reactive overflow branch**

Replace the reactive overflow branch (lines 579-592):

```ts
      // context overflow, needs compaction (proactive, at the 0.75 threshold)
      const overThreshold =
        !!lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      if (overThreshold) {
        if (compactionArmed) {
          compactionArmed = false // disarm until context drops back under threshold
          await SessionCompaction.create({
            sessionID,
            agent: lastUser.agent,
            model: lastUser.model,
            auto: true,
          })
          continue
        }
        // Already compacted and still over threshold — fixed system+tool+summary
        // overhead exceeds the threshold, so re-compacting is futile and would
        // loop. Proceed silently; the model's real window + the overflow-error
        // path are the backstop.
        log.warn("auto-compaction did not bring context under threshold; proceeding", { sessionID })
      } else if (lastFinished && lastFinished.summary !== true) {
        compactionArmed = true // genuinely under threshold — re-arm for future growth
      }
```

- [ ] **Step 5: Handle `"overflow"` from normal processing**

Replace the tail of normal processing (lines 721-730):

```ts
      if (result === "stop") break
      if (result === "overflow") {
        overflowCompactions++
        // A compaction already ran for this turn and the input STILL overflows —
        // the pending message itself is too large. Surface a terminal error.
        if (overflowCompactions > 1) {
          await failTooLarge()
          break
        }
        // First overflow this turn: compact history, then the loop resumes the
        // same unanswered user message against the summary — the agent continues
        // on its own; the user never re-enters the prompt.
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }
      overflowCompactions = 0
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
      }
      continue
```

- [ ] **Step 6: Typecheck + full suite**

Run: `bun run typecheck && bun test test/session/`
Expected: PASS. `task.focus` type-resolves because `task` narrows to `CompactionPart` (Task 4). No existing session tests regress.

- [ ] **Step 7: Commit**

```bash
git add backend/cli/src/session/prompt.ts
git commit -m "feat(compaction): loop-proof context-overflow recovery (resume once, then fail)"
```

---

### Task 6: User-facing `/compact [topic]` command

Register `/compact` as an action command and intercept it so it runs a manual compaction (auto=false) through the same loop, optionally focused on a topic.

**Files:**
- Modify: `backend/cli/src/command/index.ts` (`Default.COMPACT` + registry entry)
- Modify: `backend/cli/src/session/prompt.ts` (intercept at the top of `command()`)

**Interfaces:**
- Consumes: `SessionCompaction.create({ …, focus? })` (Task 4), `SessionPrompt.loop` (existing), `Provider.parseModel`, `lastModel`, `Agent.defaultAgent`, `Command.Default`, `Command.Event.Executed`.
- Produces: `Command.Default.COMPACT = "compact"`; `/compact` and `/compact <topic>` run a manual compaction and return the summary message.

- [ ] **Step 1: Register the action command**

In `backend/cli/src/command/index.ts`, add `COMPACT` to `Default` (lines 54-58):

```ts
  export const Default = {
    INIT: "init",
    REVIEW: "review",
    LEARN: "learn",
    COMPACT: "compact",
  } as const
```

Add a registry entry after the `[Default.LEARN]` block (after line 88), inside the `result` object:

```ts
      // Action command, not a prompt template — SessionPrompt.command intercepts
      // it and runs SessionCompaction directly. The empty template is never used.
      [Default.COMPACT]: {
        name: Default.COMPACT,
        description: "summarize the conversation so far to free up context",
        get template() {
          return ""
        },
        hints: [],
      },
```

- [ ] **Step 2: Intercept `/compact` at the top of `command()`**

In `backend/cli/src/session/prompt.ts`, immediately after `log.info("command", input)` at the start of `export async function command(input: CommandInput)` (line ~1848), add:

```ts
    // /compact is an action, not a prompt template: enqueue a compaction task
    // and run the loop to process it (same machinery as auto-compaction), then
    // return the summary. The user does not get a normal AI turn. Any text after
    // the command (input.arguments) is the optional focus topic.
    if (input.command === Command.Default.COMPACT) {
      const model = input.model ? Provider.parseModel(input.model) : await lastModel(input.sessionID)
      const agentName = input.agent ?? (await Agent.defaultAgent())
      const focus = input.arguments.trim()
      await SessionCompaction.create({
        sessionID: input.sessionID,
        agent: agentName,
        model: { providerID: model.providerID, modelID: model.modelID },
        auto: false,
        focus: focus || undefined,
      })
      const result = await loop(input.sessionID)
      Bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    }
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run the dev CLI, hold a short conversation, then run `/compact` and `/compact focus on the loss function`:

```bash
bun run dev
```

Expected: `/compact` produces a summary assistant message (mode `compaction`) and frees context; `/compact <topic>` produces a summary whose prompt was steered toward the topic; neither starts a normal AI turn. Confirm `/compact` appears in the slash-command list.

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/command/index.ts backend/cli/src/session/prompt.ts
git commit -m "feat(compaction): user-facing /compact [topic] command"
```

---

### Task 7: End-to-end verification against the original bug

Confirm the reported infinite loop is gone and nothing regressed.

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: PASS — including `test/session/retry.test.ts` and `test/session/compaction.test.ts`.

- [ ] **Step 2: Typecheck the whole CLI**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Reproduce the original scenario**

Configure a model whose provider reports `limit.context = 0` (e.g. a Codex/OpenAI-compatible entry) or set `compaction.threshold` low, drive the session past the window, and confirm:
- auto-compaction fires at ~75% (a `compaction` message appears), the turn resumes on its own;
- if a hard `context_length_exceeded` still occurs, the loop compacts and resumes **once**, and on a second overflow shows the terminal "too large … start a new session" error instead of looping;
- the log no longer shows repeating `session.processor error … context_length_exceeded`.

- [ ] **Step 4: Final commit (if any doc/PROGRESS updates)**

```bash
git add -A
git commit -m "chore(compaction): verification pass for auto-compaction at 75%"
```

---

## Self-Review

**1. Spec coverage:**
- Layer A (0.75 threshold) → Task 2. ✅
- Layer B (hard-error classify + resume-once + terminal fail) → Tasks 1, 3, 5. ✅
- Layer C (128k fallback for context=0) → Task 2. ✅
- `config.compaction.threshold` → Task 2. ✅
- `/compact [topic]` (command register + intercept + focus) → Tasks 4, 6. ✅
- `CompactionPart.focus` schema → Task 4. ✅
- Processor `"overflow"` return → Task 3. ✅
- Silent back-off (log only, no notice) → Task 5, Step 4. ✅
- Tests: classifier + isOverflow (threshold, fallback, override) → Tasks 1, 2. ✅
- Non-goals (head/tail rebuild, summary-of-summary, disk archive, back-off notifier) → not present. ✅

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step shows real code. ✅

**3. Type consistency:** `isContextOverflow` signature identical in Tasks 1/3. `focus?: string` consistent across `CompactionPart` / `process` / `create` (Task 4) and consumed as `task.focus` / `input.arguments` (Tasks 5/6). Processor return `"overflow"` (Task 3) matched by `result === "overflow"` checks (Tasks 4/5). `DEFAULT_THRESHOLD` / `FALLBACK_CONTEXT` defined once (Task 2). ✅
