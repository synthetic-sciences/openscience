import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

describe("SessionPrompt.modelTier", () => {
  const selected = { providerID: "openrouter", modelID: "anthropic/claude-opus-4.8" }

  test("keeps a tier when a command uses the selected model", () => {
    expect(SessionPrompt.modelTier("fast", selected, selected)).toBe("fast")
  })

  test("drops a tier when a command overrides the selected model", () => {
    expect(
      SessionPrompt.modelTier("fast", selected, {
        providerID: "anthropic",
        modelID: "claude-opus-4-8",
      }),
    ).toBeUndefined()
  })
})
