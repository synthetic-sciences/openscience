import { expect, test } from "bun:test"
import { PromptInput, RuntimePromptInput } from "../../src/session/prompt-input"

const base = { sessionID: "ses_0000000000000000000000000", parts: [] }

test("an HTTP prompt request may only turn tools off", () => {
  expect(PromptInput.safeParse({ ...base, tools: { "*": false, bash: false } }).success).toBe(true)
  expect(PromptInput.safeParse({ ...base, tools: { network: true } }).success).toBe(false)
  expect(PromptInput.safeParse({ ...base, tools: { bash: true, edit: false } }).success).toBe(false)
  expect(PromptInput.safeParse(base).success).toBe(true)
  // In-process callers (session wake-ups replaying a turn) keep the full map.
  expect(RuntimePromptInput.safeParse({ ...base, tools: { fixture: true } }).success).toBe(true)
})
