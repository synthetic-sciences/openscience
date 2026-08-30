import { expect, test } from "bun:test"
import { generateText } from "ai"
import { createXai } from "@ai-sdk/xai"
import { GlobalBus } from "../../src/bus/global"

const key = "osk_fixture_native_sdk"
const organization = "org_native_sdk"
const calls: Array<{ url: string; headers: Headers; body: Record<string, any> }> = []
const headers = {
  "OpenScience-Funding-Protocol": "1",
  "OpenScience-Funding-Context": `organization:${organization}`,
}
async function gateway(request: Request) {
  const url = new URL(request.url)
  if (url.pathname.endsWith("/model-catalog"))
    return Response.json(
      {
        models: [
          {
            id: "anthropic/claude-fable-5",
            upstream_provider: "anthropic",
            context_length: 1_000_000,
            max_output_tokens: 128_000,
            pricing: { tiers: [{ input: 10, output: 50 }] },
          },
          {
            id: "google/gemini-3.7-flash",
            upstream_provider: "gemini",
            context_length: 1_048_576,
            max_output_tokens: 65_536,
            pricing: { tiers: [{ input: 0.75, output: 3.75 }] },
          },
          {
            id: "x-ai/grok-4.6",
            upstream_provider: "xai",
            context_length: 500_000,
            max_output_tokens: 450_000,
            pricing: { tiers: [{ input: 2, output: 6 }] },
          },
        ],
      },
      { headers },
    )
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

test("Ace uses real native SDK bodies with scoped credentials, cache control, and supported reasoning", async () => {
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
        for (const id of ["anthropic/claude-fable-5", "google/gemini-3.7-flash"]) {
          const model = (await Provider.list()).openrouter.models[id]
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
          expect(result.usage.cachedInputTokens).toBe(5)
        }
        const grok = (await Provider.list()).openrouter.models["x-ai/grok-4.6"]
        for (const effort of ["low", "medium", "high", "xhigh"]) {
          const result = await generateText({
            model: await Provider.getLanguage(grok),
            prompt: "Hi",
            providerOptions: ProviderTransform.providerOptions(grok, ProviderTransform.variants(grok)[effort]!),
            maxRetries: 0,
          })
          expect(result.text).toBe("ok")
          expect(calls.at(-1)?.body.reasoning_effort).toBe(effort)
          expect(calls.at(-1)?.url).toBe("/api/llm/proxy/xai/v1/chat/completions")
        }
      },
    })
    expect(calls).toHaveLength(6)
    for (const call of calls) {
      expect(call.headers.get("X-Organization-ID")).toBe(organization)
      expect(call.headers.get("OpenScience-Funding-Protocol")).toBe("1")
      expect(call.headers.get("authorization")).toBe(`Bearer ${key}`)
      expect(call.headers.has("x-api-key")).toBe(false)
      expect(call.headers.has("x-goog-api-key")).toBe(false)
      expect(call.url).toStartWith("/api/llm/proxy/")
    }
    const anthropic = calls[0]!
    expect(anthropic.url).toBe("/api/llm/proxy/anthropic/v1/messages")
    expect(anthropic.body.model).toBe("claude-fable-5")
    expect(anthropic.body.thinking).toEqual({ type: "adaptive" })
    expect(anthropic.body.output_config.effort).toBe("high")
    expect(anthropic.body.system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(anthropic.body).not.toHaveProperty("reasoning")
    const gemini = calls[1]!
    expect(gemini.url).toContain("/gemini/v1beta/models/gemini-3.7-flash:generateContent")
    expect(gemini.body.generationConfig.thinkingConfig.thinkingLevel).toBe("medium")
    expect(gemini.body.generationConfig).not.toHaveProperty("temperature")
    expect(gemini.body.generationConfig).not.toHaveProperty("topP")
    expect(gemini.body.generationConfig).not.toHaveProperty("topK")
  } finally {
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
  }
})

test("bundled xAI Chat adapter preserves native Grok 4.6 efforts", async () => {
  const bodies: Record<string, any>[] = []
  const sdk = createXai({
    apiKey: "fixture",
    fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bodies.push(JSON.parse(init!.body as string))
      return Response.json({
        id: "chat_fixture", object: "chat.completion", created: 1, model: "grok-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
    }, { preconnect() {} }),
  })
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    const result = await generateText({ model: sdk.languageModel("grok-4.6"), prompt: "Hi",
      providerOptions: { xai: { reasoningEffort: effort } }, maxRetries: 0 })
    expect(result.text).toBe("ok")
    expect(bodies.at(-1)?.reasoning_effort).toBe(effort)
  }
})

test("bundled xAI Responses adapter preserves all four Grok 4.6 efforts", async () => {
  const bodies: Record<string, any>[] = []
  const sdk = createXai({
    apiKey: "fixture",
    fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
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
    }, { preconnect() {} }),
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
