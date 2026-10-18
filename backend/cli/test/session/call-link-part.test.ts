import { expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

const base = {
  id: "prt_1",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "step-finish" as const,
  reason: "stop",
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("step-finish keeps the call and hold", () => {
  const part = MessageV2.StepFinishPart.parse({
    ...base,
    usage: { route: "managed", provider: "openrouter", model: "m", time: 1, call: "c-1", hold: "orgh_abc" },
  })
  expect(part.usage).toMatchObject({ call: "c-1", hold: "orgh_abc" })
})

test("older step-finish parts without the fields still parse", () => {
  const part = MessageV2.StepFinishPart.parse({
    ...base,
    usage: { route: "byok", provider: "openai", model: "m", time: 1 },
  })
  expect(part.usage?.call).toBeUndefined()
})

test("step-finish preserves unknown provider fields separately from accounting zeros", () => {
  const reported = {
    input_tokens: 12,
    output_tokens: 2,
    total_tokens: null,
    reasoning_tokens: null,
    cached_input_tokens: 0,
    cache_creation_input_tokens: null,
  }
  const part = MessageV2.StepFinishPart.parse({
    ...base,
    usage: {
      route: "byok",
      provider: "openai",
      model: "m",
      time: 1,
      reported,
      reportedCostUSD: null,
      cost: { source: "catalog_estimate", amountUSD: 0.0001 },
    },
  })
  expect(part.usage?.reported).toEqual(reported)
  expect(part.usage?.reportedCostUSD).toBeNull()
  expect(part.usage?.cost).toEqual({ source: "catalog_estimate", amountUSD: 0.0001 })
  expect(part.tokens.reasoning).toBe(0)
})
