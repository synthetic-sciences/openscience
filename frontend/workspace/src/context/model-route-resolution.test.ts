import { describe, expect, test } from "bun:test"
import { resolveModelAccessRoute, type ModelAccessRoute } from "./model-route-resolution"

const managed: ModelAccessRoute = {
  providerID: "openrouter",
  modelID: "openai/gpt-5.6-sol",
  access: "managed",
}
const byok: ModelAccessRoute = { providerID: "openai", modelID: "gpt-5.6-sol", access: "byok" }
const chatgpt: ModelAccessRoute = { providerID: "openai-codex", modelID: "gpt-5.6-sol", access: "chatgpt" }

describe("exact model access route resolution", () => {
  test("Automatic prefers connected ChatGPT, Ace stays managed, and BYOK stays direct", () => {
    const routes = [managed, byok, chatgpt]
    expect(resolveModelAccessRoute({ routes, billing: null })).toBe(chatgpt)
    expect(resolveModelAccessRoute({ routes, billing: "managed" })).toBe(managed)
    expect(resolveModelAccessRoute({ routes, billing: "byok" })).toBe(byok)
    expect(resolveModelAccessRoute({ routes: [managed], billing: "byok" })).toBeUndefined()
  })

  test("never swaps an existing exact route for a logical sibling", () => {
    const routes = [managed, byok, chatgpt]
    expect(resolveModelAccessRoute({ routes, billing: "managed", current: chatgpt })).toBe(chatgpt)
    expect(resolveModelAccessRoute({ routes, billing: null, current: managed })).toBe(managed)
  })
})
