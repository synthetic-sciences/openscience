import { describe, expect, test } from "bun:test"
import { normalizedTier, promptTier } from "./model-tier"
import { resolveModelAccessRoute, type ModelAccessRoute } from "./model-route-resolution"

const managed: ModelAccessRoute = {
  providerID: "openrouter",
  modelID: "openai/gpt-5.6-sol",
  access: "managed",
}
const byok: ModelAccessRoute = {
  providerID: "openai",
  modelID: "gpt-5.6-sol",
  access: "byok",
}
const chatgpt: ModelAccessRoute = {
  providerID: "openai-codex",
  modelID: "gpt-5.6-sol",
  access: "chatgpt",
}

describe("exact model access route resolution", () => {
  test("Automatic deterministically chooses a connected ChatGPT Sol route", () => {
    const routes = [managed, byok, chatgpt]

    expect(resolveModelAccessRoute({ routes, billing: null })).toBe(chatgpt)
    expect(resolveModelAccessRoute({ routes, billing: undefined })).toBe(chatgpt)
  })

  test("Credits stays managed and Accounts stays on a connected user route", () => {
    const routes = [managed, byok, chatgpt]

    expect(resolveModelAccessRoute({ routes, billing: "managed" })).toBe(managed)
    expect(resolveModelAccessRoute({ routes, billing: "byok" })).toBe(byok)
    expect(resolveModelAccessRoute({ routes: [managed, chatgpt], billing: "byok" })).toBe(chatgpt)
    expect(resolveModelAccessRoute({ routes: [managed], billing: "byok" })).toBeUndefined()
  })

  test("enabling Fast changes only the tier and preserves the exact route", () => {
    const routes = [managed, chatgpt]
    const route = resolveModelAccessRoute({ routes, billing: null })!
    const state = { route, tier: "standard" }
    const fast = { ...state, tier: normalizedTier("fast", ["fast"]) }

    expect(fast.route).toBe(chatgpt)
    expect(promptTier(fast.tier, ["fast"])).toBe("fast")
    expect(resolveModelAccessRoute({ routes, billing: null, current: fast.route })).toBe(chatgpt)
  })

  test("an existing exact route is never replaced by a logical sibling", () => {
    const routes = [managed, byok, chatgpt]

    expect(resolveModelAccessRoute({ routes, billing: "managed", current: chatgpt })).toBe(chatgpt)
    expect(resolveModelAccessRoute({ routes, billing: null, current: managed })).toBe(managed)
  })
})
