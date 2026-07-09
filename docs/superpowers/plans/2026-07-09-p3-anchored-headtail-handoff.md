# P3.1 + P3.2 — Anchored Summary & Head/Tail Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make auto-compaction (a) *update* the prior handoff instead of regenerating it, and (b) keep the recent tail — including the current user request — verbatim instead of summarizing it away.

**Architecture:** Two additions to the existing `SessionCompaction.process()` path, both ported from opencode (same `compaction.ts`/`filterCompacted` lineage) plus hermes' force-last-user-into-tail. P3.1 is a prompt branch driven by a `previousSummary()` lookup. P3.2 is a pure `selectTail()` split + a `tailStartId` field on the summary message + a `filterCompacted()` re-splice that keeps the tail verbatim.

**Tech Stack:** Bun + TypeScript, `bun test`, zod schemas, the existing `MessageV2` / `SessionCompaction` namespaces.

## Global Constraints

- No AI-attribution trailers in commits (org rule).
- Bun APIs, `const` over `let`, avoid `else`, rely on type inference, no `any`, no mocks in tests (test real implementations). (`AGENTS.md`.)
- Run from `backend/cli`: tests via `bun test test/session/`, typecheck via `bun run typecheck`.
- Tool_use/tool_result pairs live inside a single assistant `tool` part, so cutting at message/turn boundaries never splits a pair — no special tool-group alignment needed.
- Spec: `docs/superpowers/specs/2026-07-09-p3-anchored-headtail-handoff-design.md`.

---

### Task 1: P3.1 — Anchored/incremental summary prompt

**Files:**
- Modify: `backend/cli/src/session/compaction.ts` (add `previousSummary()` + `buildHandoffPrompt()`, use them in `process()` around the `defaultPrompt`/`promptText` at lines ~183-246)
- Test: `backend/cli/test/session/compaction.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `SessionCompaction.previousSummary(messages: MessageV2.WithParts[]): string | undefined` — the newest prior handoff text, or undefined.
- Produces: `SessionCompaction.buildHandoffPrompt(opts: { previousSummary?: string; focus?: string }): string` — the create prompt when no prior summary, the update prompt when one exists.

- [ ] **Step 1: Write the failing tests**

Append to `backend/cli/test/session/compaction.test.ts` (it already imports `SessionCompaction`):

```typescript
import { MessageV2 } from "../../src/session/message-v2"

describe("session.compaction.previousSummary", () => {
  const asstSummary = (id: string, text: string): MessageV2.WithParts => ({
    info: { id, sessionID: "s", role: "assistant", summary: true, finish: "stop", parentID: "p", modelID: "m", providerID: "p", mode: "", agent: "compaction", path: { cwd: "/", root: "/" }, cost: 0, time: { created: 0 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as any,
    parts: [{ id: "t", sessionID: "s", messageID: id, type: "text", text } as any],
  })
  const userMsg = (id: string): MessageV2.WithParts => ({
    info: { id, sessionID: "s", role: "user", time: { created: 0 }, agent: "a", model: { providerID: "p", modelID: "m" } } as any,
    parts: [{ id: "u", sessionID: "s", messageID: id, type: "text", text: "hi" } as any],
  })

  test("returns the newest summary message's text", () => {
    const msgs = [asstSummary("a1", "OLD HANDOFF"), userMsg("u1"), asstSummary("a2", "NEW HANDOFF")]
    expect(SessionCompaction.previousSummary(msgs)).toBe("NEW HANDOFF")
  })
  test("returns undefined when there is no prior summary", () => {
    expect(SessionCompaction.previousSummary([userMsg("u1")])).toBeUndefined()
  })
})

describe("session.compaction.buildHandoffPrompt", () => {
  test("no prior summary → create prompt with the section structure", () => {
    const p = SessionCompaction.buildHandoffPrompt({})
    expect(p).toContain("## Objective")
    expect(p).not.toContain("<previous-summary>")
  })
  test("prior summary → update prompt embeds it and says update-not-regenerate", () => {
    const p = SessionCompaction.buildHandoffPrompt({ previousSummary: "PRIOR TEXT" })
    expect(p).toContain("<previous-summary>")
    expect(p).toContain("PRIOR TEXT")
    expect(p.toLowerCase()).toContain("update")
    expect(p).toContain("## Objective")
  })
  test("focus is appended in both branches", () => {
    expect(SessionCompaction.buildHandoffPrompt({ focus: "the deploy" })).toContain("the deploy")
    expect(SessionCompaction.buildHandoffPrompt({ previousSummary: "x", focus: "the deploy" })).toContain("the deploy")
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend/cli && bun test test/session/compaction.test.ts`
Expected: FAIL — `SessionCompaction.previousSummary is not a function` / `buildHandoffPrompt is not a function`.

- [ ] **Step 3: Implement `previousSummary` and `buildHandoffPrompt`**

In `compaction.ts`, add inside the `SessionCompaction` namespace (near the other helpers). Move the existing `defaultPrompt` body into the create branch of `buildHandoffPrompt`; keep the exact section text (Objective / Constraints & Decisions / Work State / Next Move / Key Files) so the create path is unchanged.

```typescript
export function previousSummary(messages: MessageV2.WithParts[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role === "assistant" && info.summary) {
      const text = messages[i].parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim()
      if (text) return text
    }
  }
  return undefined
}

const HANDOFF_STRUCTURE = `## Objective
- [the user's EXPLICIT request — what THEY actually asked for, verbatim if short. NOT tangents, hunches, anomalies you noticed, or follow-up ideas you had while working]

## Constraints & Decisions
- [rules/preferences that must hold, decisions made and WHY, key assumptions — the things a fresh agent would otherwise get wrong]

## Work State
### Done (verified)
- [completed & verified work with the concrete result, so it need not be re-checked]
### In progress
- [what is partially done and exactly where it stands]
### Blocked / open
- [blockers, failing checks, unresolved questions]

## Next Move
1. [the next action REQUIRED to fulfill the Objective — nothing else. Do NOT introduce new goals, investigations, files, or analyses the user did not explicitly ask for. If the Objective is already satisfied, write exactly: "Objective complete — report the result to the user and stop."]
2. [the action after that, only if it too is required by the Objective]

## Key Files & Artifacts
- [path — what it holds and why it matters; read it ONLY if the Next Move needs it]`

const HANDOFF_RULES = `Preserve exact file paths, commands, identifiers, error strings, and numeric results verbatim. Use terse bullets, not prose. Do not mention that context was compacted or that you are summarizing. Do not ask questions. Do NOT invent work the user did not request — a handoff that adds goals beyond the Objective sends the next agent off-task.`

export function buildHandoffPrompt(opts: { previousSummary?: string; focus?: string }): string {
  const focus = opts.focus?.trim() ? `\n\nThe next session will focus on: ${opts.focus.trim()}. Tailor the handoff toward that.` : ""
  const head = opts.previousSummary
    ? `You are UPDATING an existing handoff, not writing a new one. New conversation turns have happened since it was written; fold them in.

Update the handoff below. PRESERVE still-true items verbatim; move \`In progress\` items to \`Done (verified)\` once completed; move resolved blockers out of \`Blocked / open\`; drop stale detail; append genuinely new facts. Keep the Objective bound to the user's EXPLICIT request — do not broaden it. Re-emit the exact same Markdown structure below (keep every section; write "(none)" when empty).

<previous-summary>
${opts.previousSummary}
</previous-summary>`
    : `Write a self-contained handoff so another agent can continue this work WITHOUT re-reading the files or re-deriving state. This handoff is the ONLY context that agent will have — capture everything needed to act, and nothing more.

Output exactly this Markdown structure, keeping every section (write "(none)" when a section is empty).`
  return `${head}\n\n${HANDOFF_STRUCTURE}\n\n${HANDOFF_RULES}${focus}`
}
```

- [ ] **Step 4: Wire it into `process()`**

Replace the current `defaultPrompt`/`focusLine`/`promptText` construction (compaction.ts ~183-246) so it uses the new builder. Keep the plugin override (`compacting.prompt`) winning:

```typescript
const promptText =
  compacting.prompt ??
  [SessionCompaction.buildHandoffPrompt({ previousSummary: previousSummary(input.messages), focus: input.focus }), ...compacting.context].join("\n\n")
```

Delete the now-unused `defaultPrompt` and `focusLine` locals.

- [ ] **Step 5: Run tests + typecheck, verify green**

Run: `cd backend/cli && bun test test/session/compaction.test.ts && bun run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/cli/src/session/compaction.ts backend/cli/test/session/compaction.test.ts
git commit -m "feat(compaction): P3.1 — anchored handoff (update prior, not regenerate)"
```

---

### Task 2: P3.2a — config knobs + `selectTail()` pure function

**Files:**
- Modify: `backend/cli/src/config/config.ts` (add `tailTurns`, `tailTokens` under the `compaction` object, near lines 1155-1172)
- Modify: `backend/cli/src/session/compaction.ts` (add `TAIL_TURNS`, `TAIL_TOKENS_*` constants + `messageTokens()` + `selectTail()`)
- Test: `backend/cli/test/session/compaction.test.ts`

**Interfaces:**
- Produces: `SessionCompaction.selectTail(messages: MessageV2.WithParts[], opts: { tailTurns: number; tailTokens: number }): { tailStartId?: string }` — the id of the user message where the verbatim tail begins, or `{}` when the tail would cover everything / there are < 2 turns.
- Produces: `SessionCompaction.messageTokens(msg: MessageV2.WithParts): number` — flat token estimate of one message (text + reasoning + tool input/output + `IMAGE_TOKEN_ESTIMATE` per image).
- Config: `config.compaction.tailTurns?`, `config.compaction.tailTokens?`.

- [ ] **Step 1: Write the failing tests**

Append to `compaction.test.ts`. Helpers build turns as `[user, assistant, assistant, user, …]`:

```typescript
describe("session.compaction.selectTail", () => {
  const u = (id: string, text = "hi"): MessageV2.WithParts => ({
    info: { id, sessionID: "s", role: "user", time: { created: 0 }, agent: "a", model: { providerID: "p", modelID: "m" } } as any,
    parts: [{ id: `${id}p`, sessionID: "s", messageID: id, type: "text", text } as any],
  })
  const a = (id: string, text: string): MessageV2.WithParts => ({
    info: { id, sessionID: "s", role: "assistant", parentID: "u", modelID: "m", providerID: "p", mode: "", agent: "a", summary: false, finish: "stop", cost: 0, time: { created: 0 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as any,
    parts: [{ id: `${id}p`, sessionID: "s", messageID: id, type: "text", text } as any],
  })

  test("keeps at least the last user turn verbatim (force-last-user), summarizing the rest", () => {
    const msgs = [u("u1"), a("a1", "x".repeat(400)), u("u2"), a("a2", "y".repeat(400)), u("u3"), a("a3", "done")]
    const { tailStartId } = SessionCompaction.selectTail(msgs, { tailTurns: 1, tailTokens: 10_000 })
    expect(tailStartId).toBe("u3") // the last turn is preserved; u1/u2 turns get summarized
  })

  test("keeps up to tailTurns turns when the budget allows", () => {
    const msgs = [u("u1"), a("a1", "x"), u("u2"), a("a2", "y"), u("u3"), a("a3", "z")]
    const { tailStartId } = SessionCompaction.selectTail(msgs, { tailTurns: 2, tailTokens: 10_000 })
    expect(tailStartId).toBe("u2") // last 2 turns kept
  })

  test("token budget trims below tailTurns (but never below 1 turn)", () => {
    // each turn ~ 250 tokens (1000 chars / 4). budget 300 fits only the newest turn.
    const big = "z".repeat(1000)
    const msgs = [u("u1"), a("a1", big), u("u2"), a("a2", big), u("u3"), a("a3", big)]
    const { tailStartId } = SessionCompaction.selectTail(msgs, { tailTurns: 3, tailTokens: 300 })
    expect(tailStartId).toBe("u3")
  })

  test("returns {} when there is only one turn (nothing to summarize)", () => {
    expect(SessionCompaction.selectTail([u("u1"), a("a1", "hi")], { tailTurns: 2, tailTokens: 10_000 })).toEqual({})
  })

  test("returns {} when the tail would cover every turn", () => {
    const msgs = [u("u1"), a("a1", "hi"), u("u2"), a("a2", "hi")]
    expect(SessionCompaction.selectTail(msgs, { tailTurns: 5, tailTokens: 10_000 })).toEqual({})
  })

  test("messageTokens counts text + tool output", () => {
    expect(SessionCompaction.messageTokens(a("a1", "x".repeat(40)))).toBe(10)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend/cli && bun test test/session/compaction.test.ts`
Expected: FAIL — `selectTail is not a function`.

- [ ] **Step 3: Implement constants, `messageTokens`, `selectTail`**

In `compaction.ts`:

```typescript
export const TAIL_TURNS = 2
export const TAIL_TOKENS_MIN = 8_000
export const TAIL_TOKENS_MAX = 32_000

export function messageTokens(msg: MessageV2.WithParts): number {
  let total = 0
  for (const part of msg.parts) {
    if (part.type === "text" || part.type === "reasoning") total += Token.estimate(part.text)
    if (part.type === "tool") {
      total += Token.estimate(JSON.stringify(part.state.input ?? {}))
      if (part.state.status === "completed") {
        total += Token.estimate(part.state.output)
        total += (part.state.attachments ?? []).filter((x) => x.mime.startsWith("image/")).length * IMAGE_TOKEN_ESTIMATE
      }
      if (part.state.status === "error") total += Token.estimate(part.state.error)
    }
    if (part.type === "file" && part.mime.startsWith("image/")) total += IMAGE_TOKEN_ESTIMATE
  }
  return total
}

// Split the history into a verbatim recent tail + a head to summarize. Returns the id of
// the user message the tail begins at. Keeps whole turns (a user message + its following
// assistant/tool messages) newest-first up to tailTurns, trimmed to the tailTokens budget
// but never below one turn — so the current request is always kept verbatim. Returns {}
// when the tail would cover everything or there is nothing older to summarize.
export function selectTail(
  messages: MessageV2.WithParts[],
  opts: { tailTurns: number; tailTokens: number },
): { tailStartId?: string } {
  const turnStarts = messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []))
  if (turnStarts.length < 2) return {}
  const turnSize = (start: number, end: number) => {
    let sum = 0
    for (let i = start; i < end; i++) sum += messageTokens(messages[i])
    return sum
  }
  let tokens = 0
  let cut = messages.length // start index of the oldest kept turn
  for (let t = turnStarts.length - 1; t >= 0; t--) {
    const start = turnStarts[t]
    const end = t + 1 < turnStarts.length ? turnStarts[t + 1] : messages.length
    const size = turnSize(start, end)
    const keptTurns = turnStarts.length - t - 1
    // always keep the newest turn; then keep more only within budget and up to tailTurns
    if (keptTurns >= 1 && (keptTurns >= opts.tailTurns || tokens + size > opts.tailTokens)) break
    tokens += size
    cut = start
  }
  if (cut <= 0 || cut >= messages.length) return {} // tail covers everything / nothing kept
  return { tailStartId: messages[cut].info.id }
}
```

Add config in `config.ts` (`compaction` object, after `fallbackContext`):

```typescript
tailTurns: z.number().int().positive().optional().describe("Minimum recent turns kept verbatim during compaction (default: 2)"),
tailTokens: z.number().int().positive().optional().describe("Token budget for the verbatim recent tail during compaction (default: clamp(0.20*usable, 8000, 32000))"),
```

- [ ] **Step 4: Run tests + typecheck, verify green**

Run: `cd backend/cli && bun test test/session/compaction.test.ts && bun run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/session/compaction.ts backend/cli/src/config/config.ts backend/cli/test/session/compaction.test.ts
git commit -m "feat(compaction): P3.2 — selectTail head/tail split + tail config"
```

---

### Task 3: P3.2b — `tailStartId` on the summary message + `filterCompacted` re-splice

**Files:**
- Modify: `backend/cli/src/session/message-v2.ts` (add `tailStartId?` to `Assistant` schema ~line 399; extend `filterCompacted` ~lines 984-999)
- Test: `backend/cli/test/session/message-v2.test.ts`

**Interfaces:**
- Consumes: the `Assistant` message may carry `tailStartId?: string` (set by Task 4).
- Produces: `filterCompacted`, given a summary message with `tailStartId`, yields `[…older dropped…]` removed but the verbatim tail (from `tailStartId` up to the compaction boundary) retained, ordered `[compaction marker, summary, …tail…, continuation]`. Without `tailStartId`, behavior is unchanged from today.

Reference implementation to mirror: `~/codes/opencode/packages/opencode/src/session/message-v2.ts:521-572` (`filterCompacted` with `tail_start_id`).

- [ ] **Step 1: Write the failing test**

Append to `message-v2.test.ts`. `filterCompacted` consumes an async stream oldest-first and returns the retained `WithParts[]` newest-last:

```typescript
describe("session.message-v2.filterCompacted — verbatim tail (P3.2)", () => {
  async function* streamOf(msgs: MessageV2.WithParts[]) { for (const m of msgs) yield m }
  const mk = (id: string, role: "user" | "assistant", parts: any[], extra: any = {}): MessageV2.WithParts => ({
    info: { id, sessionID: "s", role, time: { created: 0 }, ...(role === "user" ? { agent: "a", model: { providerID: "p", modelID: "m" } } : { parentID: "p", modelID: "m", providerID: "p", mode: "", agent: "a", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), ...extra } as any,
    parts: parts as any,
  })
  const txt = (mid: string, t: string) => ({ id: `${mid}t`, sessionID: "s", messageID: mid, type: "text", text: t })
  const compactionCarrier = (id: string) => mk(id, "user", [{ id: `${id}c`, sessionID: "s", messageID: id, type: "compaction", auto: true }])

  test("keeps the tail messages verbatim after the summary", async () => {
    // history: [old1 old2] [tail: u-tail a-tail] [compaction carrier] [summary(tailStartId=u-tail)] [continuation]
    const msgs: MessageV2.WithParts[] = [
      mk("old1", "user", [txt("old1", "old q")]),
      mk("old2", "assistant", [txt("old2", "old a")]),
      mk("utail", "user", [txt("utail", "current request")]),
      mk("atail", "assistant", [txt("atail", "recent work")]),
      compactionCarrier("cc"),
      mk("sum", "assistant", [txt("sum", "HANDOFF")], { summary: true, finish: "stop", parentID: "cc", tailStartId: "utail" }),
      mk("cont", "assistant", [txt("cont", "continuing")], { finish: "stop", parentID: "cc" }),
    ]
    const out = await MessageV2.filterCompacted(streamOf(msgs))
    const ids = out.map((m) => m.info.id)
    expect(ids).not.toContain("old1")
    expect(ids).not.toContain("old2")
    // tail preserved verbatim, ordered after the summary
    expect(ids).toEqual(["cc", "sum", "utail", "atail", "cont"])
  })

  test("without tailStartId, behavior is unchanged (drops everything before the boundary)", async () => {
    const msgs: MessageV2.WithParts[] = [
      mk("old1", "user", [txt("old1", "old")]),
      compactionCarrier("cc"),
      mk("sum", "assistant", [txt("sum", "HANDOFF")], { summary: true, finish: "stop", parentID: "cc" }),
      mk("cont", "assistant", [txt("cont", "go")], { finish: "stop", parentID: "cc" }),
    ]
    const out = await MessageV2.filterCompacted(streamOf(msgs))
    expect(out.map((m) => m.info.id)).toEqual(["cc", "sum", "cont"])
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd backend/cli && bun test test/session/message-v2.test.ts`
Expected: FAIL — the first test gets `["cc","sum","cont"]` (tail dropped) instead of the tail-preserving order; and/or a typecheck error on `tailStartId`.

- [ ] **Step 3: Add `tailStartId` to the `Assistant` schema**

In `message-v2.ts`, in the `Assistant` schema (after `finish: z.string().optional()`, ~line 399):

```typescript
    // P3.2: the id of the user message where the verbatim recent tail begins, for the
    // summary message. filterCompacted keeps [tailStartId..boundary] verbatim after the
    // summary instead of dropping it.
    tailStartId: z.string().optional(),
```

- [ ] **Step 4: Implement the re-splice in `filterCompacted`**

Replace the body of `filterCompacted` (message-v2.ts ~984-999) so that, when the boundary summary has a `tailStartId`, the messages from `tailStartId` up to the boundary are retained and re-ordered after the summary:

```typescript
export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
  const all = [] as MessageV2.WithParts[]
  for await (const msg of stream) all.push(msg)
  // find the newest compaction boundary: a completed summary + its compaction carrier.
  let summaryIdx = -1
  for (let i = all.length - 1; i >= 0; i--) {
    const info = all[i].info
    if (info.role === "assistant" && info.summary && info.finish) { summaryIdx = i; break }
  }
  if (summaryIdx === -1) return all
  const summary = all[summaryIdx].info as MessageV2.Assistant
  // the carrier is the summary's parent (the user message with the compaction part)
  const carrierIdx = all.findIndex((m) => m.info.id === summary.parentID)
  const boundaryIdx = carrierIdx === -1 ? summaryIdx : carrierIdx
  // verbatim tail = [tailStartId .. boundaryIdx)
  const tail: MessageV2.WithParts[] = []
  if (summary.tailStartId) {
    const tailIdx = all.findIndex((m) => m.info.id === summary.tailStartId)
    if (tailIdx !== -1 && tailIdx < boundaryIdx) tail.push(...all.slice(tailIdx, boundaryIdx))
  }
  const after = all.slice(summaryIdx + 1) // continuation
  const marker = all.slice(boundaryIdx, summaryIdx + 1) // [carrier, summary]
  return [...marker, ...tail, ...after]
}
```

- [ ] **Step 5: Run tests + typecheck, verify green (and no regression)**

Run: `cd backend/cli && bun test test/session/ && bun run typecheck`
Expected: the two new tests PASS; all previously-passing session tests still PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/cli/src/session/message-v2.ts backend/cli/test/session/message-v2.test.ts
git commit -m "feat(compaction): P3.2 — keep verbatim tail after summary in filterCompacted"
```

---

### Task 4: P3.2c — wire `selectTail` into `process()` (summarize head-only, set `tailStartId`)

**Files:**
- Modify: `backend/cli/src/session/compaction.ts` (`process()` — compute the tail, summarize only the head, stamp `tailStartId` on the summary message; ~lines 126-269)
- Test: covered by Tasks 2–3 unit tests + a live run (below)

**Interfaces:**
- Consumes: `selectTail()` (Task 2), the `tailStartId` schema field (Task 3), `Config.get()`.

- [ ] **Step 1: Compute the tail budget + split at the top of `process()`**

After `model` is resolved and before building the summary request, add:

```typescript
const cfg = await Config.get()
const context = model.limit.context || cfg.compaction?.fallbackContext || FALLBACK_CONTEXT
const cap = Math.min(model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
const output = Math.min(cap, Math.floor(context / 2))
const usable = model.limit.input || context - output
const tailTurns = cfg.compaction?.tailTurns ?? TAIL_TURNS
const tailTokens =
  cfg.compaction?.tailTokens ?? Math.min(TAIL_TOKENS_MAX, Math.max(TAIL_TOKENS_MIN, Math.floor(usable * 0.2)))
const { tailStartId } = selectTail(input.messages, { tailTurns, tailTokens })
const tailIdx = tailStartId ? input.messages.findIndex((m) => m.info.id === tailStartId) : -1
const head = tailIdx > 0 ? input.messages.slice(0, tailIdx) : input.messages
```

- [ ] **Step 2: Summarize only the head**

Change the summary request to use `head` instead of `input.messages`:

```typescript
      messages: [
        ...MessageV2.toModelMessages(head, model, { stripMedia: true }),
        { role: "user", content: [{ type: "text", text: promptText }] },
      ],
```

- [ ] **Step 3: Stamp `tailStartId` on the summary message**

Where the summary assistant message `msg` is created (the `Session.updateMessage({ … role: "assistant", summary: true, … })` call, ~line 140-164), add `tailStartId` to it (only when set):

```typescript
      summary: true,
      ...(tailStartId ? { tailStartId } : {}),
```

- [ ] **Step 4: Run tests + typecheck, verify green**

Run: `cd backend/cli && bun test test/session/ && bun run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/cli/src/session/compaction.ts
git commit -m "feat(compaction): P3.2 — summarize head only, preserve recent tail verbatim"
```

- [ ] **Step 6: Live verification**

Build + run a session that compacts twice, at a low threshold so it triggers on modest content:

```bash
cd backend/cli && bun run build --single
P=/tmp/p3-verify; mkdir -p $P; printf '{\n  "compaction": { "threshold": 0.05, "tailTokens": 4000 }\n}\n' > $P/openscience.json
printf 'line %s: substantive log content for the compaction test\n' $(seq 1 500) > $P/data.txt
cd $P && OPENSCIENCE_ATLAS_TIMEOUT_MS=2000 <path-to>/openscience run "Read data.txt in full, then tell me how many lines it has and what the first and last lines say." --log-level DEBUG --print-logs 2>&1 | grep -E "session.compaction|Continue from|context compacted"
```

Confirm in the transcript/log: after compaction the current request + recent turns are present verbatim (not replaced by the summary), the agent does not re-read `data.txt`, and a second compaction's handoff *updates* the first (Objective/Constraints stable). Clean up: `rm -rf /tmp/p3-verify`.

---

## Self-Review

**Spec coverage:**
- P3.1 anchored update → Task 1 (`previousSummary` + `buildHandoffPrompt` update branch). ✓
- P3.2 head/tail split → Task 2 (`selectTail`). ✓
- P3.2 force-last-user-into-tail → Task 2 (always keep ≥1 turn = the last user turn; test "force-last-user"). ✓
- P3.2 verbatim tail re-splice → Task 3 (`filterCompacted` + `tailStartId` field). ✓
- P3.2 summarize head only → Task 4. ✓
- Config knobs (`tailTurns`, `tailTokens`) → Task 2. ✓
- Testing (unit + two-compaction live) → each task's tests + Task 4 Step 6. ✓
- Tool-group non-splitting → handled by construction (tool pairs live in one message; cut at turn boundaries), noted in Global Constraints. ✓

**Placeholder scan:** No TBD/TODO; every code step has real code; the opencode reference in Task 3 is a concrete file to read, and the full re-splice code is given inline so it is not a dependency.

**Type consistency:** `previousSummary(messages)`, `buildHandoffPrompt({previousSummary, focus})`, `selectTail(messages, {tailTurns, tailTokens})→{tailStartId?}`, `messageTokens(msg)`, `tailStartId` field — names/signatures match across Tasks 1–4. `TAIL_TURNS`/`TAIL_TOKENS_MIN`/`TAIL_TOKENS_MAX` used in Task 4 are defined in Task 2.
