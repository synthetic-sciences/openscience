import { expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { CodexAuthPlugin } from "../../src/plugin/codex"

// The fixed subscription endpoint cannot be replaced by a local base URL;
// substitute only its HTTP boundary while exercising the real auth loader.
test("ChatGPT uses its own token while a separate OpenAI API key remains connected", async () => {
  const previous = {
    api: await Auth.get("openai"),
    subscription: await Auth.get("openai-codex"),
    fetch: globalThis.fetch,
  }
  await Auth.set("openai", { type: "api", key: "sk-expired-api-fixture" })
  await Auth.set("openai-codex", {
    type: "oauth",
    access: "subscription-fixture",
    refresh: "refresh-fixture",
    expires: Date.now() + 3600000,
  })
  const calls: string[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push(String(input))
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer subscription-fixture")
    return new Response("answer")
  }) as typeof fetch
  try {
    const plugin = await CodexAuthPlugin()
    const options = await plugin.auth!.loader!(() => Auth.get("openai-codex"), {
      id: "openai-codex",
      name: "ChatGPT",
      source: "custom",
      env: [],
      options: {},
      models: {},
    })
    const send = options.fetch as (input: string, init: RequestInit) => Promise<Response>
    const result = await send("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer sk-expired-api-fixture" },
      body: JSON.stringify({ model: "gpt-6.1-sol", input: [] }),
    })
    expect(await result.text()).toBe("answer")
    expect(calls).toEqual(["https://chatgpt.com/backend-api/codex/responses"])
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "sk-expired-api-fixture" })
  } finally {
    globalThis.fetch = previous.fetch
    if (previous.api) await Auth.set("openai", previous.api)
    else await Auth.remove("openai")
    if (previous.subscription) await Auth.set("openai-codex", previous.subscription)
    else await Auth.remove("openai-codex")
  }
})
