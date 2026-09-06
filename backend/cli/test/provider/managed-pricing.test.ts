import { expect, test, spyOn } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"

const entry = {
  id: "anthropic/claude-opus-5",
  context_length: 1_000_000,
  max_output_tokens: 128_000,
  upstream_provider: "anthropic",
  pricing: {
    tiers: [{ input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }],
    audited_at: "2026-08-30",
    source_url: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
}
let requests = 0
let release: (() => void) | undefined
let received: (() => void) | undefined
async function gateway(request: Request) {
  requests++
  const organization = request.headers.get("X-Organization-ID")
  expect(request.headers.get("authorization")).toBe(`Bearer osk_fixture_${organization}`)
  expect(new URL(request.url).pathname).toBe("/api/cli/model-catalog")
  if (organization === "org_a")
    await new Promise<void>((resolve) => {
      release = resolve
      received?.()
    })
  return Response.json(
    { models: [entry] },
    {
      headers: {
        "OpenScience-Funding-Protocol": "1",
        "OpenScience-Funding-Context": `organization:${organization}`,
      },
    },
  )
}
const { ManagedPricing } = await import("../../src/provider/managed-pricing")
const { OpenScience } = await import("../../src/openscience")

test("pricing ingestion copies only reviewed non-executable metadata", () => {
  const parsed = ManagedPricing.parse({
    models: [
      {
        ...entry,
        api: { url: "https://untrusted.example", npm: "untrusted-package" },
        options: { apiKey: "never-import-this" },
        headers: { Authorization: "never-import-this" },
      },
    ],
  })
  expect(parsed[entry.id]?.cost).toEqual({ input: 5, output: 25, cache: { read: 0.5, write: 6.25 }, tiers: [] })
  expect(parsed[entry.id]?.limit).toEqual({ context: 1_000_000, output: 128_000 })
  expect(JSON.stringify(parsed)).not.toContain("untrusted")
  expect(JSON.stringify(parsed)).not.toContain("never-import")
  expect(ManagedPricing.parse({ models: [{ ...entry, id: "unreviewed/model" }] })).toEqual({})
  expect(ManagedPricing.parse({ models: [{ ...entry, available: false }] })).toEqual({})
  expect(ManagedPricing.parse({ models: [{ ...entry, pricing: { tiers: [{ input: -1, output: 25 }] } }] })).toEqual({})
})

test("explicit availability survives missing prices and conflicting rows fail closed", () => {
  expect(
    ManagedPricing.availability({
      models: [
        { id: entry.id, available: false },
        { id: entry.id, available: true },
        { id: "openai/gpt-6-astra", available: true },
        { id: "unreviewed/model", available: true },
        { id: "openai/gpt-5.6-sol" },
      ],
    }),
  ).toEqual({ [entry.id]: false, "openai/gpt-6-astra": true })
})

test("long-context prices retain inclusive provider thresholds", () => {
  const parsed = ManagedPricing.parse({
    models: [
      {
        ...entry,
        pricing: {
          tiers: [
            { input: 2, output: 12, max_input_tokens: 200_000 },
            { input: 4, output: 18, min_input_tokens: 200_001 },
          ],
        },
      },
    ],
  })
  expect(parsed[entry.id]?.cost.tiers?.[0]?.threshold).toBe(200_000)
})

test("managed controls cannot import native-provider Fast transports into OpenRouter", () => {
  const parsed = ManagedPricing.parse({
    models: [
      {
        ...entry,
        id: "x-ai/grok-4.6",
        upstream_provider: "xai",
        context_length: 500_000,
        context_options: [200_000, 500_000, 1_000_000],
        capabilities: { reasoning_efforts: ["low", "medium", "high", "xhigh"], reasoning_default: "high" },
        fast_mode: true,
        fast_mode_details: {
          available: true,
          transport: { service_tier: "priority", apiKey: "never-import" },
          pricing: { verified: true, tiers: [{ input: 4, output: 12, cache_read: 1 }] },
        },
      },
    ],
  })["x-ai/grok-4.6"]!
  expect(parsed.contextOptions).toEqual([200_000, 500_000])
  expect(parsed.reasoningOptions).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh"], default: "high" },
  ])
  expect(parsed.modes).toEqual({})

  const openrouter = ManagedPricing.parse({
    models: [
      {
        ...entry,
        id: "openai/gpt-5.6-sol",
        upstream_provider: "openrouter",
        fast_mode: true,
        fast_mode_details: {
          available: true,
          transport: { service_tier: "priority" },
          pricing: { verified: true, tiers: [{ input: 4, output: 12, cache_read: 1 }] },
        },
      },
    ],
  })["openai/gpt-5.6-sol"]!
  expect(openrouter.modes.fast).toEqual({
    cost: { input: 4, output: 12, cache: { read: 1, write: 0 }, tiers: [] },
    provider: { body: { service_tier: "priority" } },
  })
  expect(JSON.stringify([parsed, openrouter])).not.toContain("never-import")
  expect(
    ManagedPricing.parse({
      models: [
        {
          ...entry,
          fast_mode: true,
          fast_mode_details: {
            available: true,
            transport: { speed: "fast" },
            pricing: { verified: true, tiers: entry.pricing.tiers },
          },
        },
      ],
    })[entry.id]!.modes,
  ).toEqual({})
  for (const details of [
    { available: false, transport: { speed: "fast" }, pricing: { verified: true, tiers: entry.pricing.tiers } },
    { available: true, transport: { speed: "fast" }, pricing: { verified: false, tiers: entry.pricing.tiers } },
    {
      available: true,
      transport: { service_tier: "priority" },
      pricing: { verified: true, tiers: entry.pricing.tiers },
    },
  ])
    expect(
      ManagedPricing.parse({ models: [{ ...entry, fast_mode: true, fast_mode_details: details }] })[entry.id]!.modes,
    ).toEqual({})
  expect(JSON.stringify(ManagedPricing.parse({ models: [{ ...entry }] }))).not.toContain("anthropic-beta")
})

test("Haiku's zero thinking budget survives ingestion and means Off, not a fake low/high ladder", () => {
  const parsed = ManagedPricing.parse({
    models: [
      {
        ...entry,
        id: "anthropic/claude-haiku-4.5",
        capabilities: { reasoning_efforts: [], thinking_budgets: [0, 4096, 8192, 16384, 32768] },
      },
    ],
  })["anthropic/claude-haiku-4.5"]!
  expect(parsed.reasoningOptions).toEqual([{ type: "budget_tokens", values: [0, 4096, 8192, 16384, 32768] }])
  const variants = ProviderTransform.variants({
    id: "anthropic/claude-haiku-4.5",
    api: {
      id: "anthropic/claude-haiku-4.5",
      npm: "@openrouter/ai-sdk-provider",
      url: "https://atlas.test/api/llm/proxy/openrouter/v1",
    },
    capabilities: { reasoning: true },
    limit: { output: 64_000 },
    reasoningOptions: parsed.reasoningOptions,
  } as Provider.Model)
  expect(Object.keys(variants)).toEqual(["none", "4096-tokens", "8192-tokens", "16384-tokens", "32768-tokens"])
  expect(variants.none).toEqual({ reasoning: { enabled: false } })
  expect(variants["4096-tokens"]).toEqual({ reasoning: { max_tokens: 4096 } })
})

test("pricing cache is nonblocking, deduplicated, and partitioned by immutable workspace", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => gateway(new Request(input, init))) as typeof fetch
  try {
    const session = (organization_id: string) => ({
      api_key: `osk_fixture_${organization_id}`,
      user_id: "fixture",
      organization_id,
      workspace_locked: true,
    })
    await OpenScience.saveSession(session("org_a"))
    const entered = new Promise<void>((resolve) => {
      received = resolve
    })
    expect(await ManagedPricing.current()).toEqual({})
    expect(await ManagedPricing.current()).toEqual({})
    await entered
    expect(requests).toBe(1)
    const published = new Promise<void>((resolve) => {
      const listener = (event: { directory?: string; payload: { type: string } }) => {
        if (event.payload.type !== "global.disposed") return
        GlobalBus.off("event", listener)
        resolve()
      }
      GlobalBus.on("event", listener)
    })
    release?.()
    await published
    expect((await ManagedPricing.current())[entry.id]?.pricing.upstream_provider).toBe("anthropic")
    expect(requests).toBe(1)
    await OpenScience.saveSession(session("org_b"))
    expect(await ManagedPricing.current()).toEqual({})
  } finally {
    release?.()
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
  }
})

test("provider list retries failed pricing after cooldown without a runtime restart or inference request", async () => {
  const { Provider } = await import("../../src/provider/provider")
  const { Instance } = await import("../../src/project/instance")
  const { tmpdir } = await import("../fixture/fixture")
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let clock = originalNow()
  let calls = 0
  const now = spyOn(Date, "now").mockImplementation(() => clock)
  const id = "openai/gpt-6-astra"
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/api/cli/model-catalog")
    calls++
    if (calls === 1) return new Response("unavailable", { status: 503 })
    return Response.json(
      {
        models: [
          {
            id,
            upstream_provider: "openrouter",
            context_length: 1_050_000,
            max_output_tokens: 128_000,
            capabilities: { reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
            pricing: { tiers: [{ input: 10, output: 50, cache_read: 1, cache_write: 12.5 }] },
            fast_mode: true,
            fast_mode_details: {
              available: true,
              transport: { service_tier: "priority" },
              pricing: { verified: true, tiers: [{ input: 20, output: 100, cache_read: 2, cache_write: 25 }] },
            },
          },
        ],
      },
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:org_pricing_retry",
        },
      },
    )
  }) as typeof fetch
  await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_pricing_retry",
      user_id: "fixture",
      organization_id: "org_pricing_retry",
      workspace_locked: true,
    })
    Provider.invalidate()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initial = (await Provider.list()).openrouter.models[id]
        expect(initial.modes).toEqual({})
        expect(Object.keys(initial.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
        let restored: Provider.Model | undefined
        // Advance only the cache clock. Poll the observable provider result,
        // allowing filesystem-backed credential snapshots to finish between reads.
        for (let attempt = 0; attempt < 100; attempt++) {
          clock += 11_000
          const listed = (await Provider.list()).openrouter.models[id]
          if (listed.modes?.fast) {
            restored = listed
            break
          }
          await Bun.sleep(5)
        }
        expect(restored?.modes?.fast.provider?.body).toEqual({ service_tier: "priority" })
        expect(restored?.cost.input).toBe(10)
        expect(calls).toBe(2)
      },
    })
  } finally {
    now.mockRestore()
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
    Provider.invalidate()
  }
})

test("managed availability controls selection independently of pricing and cannot be bypassed by config", async () => {
  const { Provider } = await import("../../src/provider/provider")
  const { Instance } = await import("../../src/project/instance")
  const { tmpdir } = await import("../fixture/fixture")
  const originalFetch = globalThis.fetch
  let clock = Date.now()
  const now = spyOn(Date, "now").mockImplementation(() => clock)
  const id = "anthropic/claude-fable-5.1"
  let allowed = false
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/api/cli/model-catalog")
    calls++
    return Response.json(
      {
        models: [
          { ...entry, id, upstream_provider: "openrouter", available: allowed },
          // No prices: an explicit disabled established route must still be removed.
          { id: "openai/gpt-5.6-terra", available: false },
        ],
      },
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:org_availability",
        },
      },
    )
  }) as typeof fetch
  await using tmp = await tmpdir({
    config: {
      billing: { llm: "managed" },
      provider: { openrouter: { models: { [id]: { name: "Configured Fable" } } } },
    },
  })
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_availability",
      user_id: "fixture",
      organization_id: "org_availability",
      workspace_locked: true,
    })
    Provider.invalidate()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const waitFor = async (predicate: (models: Record<string, Provider.Model>) => boolean) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const models = (await Provider.list()).openrouter.models
            if (predicate(models)) return models
            await Bun.sleep(5)
          }
          throw new Error("Managed catalog did not publish the expected availability")
        }
        expect((await Provider.list()).openrouter.models[id]).toBeUndefined()
        const disabled = await waitFor((models) => !models["openai/gpt-5.6-terra"])
        expect(disabled[id]).toBeUndefined()
        expect(disabled["openai/gpt-5.6-sol"]).toBeDefined()
        expect(disabled["openai/gpt-6-astra"]).toBeDefined()
        await expect(Provider.getModel("openrouter", id)).rejects.toThrow()
        allowed = true
        clock += 61_000
        await waitFor((models) => !!models[id])
        expect((await Provider.getModel("openrouter", id)).name).toBe("Configured Fable")
        allowed = false
        clock += 61_000
        await waitFor((models) => !models[id])
        await expect(Provider.getModel("openrouter", id)).rejects.toThrow()
        expect(calls).toBe(3)
      },
    })
  } finally {
    now.mockRestore()
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
    Provider.invalidate()
  }
})
