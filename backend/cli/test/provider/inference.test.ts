import { expect, test } from "bun:test"
import { Inference } from "../../src/provider/inference"

test("classifies the observable inference route without exposing credentials", () => {
  expect(Inference.classify({ providerID: "synsci" })).toBe("managed")
  expect(Inference.classify({ providerID: "openai-codex", auth: "oauth" })).toBe("chatgpt")
  expect(
    Inference.classify({
      providerID: "ollama",
      providerSource: "config",
      baseURL: "http://localhost:11434/v1",
    }),
  ).toBe("local")
  expect(Inference.classify({ providerID: "openrouter", billing: "managed", providerSource: "env" })).toBe("managed")
  expect(Inference.classify({ providerID: "anthropic", providerSource: "api", auth: "api" })).toBe("byok")
  expect(Inference.classify({ providerID: "github-copilot", providerSource: "custom", auth: "oauth" })).toBe("oauth")
  expect(Inference.classify({ providerID: "custom", providerSource: "custom" })).toBe("unknown")
  // Auto-detect (billing.llm unset/null): no explicit "managed" opt-in, so the
  // billing === "managed" shortcut above doesn't fire, and there's no stored
  // own key (no `auth`) — the route is still genuinely managed (a synced thk_
  // token, no BYOK key), and provider.source already says so. Must not fall
  // through to "unknown".
  expect(Inference.classify({ providerID: "openrouter", providerSource: "managed" })).toBe("managed")
})
