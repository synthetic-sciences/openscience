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

test("a base URL without a scheme is still a local endpoint", () => {
  // "localhost:11434/v1" parses as a URL with the scheme "localhost:", so the
  // hostname never came out as "localhost" and the route was reported as byok.
  // LocalProvider.normalizeBaseURL accepts exactly this form, so the same
  // endpoint was local by one helper and a cloud key by the other.
  for (const baseURL of [
    "localhost:11434/v1",
    "127.0.0.1:1234",
    "LOCALHOST:11434",
    "[::1]:11434/v1",
    "http://[::1]:11434/v1",
  ]) {
    expect(Inference.classify({ providerID: "ollama", providerSource: "config", baseURL })).toBe("local")
  }
})

test("a remote base URL is not local, with or without a scheme", () => {
  for (const baseURL of [
    "https://api.openai.com/v1",
    "api.openai.com/v1",
    "https://localhost.evil.example/v1",
    "localhost@api.openai.com/v1",
  ]) {
    expect(Inference.classify({ providerID: "openai", providerSource: "api", baseURL, auth: "api" })).toBe("byok")
  }
})
