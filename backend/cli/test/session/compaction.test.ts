import { describe, expect, test } from "bun:test"
import path from "path"
import { existsSync } from "node:fs"
import { SessionCompaction } from "../../src/session/compaction"
import { Config } from "../../src/config/config"
import { Token } from "../../src/util/token"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import type { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Identifier } from "../../src/id/id"
import { SessionLoopState } from "../../src/session/loop-state"
import { Bus } from "../../src/bus"

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

async function withSession<T>(directory: string, fn: (session: Session.Info) => Promise<T>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const session = await Session.create({})
      return fn(session).finally(() => Session.remove(session.id))
    },
  })
}

async function finishSummary(input: {
  session: Session.Info
  carrier: MessageV2.User
  text: string
  step?: number
  finish?: string
}) {
  const id = await MessageV2.nextMessageID(input.session.id)
  const message = await Session.updateMessage({
    id,
    sessionID: input.session.id,
    parentID: input.carrier.id,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    mode: "compaction",
    agent: "compaction",
    path: { cwd: Instance.worktree, root: Instance.worktree },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test",
    internal: { step: input.step ?? 1 },
    finish: input.finish ?? "stop",
    summary: true,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.session.id,
    type: "text",
    text: input.text,
  })
  return message
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

  test("settings resolve defaults and config overrides from one place", async () => {
    expect(SessionCompaction.settings({})).toEqual({
      auto: true,
      threshold: SessionCompaction.DEFAULT_THRESHOLD,
      warn_tokens: SessionCompaction.DEFAULT_WARN_TOKENS,
    })
    expect(SessionCompaction.DEFAULT_WARN_TOKENS).toBe(120_000)
    expect(SessionCompaction.settings({ compaction: { auto: false, threshold: 0.5, warn_tokens: 80_000 } })).toEqual({
      auto: false,
      threshold: 0.5,
      warn_tokens: 80_000,
    })
  })

  test("config.compaction.warn_tokens is advisory and never changes the overflow trigger", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ compaction: { warn_tokens: 1_000 } }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        // usable = 68_000; count = 40_000 is under 0.75*68_000=51_000, so no overflow even
        // though the conversation is far above the 1_000-token warning.
        const tokens = { input: 35_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
        expect(SessionCompaction.settings(await Config.get()).warn_tokens).toBe(1_000)
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
  const ineffective = (sid: string) =>
    SessionCompaction.noteCompaction({ sessionID: sid, before: 100_000, reclaimed: 1_000 }) // 1%

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

  test("does not estimate multilingual prompts as sparse English text", () => {
    expect(Token.estimate("你好世界")).toBe(4)
    expect(Token.estimate("abcd你")).toBe(2)
    expect(Token.estimate("😀")).toBe(2)
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
  const asstSummary = (
    id: string,
    text: string,
    input?: { finish?: string; error?: MessageV2.Assistant["error"] },
  ): MessageV2.WithParts =>
    ({
      info: {
        id,
        sessionID: "s",
        role: "assistant",
        summary: true,
        finish: input?.finish ?? "stop",
        error: input?.error,
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
  test("ignores truncated and failed summaries when selecting a prior handoff", () => {
    const msgs = [
      asstSummary("a1", "LAST VERIFIED HANDOFF"),
      asstSummary("a2", "TRUNCATED HANDOFF", { finish: "length" }),
      asstSummary("a3", "FAILED HANDOFF", {
        error: { name: "UnknownError", data: { message: "summary rejected" } },
      }),
    ]
    expect(SessionCompaction.previousSummary(msgs)).toBe("LAST VERIFIED HANDOFF")
  })
})

describe("session.compaction.buildHandoffPrompt", () => {
  test("no prior summary → create prompt with the section structure", () => {
    const p = SessionCompaction.buildHandoffPrompt({})
    expect(p).toContain("## Objective")
    expect(p).toContain("### Delegated evidence")
    expect(p).toContain("Preserve this even when the original Task output was reduced")
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

describe("session.compaction.persistHandoff", () => {
  test("the compaction carrier preserves prior controls and applies explicit command controls", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const source = await Session.updateMessage({
        id: await MessageV2.nextMessageID(session.id),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        effort: "normal",
        tools: { task: false },
        delegation: false,
        variant: "careful",
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: source.id,
        sessionID: session.id,
        type: "text",
        text: "preserve my controls",
      })
      await SessionCompaction.create({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        effort: "ultra",
        delegation: true,
        auto: false,
        handoffFile: "",
      })
      const messages = await Session.messages({ sessionID: session.id })
      const marker = messages.flatMap((message) => message.parts).find((part) => part.type === "compaction")
      const carrier = messages.find((message) => message.parts.includes(marker!))
      expect(marker?.type).toBe("compaction")
      if (marker?.type !== "compaction") throw new Error("missing compaction marker")
      expect(marker.handoffFile).toBe("")
      expect(carrier?.info.role).toBe("user")
      if (carrier?.info.role !== "user") throw new Error("missing compaction carrier")
      expect(carrier.info.internal).toEqual({
        type: "compaction",
        auto: false,
        epoch: carrier.info.id,
        transaction: carrier.info.id,
        handoffFile: "",
      })
      expect(carrier.info.tools).toEqual({ task: false })
      expect(carrier.info.effort).toBe("ultra")
      expect(carrier.info.delegation).toBe(true)
      expect(carrier.info.variant).toBe("careful")
    })
  })

  test("ordinary and automatic compaction never create project handoff files", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      await SessionCompaction.persistHandoff({
        root: tmp.path,
        sessionID: session.id,
        summary: "durable transcript summary",
        file: undefined,
      })
    })

    expect(existsSync(path.join(tmp.path, ".openscience", "handoffs"))).toBe(false)
  })

  test("an explicit handoff with no path writes the managed per-session file", async () => {
    await using tmp = await tmpdir()
    const sessionID = await withSession(tmp.path, async (session) => {
      await SessionCompaction.persistHandoff({
        root: tmp.path,
        sessionID: session.id,
        summary: "handoff body",
        file: "",
      })
      return session.id
    })

    const dir = path.join(tmp.path, ".openscience", "handoffs")
    expect(await Bun.file(path.join(dir, `${sessionID}.md`)).text()).toBe("handoff body\n")
    expect(await Bun.file(path.join(dir, ".gitignore")).text()).toBe("*\n")
  })

  test("an explicit handoff path writes only the requested project file", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      await SessionCompaction.persistHandoff({
        root: tmp.path,
        sessionID: session.id,
        summary: "custom handoff",
        file: "notes/next.md",
      })
    })

    expect(await Bun.file(path.join(tmp.path, "notes", "next.md")).text()).toBe("custom handoff\n")
    expect(existsSync(path.join(tmp.path, ".openscience", "handoffs"))).toBe(false)
  })

  test("an explicit handoff surfaces a missing write grant without creating a file", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (owner) => {
      const sibling = await Session.create({})
      await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(sibling.id) }
      const root = await SessionFilesystem.workspace(sibling.id)
      await expect(
        SessionCompaction.persistHandoff({
          root,
          sessionID: owner.id,
          summary: "must not cross the private boundary",
          file: "handoff.md",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      expect(existsSync(path.join(root, "handoff.md"))).toBe(false)
    })
  })
})

describe("session.compaction durable finalization", () => {
  test("replays an explicit handoff idempotently after a summary/finalization boundary", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      await SessionCompaction.create({
        sessionID: session.id,
        agent: "research",
        model: { providerID: "test", modelID: "test-model" },
        auto: false,
        handoffFile: "notes/next.md",
        trigger: "manual",
      })
      const created = await Session.messages({ sessionID: session.id })
      const carrier = created.find(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
          message.info.role === "user" && message.info.internal?.type === "compaction",
      )
      if (!carrier || carrier.info.internal?.type !== "compaction") throw new Error("missing carrier")
      carrier.info.internal.before = 100
      carrier.info.internal.headTokens = 80
      await Session.updateMessage(carrier.info)
      await finishSummary({ session, carrier: carrier.info, text: "durable handoff" })

      const pending = SessionLoopState.pendingCompaction(await Session.messages({ sessionID: session.id }))
      if (!pending) throw new Error("missing pending finalization")
      await SessionCompaction.recover(pending)
      await SessionCompaction.recover(pending)

      expect(await Bun.file(path.join(tmp.path, "notes", "next.md")).text()).toBe("durable handoff\n")
      const stored = await Session.messages({ sessionID: session.id })
      const finalized = stored
        .find((message) => message.info.id === carrier.info.id)
        ?.parts.filter((part) => part.id === SessionLoopState.partID(carrier.info.id, "finalization"))
      expect(finalized).toHaveLength(1)
      expect(SessionLoopState.pendingCompaction(stored)).toBeUndefined()
      expect(SessionLoopState.breaker(stored, 0.1)).toBe(0)
    })
  })

  test("recovers exactly one automatic continuation past ignored notices", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const model = { providerID: "test", modelID: "test-model" }
      const sourceID = await MessageV2.nextMessageID(session.id)
      const source = await Session.updateMessage({
        id: sourceID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model,
        effort: "normal",
        internal: SessionLoopState.prompt(sourceID),
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: source.id,
        sessionID: session.id,
        type: "text",
        text: "continue this research",
      })
      await SessionCompaction.create({
        sessionID: session.id,
        agent: "research",
        model,
        auto: true,
        epoch: source.id,
        trigger: "proactive",
      })
      const created = await Session.messages({ sessionID: session.id })
      const carrier = created.find(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
          message.info.role === "user" && message.info.internal?.type === "compaction",
      )
      if (!carrier || carrier.info.internal?.type !== "compaction") throw new Error("missing carrier")
      carrier.info.internal.before = 100
      carrier.info.internal.headTokens = 10
      await Session.updateMessage(carrier.info)
      await finishSummary({ session, carrier: carrier.info, text: "brief" })

      const first = SessionLoopState.pendingCompaction(await Session.messages({ sessionID: session.id }))
      if (!first) throw new Error("missing pending compaction")
      // Simulate a process exit after durable finalization but before queuing
      // the synthetic continuation.
      await Session.updatePart({
        id: SessionLoopState.partID(carrier.info.id, "finalization"),
        messageID: carrier.info.id,
        sessionID: session.id,
        type: "text",
        text: "",
        synthetic: true,
        ignored: true,
        metadata: SessionLoopState.compactionFinalized({
          transaction: carrier.info.id,
          summaryID: first.summary.info.id,
          trigger: "proactive",
          before: 100,
          reclaimed: 10 - Token.estimate("brief"),
        }),
      })

      const noticeID = await MessageV2.nextMessageID(session.id)
      await Session.updateMessage({
        id: noticeID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model,
        effort: "normal",
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: noticeID,
        sessionID: session.id,
        type: "text",
        text: "/status",
        ignored: true,
      })
      const reportID = await MessageV2.nextMessageID(session.id)
      await Session.updateMessage({
        id: reportID,
        sessionID: session.id,
        parentID: noticeID,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        mode: "research",
        agent: "research",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        finish: "stop",
      })

      SessionCompaction.resetBreaker(session.id)
      const interrupted = await Session.messages({ sessionID: session.id })
      expect(SessionCompaction.restoreBreaker(session.id, interrupted)).toEqual({ count: 1, tripped: false })
      const pending = SessionLoopState.pendingCompaction(interrupted)
      expect(pending).toMatchObject({ finalized: true, continuation: true })
      if (!pending) throw new Error("missing continuation recovery")
      await SessionCompaction.recover(pending)
      await SessionCompaction.recover(pending)

      const stored = await Session.messages({ sessionID: session.id })
      const continuations = stored.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.internal?.type === "continuation" &&
          message.info.internal.kind === "compaction",
      )
      expect(continuations).toHaveLength(1)
      expect(continuations[0]?.parts).toEqual([
        expect.objectContaining({
          id: SessionLoopState.partID(continuations[0]!.info.id, "continuation"),
          type: "text",
          synthetic: true,
        }),
      ])
      expect(SessionLoopState.pendingCompaction(stored)).toBeUndefined()
      expect(SessionLoopState.incomplete(stored)).toHaveLength(0)
    })
  })

  test("makes an empty completed summary terminal exactly once after restart", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const model = { providerID: "test", modelID: "test-model" }
      const sourceID = await MessageV2.nextMessageID(session.id)
      const source = await Session.updateMessage({
        id: sourceID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model,
        effort: "normal",
        internal: SessionLoopState.prompt(sourceID),
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: source.id,
        sessionID: session.id,
        type: "text",
        text: "important original context",
      })
      await SessionCompaction.create({
        sessionID: session.id,
        agent: "research",
        model,
        auto: true,
        epoch: source.id,
        trigger: "proactive",
      })
      const created = await Session.messages({ sessionID: session.id })
      const carrier = created.find(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
          message.info.role === "user" && message.info.internal?.type === "compaction",
      )
      if (!carrier) throw new Error("missing carrier")
      await finishSummary({ session, carrier: carrier.info, text: "" })

      const errors: MessageV2.Assistant["error"][] = []
      const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
        if (event.properties.sessionID === session.id) errors.push(event.properties.error)
      })
      const pending = SessionLoopState.pendingCompaction(await Session.messages({ sessionID: session.id }))
      if (!pending) throw new Error("missing empty summary")
      expect(await SessionCompaction.recover(pending)).toBe("stop")
      // A second startup/recovery pass sees the stored terminal error and does
      // not emit another failure or queue another action.
      expect(await SessionCompaction.recover(pending)).toBeUndefined()
      unsubscribe()

      const stored = await Session.messages({ sessionID: session.id })
      const summary = stored.find((message) => message.info.id === pending.summary.info.id)
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role !== "assistant") throw new Error("missing summary")
      expect(summary.info.error?.data.message).toContain("preserved the original context")
      expect(errors).toHaveLength(1)
      expect(SessionLoopState.pendingCompaction(stored)).toBeUndefined()
      expect(
        stored.filter(
          (message) =>
            message.info.role === "user" &&
            message.info.internal?.type === "continuation" &&
            message.info.internal.kind === "compaction",
        ),
      ).toHaveLength(0)
      expect(
        stored
          .find((message) => message.info.id === carrier.info.id)
          ?.parts.filter((part) => part.id === SessionLoopState.partID(carrier.info.id, "finalization")),
      ).toHaveLength(0)
      expect(
        (await MessageV2.filterCompacted(MessageV2.stream(session.id))).some(
          (message) => message.info.id === source.id,
        ),
      ).toBe(true)
      expect(SessionLoopState.terminalError({ user: carrier.info, assistant: summary.info })).toBe(true)
    })
  })

  test("does not finalize a handoff truncated by the model output limit", async () => {
    await using tmp = await tmpdir()
    await withSession(tmp.path, async (session) => {
      const model = { providerID: "test", modelID: "test-model" }
      const sourceID = await MessageV2.nextMessageID(session.id)
      const source = await Session.updateMessage({
        id: sourceID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model,
        effort: "normal",
        internal: SessionLoopState.prompt(sourceID),
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: source.id,
        sessionID: session.id,
        type: "text",
        text: "critical evidence that must survive compaction",
      })
      await SessionCompaction.create({
        sessionID: session.id,
        agent: "research",
        model,
        auto: true,
        epoch: source.id,
        trigger: "proactive",
      })
      const created = await Session.messages({ sessionID: session.id })
      const carrier = created.find(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
          message.info.role === "user" && message.info.internal?.type === "compaction",
      )
      if (!carrier) throw new Error("missing carrier")
      await finishSummary({
        session,
        carrier: carrier.info,
        text: "## Objective\n- partially emitted handoff",
        finish: "length",
      })

      const pending = SessionLoopState.pendingCompaction(await Session.messages({ sessionID: session.id }))
      if (!pending) throw new Error("missing truncated summary")
      expect(await SessionCompaction.recover(pending)).toBe("stop")

      const stored = await Session.messages({ sessionID: session.id })
      const summary = stored.find((message) => message.info.id === pending.summary.info.id)
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role !== "assistant") throw new Error("missing summary")
      expect(summary.info.error?.data.message).toContain("output limit")
      expect(
        stored
          .find((message) => message.info.id === carrier.info.id)
          ?.parts.filter((part) => part.id === SessionLoopState.partID(carrier.info.id, "finalization")),
      ).toHaveLength(0)
      expect(
        stored.filter(
          (message) =>
            message.info.role === "user" &&
            message.info.internal?.type === "continuation" &&
            message.info.internal.kind === "compaction",
        ),
      ).toHaveLength(0)
      expect(
        (await MessageV2.filterCompacted(MessageV2.stream(session.id))).some(
          (message) => message.info.id === source.id,
        ),
      ).toBe(true)
    })
  })
})

describe("session.compaction.selectTail", () => {
  const u = (id: string, text = "hi"): MessageV2.WithParts =>
    ({
      info: {
        id,
        sessionID: "s",
        role: "user",
        time: { created: 0 },
        agent: "a",
        model: { providerID: "p", modelID: "m" },
      } as unknown as MessageV2.WithParts["info"],
      parts: [{ id: `${id}p`, sessionID: "s", messageID: id, type: "text", text } as unknown as MessageV2.Part],
    }) as unknown as MessageV2.WithParts
  const a = (id: string, text: string): MessageV2.WithParts =>
    ({
      info: {
        id,
        sessionID: "s",
        role: "assistant",
        parentID: id.replace(/^a/, "u"),
        modelID: "m",
        providerID: "p",
        mode: "",
        agent: "a",
        summary: false,
        finish: "stop",
        cost: 0,
        time: { created: 0 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown as MessageV2.WithParts["info"],
      parts: [{ id: `${id}p`, sessionID: "s", messageID: id, type: "text", text } as unknown as MessageV2.Part],
    }) as unknown as MessageV2.WithParts

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

  test("messageTokens counts a non-image file (PDF) by payload size, not 0", () => {
    // toModelMessages ships the full base64; the tail budget must not see a big PDF as ~0.
    const url = "data:application/pdf;base64," + "A".repeat(4000)
    const pdf = {
      info: {
        id: "u1",
        sessionID: "s",
        role: "user",
        time: { created: 0 },
        agent: "a",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [
        { id: "u1f", sessionID: "s", messageID: "u1", type: "file", mime: "application/pdf", filename: "x.pdf", url },
      ],
    } as unknown as MessageV2.WithParts
    expect(SessionCompaction.messageTokens(pdf)).toBeGreaterThan(900)
  })

  test("messageTokens scores a compacted tool call as its 1-line summary, not the cleared body", () => {
    const tool = (compacted: boolean) =>
      ({
        info: {
          id: "a1",
          sessionID: "s",
          role: "assistant",
          parentID: "u",
          modelID: "m",
          providerID: "p",
          mode: "",
          agent: "a",
          summary: false,
          finish: "stop",
          cost: 0,
          time: { created: 0 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "a1t",
            sessionID: "s",
            messageID: "a1",
            type: "tool",
            tool: "bash",
            callID: "c1",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "z".repeat(40000),
              title: "ls",
              metadata: {},
              time: { start: 0, end: 1, ...(compacted ? { compacted: 2 } : {}) },
            },
          },
        ],
      }) as unknown as MessageV2.WithParts
    expect(SessionCompaction.messageTokens(tool(true))).toBeLessThan(SessionCompaction.messageTokens(tool(false)))
    expect(SessionCompaction.messageTokens(tool(true))).toBeLessThan(100) // ~1-line summary, not the 10k-token body
  })

  test("keeps the last REAL turn verbatim even when a trailing empty compaction carrier is the newest 'turn'", () => {
    const carrier = {
      info: {
        id: "cc",
        sessionID: "s",
        role: "user",
        time: { created: 0 },
        agent: "a",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ id: "ccp", sessionID: "s", messageID: "cc", type: "compaction", auto: true }],
    } as unknown as MessageV2.WithParts
    const big = "z".repeat(40000)
    const msgs = [u("u1"), a("a1", "x"), u("u2"), a("a2", big), carrier]
    const { tailStartId } = SessionCompaction.selectTail(msgs, { tailTurns: 1, tailTokens: 4000 })
    expect(tailStartId).toBe("u2") // the last REAL turn, not the empty carrier
  })

  test("keeps every queued unanswered user turn verbatim beyond the configured tail limit", () => {
    const carrier = {
      info: {
        id: "cc",
        sessionID: "s",
        role: "user",
        time: { created: 0 },
        agent: "a",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ id: "ccp", sessionID: "s", messageID: "cc", type: "compaction", auto: true }],
    } as unknown as MessageV2.WithParts
    const msgs = [u("u1"), a("a1", "answered"), u("u2", "first queued"), u("u3", "second queued"), carrier]

    const { tailStartId } = SessionCompaction.selectTail(msgs, { tailTurns: 1, tailTokens: 1 })

    expect(tailStartId).toBe("u2")
    expect(SessionCompaction.protectedContext(msgs, "cc").map((message) => message.info.id)).toEqual(["u2", "u3", "cc"])
  })
})
