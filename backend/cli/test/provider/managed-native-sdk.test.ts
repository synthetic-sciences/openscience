import { expect, test } from "bun:test"
import { generateText } from "ai"
import { createXai } from "@ai-sdk/xai"
import { GlobalBus } from "../../src/bus/global"
import { MANAGED_MODEL_DETAILS, MANAGED_OPENROUTER_MODELS } from "../../src/provider/managed-catalog"

const key = "osk_fixture_native_sdk"
const organization = "org_native_sdk"
const calls: Array<{ url: string; headers: Headers; body: Record<string, any> }> = []
const headers = {
  "OpenScience-Funding-Protocol": "1",
  "OpenScience-Funding-Context": `organization:${organization}`,
}
const catalog = MANAGED_OPENROUTER_MODELS.map((id) => ({
  id,
  upstream_provider: id.startsWith("anthropic/")
    ? "anthropic"
    : id.startsWith("google/")
      ? "gemini"
      : id.startsWith("x-ai/")
        ? "xai"
        : id.startsWith("meta/")
          ? "meta"
          : "openrouter",
  context_length: MANAGED_MODEL_DETAILS[id].context,
  max_output_tokens: MANAGED_MODEL_DETAILS[id].output,
  pricing: { tiers: [{ input: 2, output: 6 }] },
  ...(id === "openai/gpt-5.6-sol"
    ? {
        fast_mode: true,
        fast_mode_details: {
          available: true,
          transport: { service_tier: "priority" },
          pricing: { verified: true, tiers: [{ input: 4, output: 12 }] },
        },
      }
    : {}),
  ...(id === "anthropic/claude-fable-5"
    ? {
        fast_mode: true,
        fast_mode_details: {
          available: true,
          transport: { speed: "fast" },
          pricing: { verified: true, tiers: [{ input: 20, output: 100 }] },
        },
      }
    : {}),
  ...(id === "anthropic/claude-haiku-4.5"
    ? { capabilities: { reasoning_efforts: [], thinking_budgets: [0, 4096, 8192, 16384, 32768] } }
    : {}),
  ...(id === "x-ai/grok-4.6"
    ? {
        capabilities: {
          reasoning_efforts: ["low", "medium", "high", "xhigh"],
          reasoning_default: "high",
        },
        fast_mode: true,
        fast_mode_details: {
          available: true,
          transport: { service_tier: "priority" },
          pricing: { verified: true, tiers: [{ input: 4, output: 12 }] },
        },
      }
    : {}),
}))
async function gateway(request: Request) {
  const url = new URL(request.url)
  if (url.pathname.endsWith("/model-catalog")) return Response.json({ models: catalog }, { headers })
  calls.push({
    url: url.pathname,
    headers: new Headers(request.headers),
    body: (await request.json()) as Record<string, any>,
  })
  if (url.pathname.endsWith("/chat/completions"))
    return Response.json(
      {
        id: "chat_fixture",
        created: 1,
        model: "grok-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      { headers },
    )
  if (url.pathname.endsWith("/messages"))
    return Response.json(
      {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      },
      { headers },
    )
  return Response.json(
    {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 5 },
    },
    { headers },
  )
}
const { tmpdir } = await import("../fixture/fixture")
const { OpenScience } = await import("../../src/openscience")
const { Provider } = await import("../../src/provider/provider")
const { ProviderTransform } = await import("../../src/provider/transform")
const { Instance } = await import("../../src/project/instance")

test("Ace keeps every curated model on the scoped OpenRouter transport", async () => {
  calls.length = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    expect(init?.redirect).toBe("error")
    return gateway(new Request(input, init))
  }) as typeof fetch
  try {
    await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
    await OpenScience.saveSession({
      api_key: key,
      user_id: "fixture",
      organization_id: organization,
      workspace_locked: true,
    })
    const refreshed = new Promise<void>((resolve) => {
      const listener = (event: { payload: { type: string } }) => {
        if (event.payload.type !== "global.disposed") return
        GlobalBus.off("event", listener)
        resolve()
      }
      GlobalBus.on("event", listener)
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Provider.list()
        await refreshed
        const provider = (await Provider.list()).openrouter
        for (const id of MANAGED_OPENROUTER_MODELS) {
          const model = provider.models[id]
          expect(model.api).toMatchObject({
            id,
            npm: "@openrouter/ai-sdk-provider",
          })
          expect(model.api.url).toEndWith("/api/llm/proxy/openrouter/v1")
          const options = ProviderTransform.options({ model, sessionID: "fixture" })
          const result = await generateText({
            model: await Provider.getLanguage(model),
            messages: ProviderTransform.message(
              [
                { role: "system", content: "Be concise." },
                { role: "user", content: "Hi" },
              ],
              model,
              options,
            ),
            providerOptions: ProviderTransform.providerOptions(model, options),
            temperature: ProviderTransform.temperature(model),
            topP: ProviderTransform.topP(model),
            topK: ProviderTransform.topK(model),
            maxOutputTokens: 128,
            maxRetries: 0,
          })
          expect(result.text).toBe("ok")
          expect(calls.at(-1)?.url).toBe("/api/llm/proxy/openrouter/v1/chat/completions")
          expect(calls.at(-1)?.body.model).toBe(id)
        }
        expect(provider.models["anthropic/claude-fable-5"].modes).toEqual({})
        expect(provider.models["x-ai/grok-4.6"].modes).toEqual({})

        const grok = provider.models["x-ai/grok-4.6"]
        expect(grok.api).toMatchObject({
          id: "x-ai/grok-4.6",
          npm: "@openrouter/ai-sdk-provider",
        })
        expect(grok.api.url).toEndWith("/api/llm/proxy/openrouter/v1")
        for (const effort of ["low", "medium", "high", "xhigh"]) {
          const variant = ProviderTransform.variants(grok)[effort]!
          expect(variant).toEqual({ reasoning: { effort } })
          const result = await generateText({
            model: await Provider.getLanguage(grok),
            prompt: "Hi",
            providerOptions: ProviderTransform.providerOptions(grok, variant),
            maxRetries: 0,
          })
          expect(result.text).toBe("ok")
          expect(calls.at(-1)?.body.reasoning).toEqual({ effort })
          expect(calls.at(-1)?.url).toBe("/api/llm/proxy/openrouter/v1/chat/completions")
        }

        const haiku = provider.models["anthropic/claude-haiku-4.5"]
        const variants = ProviderTransform.variants(haiku)
        expect(variants.none).toEqual({ reasoning: { enabled: false } })
        expect(variants["4096-tokens"]).toEqual({ reasoning: { max_tokens: 4096 } })
        for (const variant of [variants.none, variants["4096-tokens"]]) {
          const result = await generateText({
            model: await Provider.getLanguage(haiku),
            prompt: "Hi",
            providerOptions: ProviderTransform.providerOptions(haiku, variant),
            maxRetries: 0,
          })
          expect(result.text).toBe("ok")
        }
        expect(calls.at(-2)?.body.reasoning).toEqual({ enabled: false })
        expect(calls.at(-1)?.body.reasoning).toEqual({ max_tokens: 4096 })

        const sol = provider.models["openai/gpt-5.6-sol"]
        expect(sol.modes?.fast).toBeDefined()
        const fast = ProviderTransform.tier(sol, "fast").options
        const result = await generateText({
          model: await Provider.getLanguage(sol),
          prompt: "Hi",
          providerOptions: ProviderTransform.providerOptions(sol, fast),
          maxRetries: 0,
        })
        expect(result.text).toBe("ok")
        expect(calls.at(-1)?.body.service_tier).toBe("priority")
      },
    })
    expect(calls).toHaveLength(MANAGED_OPENROUTER_MODELS.length + 7)
    for (const call of calls) {
      expect(call.headers.get("X-Organization-ID")).toBe(organization)
      expect(call.headers.get("OpenScience-Funding-Protocol")).toBe("1")
      expect(call.headers.get("authorization")).toBe(`Bearer ${key}`)
      expect(call.headers.has("x-api-key")).toBe(false)
      expect(call.headers.has("x-goog-api-key")).toBe(false)
      expect(call.headers.has("anthropic-beta")).toBe(false)
      expect(call.body.speed).toBeUndefined()
      if (call !== calls.at(-1)) expect(call.body.service_tier).toBeUndefined()
      expect(call.body.reasoning_effort).toBeUndefined()
      expect(call.url).toBe("/api/llm/proxy/openrouter/v1/chat/completions")
    }
  } finally {
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
  }
})

test("bundled xAI Chat adapter preserves native Grok 4.6 efforts", async () => {
  const bodies: Record<string, any>[] = []
  const sdk = createXai({
    apiKey: "fixture",
    fetch: Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        bodies.push(JSON.parse(init!.body as string))
        return Response.json({
          id: "chat_fixture",
          object: "chat.completion",
          created: 1,
          model: "grok-4.6",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })
      },
      { preconnect() {} },
    ),
  })
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    const result = await generateText({
      model: sdk.languageModel("grok-4.6"),
      prompt: "Hi",
      providerOptions: { xai: { reasoningEffort: effort } },
      maxRetries: 0,
    })
    expect(result.text).toBe("ok")
    expect(bodies.at(-1)?.reasoning_effort).toBe(effort)
  }
})

test("bundled xAI Responses adapter preserves all four Grok 4.6 efforts", async () => {
  const bodies: Record<string, any>[] = []
  const sdk = createXai({
    apiKey: "fixture",
    fetch: Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        bodies.push(JSON.parse(init!.body as string))
        return Response.json({
          id: "response_fixture",
          object: "response",
          status: "completed",
          model: "grok-4.6",
          output: [
            {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        })
      },
      { preconnect() {} },
    ),
  })
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    const result = await generateText({
      model: sdk.responses("grok-4.6"),
      prompt: "Hi",
      providerOptions: { xai: { reasoningEffort: effort } },
      maxRetries: 0,
    })
    expect(result.text).toBe("ok")
    expect(bodies.at(-1)?.reasoning?.effort).toBe(effort)
  }
})
