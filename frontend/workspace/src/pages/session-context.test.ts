import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@synsci/sdk/v2/client"
import {
  DEFAULT_WARN_TOKENS,
  compactContextTokens,
  contextWarning,
  formatContextTokens,
  latestContext,
  usageSample,
} from "./session-context"

const user = (id: string, created: number): UserMessage =>
  ({
    id,
    sessionID: "ses",
    role: "user",
    time: { created },
    agent: "research",
    model: { providerID: "p", modelID: "m" },
  }) as UserMessage

const assistant = (
  id: string,
  tokens: { input: number; output: number; read?: number; write?: number },
  time: { created: number; completed?: number },
): AssistantMessage =>
  ({
    id,
    sessionID: "ses",
    role: "assistant",
    time,
    parentID: "u",
    modelID: "m",
    providerID: "p",
    mode: "research",
    agent: "research",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
    },
  }) as AssistantMessage

describe("session context samples", () => {
  test("usage comes from the newest assistant turn with reported tokens, cached input counted once", () => {
    const messages: Message[] = [
      user("u1", 1),
      assistant("a1", { input: 50_000, output: 1_000 }, { created: 2, completed: 3 }),
      user("u2", 4),
      assistant("a2", { input: 500, output: 200, read: 120_000, write: 300 }, { created: 5, completed: 9 }),
      user("u3", 10),
      assistant("a3", { input: 0, output: 0 }, { created: 11 }),
    ]
    expect(usageSample(messages)).toEqual({ total: 121_000, at: 9, source: "usage" })
    expect(usageSample([user("u1", 1)])).toBeUndefined()
  })

  test("the live pre-call estimate wins only while it is newer than the last finished turn", () => {
    const messages: Message[] = [assistant("a1", { input: 90_000, output: 2_000 }, { created: 2, completed: 3 })]
    const stale = { total: 40_000, at: 1, source: "estimate" as const }
    const fresh = { total: 130_000, at: 8, source: "estimate" as const }
    expect(latestContext(messages, stale)).toEqual({ total: 92_000, at: 3, source: "usage" })
    expect(latestContext(messages, fresh)).toBe(fresh)
    expect(latestContext([], fresh)).toBe(fresh)
    expect(latestContext([])).toBeUndefined()
  })

  test("the warning fires strictly above warn_tokens and never while compacting", () => {
    expect(DEFAULT_WARN_TOKENS).toBe(120_000)
    expect(contextWarning({ tokens: undefined, warn: 120_000 })).toBe(false)
    expect(contextWarning({ tokens: 120_000, warn: 120_000 })).toBe(false)
    expect(contextWarning({ tokens: 120_001, warn: 120_000, status: "busy" })).toBe(true)
    expect(contextWarning({ tokens: 120_001, warn: 120_000, status: "compacting" })).toBe(false)
    expect(contextWarning({ tokens: 20_001, warn: 20_000, status: "idle" })).toBe(true)
  })

  test("token labels are locale formatted", () => {
    expect(formatContextTokens(128_432, "en")).toBe("128,432")
    expect(compactContextTokens(128_432, "en")).toBe("128.4K")
    expect(compactContextTokens(950, "en")).toBe("950")
  })
})
