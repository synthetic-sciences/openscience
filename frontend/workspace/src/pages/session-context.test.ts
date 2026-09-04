import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@synsci/sdk/v2/client"
import { compactContextTokens, estimate, formatContextTokens, latestContext, usageSample } from "./session-context"

const user = (id: string): UserMessage =>
  ({
    id,
    sessionID: "ses",
    role: "user",
    time: { created: 1 },
    agent: "research",
    model: { providerID: "p", modelID: "m" },
  }) as UserMessage

const assistant = (
  id: string,
  tokens: { input: number; output: number; read?: number; write?: number },
  summary?: boolean,
): AssistantMessage =>
  ({
    id,
    sessionID: "ses",
    role: "assistant",
    time: { created: 1 },
    parentID: "u",
    modelID: "m",
    providerID: "p",
    mode: summary ? "compaction" : "research",
    agent: summary ? "compaction" : "research",
    ...(summary ? { summary } : {}),
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
    },
  }) as AssistantMessage

const pending = { input: 0, output: 0 }

describe("session context samples", () => {
  test("usage comes from the newest assistant turn with reported tokens, cached input counted once", () => {
    const messages: Message[] = [
      user("msg_01"),
      assistant("msg_02", { input: 50_000, output: 1_000 }),
      user("msg_03"),
      assistant("msg_04", { input: 500, output: 200, read: 120_000, write: 300 }),
      user("msg_05"),
      assistant("msg_06", pending),
    ]
    expect(usageSample(messages)).toEqual({ total: 121_000, source: "usage" })
    expect(usageSample([user("msg_01")])).toBeUndefined()
  })

  test("a compaction summary is a boundary: its usage describes the head it replaced", () => {
    const compacted: Message[] = [
      user("msg_01"),
      assistant("msg_02", { input: 150_000, output: 1_000 }),
      user("msg_03"),
      assistant("msg_04", { input: 150_000, output: 3_000 }, true),
    ]
    expect(usageSample(compacted)).toBeUndefined()
    expect(latestContext(compacted, { total: 151_000, after: "msg_02" })).toBeUndefined()
    // Nothing is known until the next turn: first its estimate, then its reported usage.
    const resumed: Message[] = [...compacted, user("msg_05"), assistant("msg_06", pending)]
    expect(latestContext(resumed)).toBeUndefined()
    expect(latestContext(resumed, { total: 24_000, after: "msg_06" })).toEqual({ total: 24_000, source: "estimate" })
    const reported: Message[] = [...resumed.slice(0, -1), assistant("msg_06", { input: 20_000, output: 500 })]
    expect(usageSample(reported)).toEqual({ total: 20_500, source: "usage" })
  })

  test("the live estimate is ordered by message id, never by comparing clocks", () => {
    const inflight: Message[] = [
      user("msg_01"),
      assistant("msg_02", { input: 90_000, output: 2_000 }),
      user("msg_03"),
      assistant("msg_04", pending),
    ]
    // Anchored on the in-flight turn, the estimate wins while that turn has no usage...
    const live = estimate(inflight, 130_000)
    expect(live).toEqual({ total: 130_000, after: "msg_04" })
    expect(latestContext(inflight, live)).toEqual({ total: 130_000, source: "estimate" })
    // ...and yields as soon as the same message reports.
    const done: Message[] = [...inflight.slice(0, -1), assistant("msg_04", { input: 128_000, output: 900 })]
    expect(latestContext(done, live)).toEqual({ total: 128_900, source: "usage" })
    // An estimate anchored before the last finished turn is stale.
    expect(latestContext(done, { total: 40_000, after: "msg_01" })).toEqual({ total: 128_900, source: "usage" })
    expect(latestContext([], live)).toEqual({ total: 130_000, source: "estimate" })
    expect(latestContext([])).toBeUndefined()
    expect(estimate([], 10)).toEqual({ total: 10, after: "" })
  })

  test("token labels are locale formatted", () => {
    expect(formatContextTokens(128_432, "en")).toBe("128,432")
    expect(compactContextTokens(128_432, "en")).toBe("128.4K")
    expect(compactContextTokens(950, "en")).toBe("950")
  })
})
