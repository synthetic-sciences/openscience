import { expect, test } from "bun:test"

const managed = await Bun.file(new URL("./settings/ManagedInference.tsx", import.meta.url)).text()
const keys = await Bun.file(new URL("./settings/ProviderKeys.tsx", import.meta.url)).text()
const setup = await Bun.file(new URL("../atlas/SetupDialog.tsx", import.meta.url)).text()
const providers = await Bun.file(new URL("./settings/model-providers.ts", import.meta.url)).text()

test("shares the complete provider-key catalog across setup and settings", () => {
  expect(managed).toContain('title: "BYOK / Subscription"')
  expect(managed).toContain('title: "Managed"')
  expect(managed).toContain("Use your Ace balance")
  expect(keys).toContain('from "./model-providers"')
  expect(keys).not.toContain("const PROVIDERS")
  expect(setup).not.toContain("const BYOK_PROVIDERS")
  expect(setup).toContain("Synthetic Sciences API key")
  expect(setup).toContain('"/account/login-key"')
  expect(setup).not.toContain("ChatGPT / Codex")
  expect(setup).not.toContain("model-providers")
  expect(managed).not.toContain("OpenRouter")

  for (const label of [
    "OpenAI",
    "Anthropic",
    "Google Gemini",
    "xAI",
    "Meta Model API",
    "OpenRouter",
    "Together AI",
    "Groq",
    "Fireworks AI",
    "Mistral",
    "DeepSeek",
    "Cerebras",
    "Perplexity",
  ]) {
    expect(providers).toContain(`label: "${label}"`)
  }
})
