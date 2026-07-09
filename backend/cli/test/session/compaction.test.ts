import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "../../src/util/token"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import type { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"

Log.init({ print: false })

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("session.compaction.isOverflow", () => {
  test("returns true when token count exceeds usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when token count within usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("includes cache.read in token count", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 50_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("respects input limit for input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

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

  test("returns false when output within limit with input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

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

  test("returns false when compaction.auto is disabled", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "openscience.json"),
          JSON.stringify({
            compaction: { auto: false },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

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

  test("respects config.compaction.fallbackContext for context=0 models", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ compaction: { fallbackContext: 8_000 } }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context 0 → fallback 8_000; output reserve = min(2_000, 32_000) = 2_000; usable = 6_000; trigger = 0.75*6_000 = 4_500
        const model = createModel({ context: 0, output: 2_000 })
        const over = { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens: over, model })).toBe(true)
        const under = { input: 3_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens: under, model })).toBe(false)
      },
    })
  })

  test("does not compact every turn when the window is smaller than the output reserve", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context 8k, output limit 0 → the 32k default output cap would exceed the
        // whole window, making `context - output` negative and isOverflow true for
        // ANY count (compact every turn). The reserve is capped at half (4k) → usable
        // 4k, trigger 0.75*4k = 3k.
        const model = createModel({ context: 8_000, output: 0 })
        const small = { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens: small, model })).toBe(false)
        const large = { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens: large, model })).toBe(true)
      },
    })
  })
})

describe("session.compaction circuit breaker", () => {
  const ineffective = (sid: string) => SessionCompaction.noteCompaction({ sessionID: sid, before: 100_000, reclaimed: 1_000 }) // 1%

  test("trips after N consecutive ineffective (<10%) compactions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "ses_a"
        expect(SessionCompaction.breakerTripped(sid)).toBe(false)
        ineffective(sid)
        ineffective(sid)
        expect(SessionCompaction.breakerTripped(sid)).toBe(false) // 2 < limit
        const last = ineffective(sid)
        expect(last.tripped).toBe(true) // 3rd trips
        expect(SessionCompaction.breakerTripped(sid)).toBe(true)
      },
    })
  })

  test("an effective compaction resets the counter", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "ses_b"
        ineffective(sid)
        ineffective(sid)
        SessionCompaction.noteCompaction({ sessionID: sid, before: 100_000, reclaimed: 50_000 }) // 50% effective
        ineffective(sid)
        expect(SessionCompaction.breakerTripped(sid)).toBe(false) // counter was reset
      },
    })
  })

  test("exactly 10% reclaim counts as effective", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "ses_c"
        const r = SessionCompaction.noteCompaction({ sessionID: sid, before: 100_000, reclaimed: 10_000 })
        expect(r.tripped).toBe(false)
      },
    })
  })

  test("an unknown `before` does not increment the counter", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "ses_d"
        ineffective(sid)
        ineffective(sid)
        SessionCompaction.noteCompaction({ sessionID: sid, before: 0, reclaimed: 0 }) // unmeasurable → no-op
        SessionCompaction.noteCompaction({ sessionID: sid, before: undefined, reclaimed: 5 })
        expect(SessionCompaction.breakerTripped(sid)).toBe(false) // still only 2 ineffective
        ineffective(sid)
        expect(SessionCompaction.breakerTripped(sid)).toBe(true) // now 3
      },
    })
  })

  test("resetBreaker clears a tripped session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "ses_e"
        ineffective(sid)
        ineffective(sid)
        ineffective(sid)
        expect(SessionCompaction.breakerTripped(sid)).toBe(true)
        SessionCompaction.resetBreaker(sid)
        expect(SessionCompaction.breakerTripped(sid)).toBe(false)
      },
    })
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("session.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("does not subtract cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles reasoning tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 100,
      },
    })

    expect(result.tokens.reasoning).toBe(100)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })
})

describe("session.compaction.previousSummary", () => {
  const asstSummary = (id: string, text: string): MessageV2.WithParts =>
    ({
      info: {
        id,
        sessionID: "s",
        role: "assistant",
        summary: true,
        finish: "stop",
        parentID: "p",
        modelID: "m",
        providerID: "p",
        mode: "",
        agent: "compaction",
        path: { cwd: "/", root: "/" },
        cost: 0,
        time: { created: 0 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "t", sessionID: "s", messageID: id, type: "text", text } as unknown as MessageV2.Part],
    }) as unknown as MessageV2.WithParts
  const userMsg = (id: string): MessageV2.WithParts =>
    ({
      info: {
        id,
        sessionID: "s",
        role: "user",
        time: { created: 0 },
        agent: "a",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ id: "u", sessionID: "s", messageID: id, type: "text", text: "hi" } as unknown as MessageV2.Part],
    }) as unknown as MessageV2.WithParts

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
