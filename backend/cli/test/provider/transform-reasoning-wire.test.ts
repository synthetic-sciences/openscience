import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText } from "ai"
import { mergeDeep } from "remeda"
import { ProviderTransform } from "../../src/provider/transform"

const sessionID = "sess-reasoning-wire"

const model = (overrides: Partial<any> = {}): any => ({
  id: "test/model",
  providerID: "test",
  api: { id: "model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 272_000, output: 128_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-07-09",
  ...overrides,
})

function recorder() {
  const bodies: Record<string, any>[] = []
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return Response.json({ error: { message: "wire captured" } }, { status: 400 })
  }
  return { bodies, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function send(language: any, providerOptions: Record<string, any>) {
  await generateText({ model: language, prompt: "hi", providerOptions }).catch(() => undefined)
}

describe("reasoning options serialize onto provider request bodies", () => {
  test("Codex OAuth max reaches the OpenAI Responses wire shape", async () => {
    const target = model({
      id: "gpt-5.6-sol",
      providerID: "openai-codex",
      api: { id: "gpt-5.6-sol", url: "https://chatgpt.com/backend-api/codex", npm: "@ai-sdk/openai" },
    })
    const selected = ProviderTransform.variants(target).max
    const options = mergeDeep(ProviderTransform.options({ model: target, sessionID, providerOptions: {} }), selected)
    const wire = recorder()
    const sdk = createOpenAI({ apiKey: "test", baseURL: "https://codex.test/v1", fetch: wire.fetch })

    await send(sdk.responses(target.api.id), ProviderTransform.providerOptions(target, options))

    expect(wire.bodies).toHaveLength(1)
    expect(wire.bodies[0]).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "max", summary: "auto" },
    })
  })

  test("xAI Responses leaves the native high default implicit and sends selected medium", async () => {
    const target = model({
      id: "grok-4.5",
      providerID: "xai",
      api: { id: "grok-4.5", url: "https://api.x.ai/v1", npm: "@ai-sdk/xai" },
    })
    const wire = recorder()
    const sdk = createXai({ apiKey: "test", baseURL: "https://xai.test/v1", fetch: wire.fetch })
    const language = sdk.responses(target.api.id)
    const defaults = ProviderTransform.options({ model: target, sessionID, providerOptions: {} })
    const medium = mergeDeep(defaults, ProviderTransform.variants(target).medium)

    await send(language, ProviderTransform.providerOptions(target, defaults))
    await send(language, ProviderTransform.providerOptions(target, medium))

    expect(wire.bodies).toHaveLength(2)
    expect(wire.bodies[0].reasoning).toBeUndefined()
    expect(wire.bodies[1].reasoning).toEqual({ effort: "medium" })
  })

  test("Muse requests stateless encrypted reasoning for replay", async () => {
    const target = model({
      id: "muse-spark-1.1",
      providerID: "meta",
      api: { id: "muse-spark-1.1", url: "https://api.meta.ai/v1", npm: "@ai-sdk/openai" },
      limit: { context: 1_048_576, output: 131_072 },
    })
    const options = ProviderTransform.options({ model: target, sessionID, providerOptions: {} })
    const wire = recorder()
    const sdk = createOpenAI({ name: "meta", apiKey: "test", baseURL: "https://meta.test/v1", fetch: wire.fetch })

    await send(sdk.responses(target.api.id), ProviderTransform.providerOptions(target, options))

    expect(wire.bodies).toHaveLength(1)
    expect(wire.bodies[0]).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
    })
    expect(wire.bodies[0].reasoning).toBeUndefined()
  })

  test("OpenAI fast and pro modes reach their native request fields", async () => {
    const target = model({
      id: "gpt-5.6-sol",
      providerID: "openai",
      api: { id: "gpt-5.6-sol", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      modes: {
        fast: { provider: { body: { service_tier: "priority" } } },
        pro: { provider: { body: { reasoning: { mode: "pro" } } } },
      },
    })
    const wire = recorder()
    const sdk = createOpenAI({ apiKey: "test", baseURL: "https://openai.test/v1", fetch: wire.fetch })

    for (const mode of ["fast", "pro"]) {
      const options = mergeDeep(
        ProviderTransform.options({ model: target, sessionID, providerOptions: {} }),
        ProviderTransform.tier(target, mode).options,
      )
      await send(sdk.responses(target.api.id), ProviderTransform.providerOptions(target, options))
    }

    expect(wire.bodies[0].service_tier).toBe("priority")
    expect(wire.bodies[1].reasoning).toMatchObject({ mode: "pro" })
  })

  test("Managed Sol fast mode reaches OpenRouter's priority service tier", async () => {
    const target = model({
      id: "openai/gpt-5.6-sol",
      providerID: "openrouter",
      api: { id: "openai/gpt-5.6-sol", url: "https://openrouter.ai/api/v1", npm: "@openrouter/ai-sdk-provider" },
      modes: {
        fast: {
          provider: { body: { provider: { sort: "throughput" }, service_tier: "priority" } },
        },
      },
    })
    const wire = recorder()
    const sdk = createOpenRouter({ apiKey: "test", baseURL: "https://openrouter.test/v1", fetch: wire.fetch })
    const options = mergeDeep(
      ProviderTransform.options({ model: target, sessionID, providerOptions: {} }),
      ProviderTransform.tier(target, "fast").options,
    )

    await send(sdk.chat(target.api.id), ProviderTransform.providerOptions(target, options))

    expect(wire.bodies[0].service_tier).toBe("priority")
    expect(wire.bodies[0].provider).toEqual({ sort: "throughput" })
  })

  test("Anthropic fast mode reaches the speed field", async () => {
    const target = model({
      id: "claude-opus-4-8",
      providerID: "anthropic",
      api: { id: "claude-opus-4-8", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
      modes: {
        fast: {
          provider: {
            body: { speed: "fast" },
            headers: { "anthropic-beta": "fast-mode-2026-02-01" },
          },
        },
      },
    })
    const options = mergeDeep(
      ProviderTransform.options({ model: target, sessionID, providerOptions: {} }),
      ProviderTransform.tier(target, "fast").options,
    )
    const wire = recorder()
    const sdk = createAnthropic({ apiKey: "test", baseURL: "https://anthropic.test/v1", fetch: wire.fetch })

    await send(sdk(target.api.id), ProviderTransform.providerOptions(target, options))

    expect(wire.bodies[0].speed).toBe("fast")
  })

  test("new Claude effort selections enable adaptive thinking on the wire", async () => {
    const target = model({
      id: "claude-opus-4-8",
      providerID: "anthropic",
      api: { id: "claude-opus-4-8", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
    })
    const options = mergeDeep(
      ProviderTransform.options({ model: target, sessionID, providerOptions: {} }),
      ProviderTransform.variants(target).xhigh,
    )
    const wire = recorder()
    const sdk = createAnthropic({ apiKey: "test", baseURL: "https://anthropic.test/v1", fetch: wire.fetch })

    await send(sdk(target.api.id), ProviderTransform.providerOptions(target, options))

    expect(wire.bodies).toHaveLength(1)
    expect(wire.bodies[0].thinking).toEqual({ type: "adaptive" })
    expect(wire.bodies[0].output_config).toEqual({ effort: "xhigh" })
  })
})
