import { expect, test } from "bun:test"
import { Inference } from "../../src/provider/inference"

test("classifies the observable inference route without exposing credentials", () => {
  expect(Inference.classify({ providerID: "synsci", providerSource: "custom" })).toBe("unknown")
  expect(Inference.classify({ providerID: "openai-codex", auth: "oauth" })).toBe("chatgpt")
  expect(
    Inference.classify({
      providerID: "ollama",
      providerSource: "config",
      baseURL: "http://localhost:11434/v1",
    }),
  ).toBe("local")
  expect(Inference.classify({ providerID: "openrouter", providerSource: "env" })).toBe("byok")
  expect(Inference.classify({ providerID: "anthropic", providerSource: "api", auth: "api" })).toBe("byok")
  expect(Inference.classify({ providerID: "github-copilot", providerSource: "custom", auth: "oauth" })).toBe("oauth")
  expect(Inference.classify({ providerID: "custom", providerSource: "custom" })).toBe("unknown")
})
