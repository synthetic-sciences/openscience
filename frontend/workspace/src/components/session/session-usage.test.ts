import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, ToolPart, UserMessage } from "@synsci/sdk/v2/client"
import { sessionCost, sessionCostFormatter, sessionProviderLabel } from "./session-usage"

const assistant = (id: string, cost: number): AssistantMessage => ({
  id,
  sessionID: "session",
  role: "assistant",
  time: { created: 1 },
  parentID: "user",
  modelID: "openai/gpt-6-sol",
  providerID: "openrouter",
  mode: "research",
  agent: "research",
  path: { cwd: "/", root: "/" },
  cost,
  tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
})

const task = (id: string, cost: unknown): ToolPart => ({
  id,
  sessionID: "session",
  messageID: "lead",
  type: "tool",
  tool: "task",
  callID: id,
  state: {
    status: "completed",
    input: {},
    output: "Done",
    title: "Worker",
    metadata: { usage: { cost } },
    time: { start: 1, end: 2 },
  },
})

describe("recorded session costs", () => {
  test("includes lead turns and completed direct worker turns exactly once", () => {
    const messages = [assistant("lead", 0.00031), assistant("next", 0.00052)]
    const parts: Record<string, Part[]> = {
      lead: [task("worker", 0.00023), { ...task("other-tool", 9), tool: "bash" }],
      next: [{ ...task("running", 10), state: { status: "running", input: {}, time: { start: 1 } } }],
      unrelated: [task("another-session", 100)],
    }
    const cost = sessionCost(messages, parts)
    expect(cost.lead).toBeCloseTo(0.00083, 10)
    expect(cost.workers).toBe(0.00023)
    expect(cost.total).toBeCloseTo(0.00106, 10)
    expect(sessionCostFormatter("en-US").format(cost.total)).toBe("$0.00106")
  })

  test("missing or invalid amounts do not create additional charges", () => {
    const messages = [assistant("lead", 0), assistant("invalid", NaN)]
    const parts = { lead: [undefined, "0.2", NaN, Infinity, -1].map((cost, index) => task(String(index), cost)) }
    expect(sessionCost(messages, parts)).toEqual({ lead: 0, workers: 0, total: 0 })
    expect(sessionCost([], {})).toEqual({ lead: 0, workers: 0, total: 0 })
  })

  test("formats sub-cent usage with locale-aware precision", () => {
    const usd = sessionCostFormatter("en-US")
    expect(usd.format(0)).toBe("$0.00")
    expect(usd.format(1.2)).toBe("$1.20")
    expect(usd.format(0.00000317)).toBe("$0.00000317")
    expect(sessionCostFormatter("de-DE").format(0.00106)).toContain("0,00106")
  })
})

describe("recorded inference access", () => {
  const prompt = (source: NonNullable<UserMessage["inference"]>["source"]) => ({ inference: { source, effort: "low" } })
  const message = { providerID: "openrouter" }

  test("managed history remains Ace after changing to a provider key", () => {
    expect(sessionProviderLabel(message, prompt("managed"), { name: "OpenRouter", source: "api" })).toBe("Ace")
    expect(sessionProviderLabel(message, prompt("managed"), undefined)).toBe("Ace")
  })

  test("provider-key and subscription history keep their recorded distinction", () => {
    expect(sessionProviderLabel(message, prompt("byok"), { name: "OpenRouter", source: "managed" })).toBe("OpenRouter")
    expect(sessionProviderLabel(message, prompt("chatgpt"), undefined)).toBe("ChatGPT")
    expect(sessionProviderLabel(message, prompt("unknown"), undefined)).toBe("openrouter")
  })

  test("legacy messages fall back to the current provider's explicit access", () => {
    expect(sessionProviderLabel(message, undefined, { name: "OpenRouter", source: "managed" })).toBe("Ace")
    expect(sessionProviderLabel(message, undefined, { name: "OpenRouter", source: "api" })).toBe("OpenRouter")
    expect(sessionProviderLabel(message, undefined, undefined)).toBe("openrouter")
  })
})
