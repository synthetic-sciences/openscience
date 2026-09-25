import { expect, test, spyOn } from "bun:test"
import z from "zod"
import { GlobalBus } from "../../src/bus/global"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"

const entry = {
  id: "anthropic/claude-opus-5.5",
  context_length: 1_000_000,
  max_output_tokens: 128_000,
  upstream_provider: "anthropic",
  hosting_provider: "anthropic",
  pricing: {
    funding_fee_bps: 0,
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
  expect(request.headers.get("OpenScience-Catalog-Version")).toBe("2")
  expect(new URL(request.url).pathname).toBe("/api/cli/model-catalog")
  if (organization === "org_a")
    await new Promise<void>((resolve) => {
      release = resolve
      received?.()
    })
  return Response.json(
    { models: [{ ...entry, hosting_provider: "anthropic" }] },
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
        hosting_provider: "anthropic",
        api: { url: "https://untrusted.example", npm: "untrusted-package" },
        options: { apiKey: "never-import-this" },
        headers: { Authorization: "never-import-this" },
      },
    ],
  })
  expect(parsed[entry.id]?.cost).toEqual({ input: 5, output: 25, cache: { read: 0.5, write: 6.25 }, tiers: [] })
  expect(parsed[entry.id]?.limit).toEqual({ context: 1_000_000, output: 128_000 })
  expect(parsed[entry.id]?.pricing.hosting_provider).toBe("anthropic")
  expect(JSON.stringify(parsed)).not.toContain("untrusted")
  expect(JSON.stringify(parsed)).not.toContain("never-import")
  expect(ManagedPricing.parse({ models: [{ ...entry, id: "unreviewed/model" }] })).toEqual({})
  expect(ManagedPricing.parse({ models: [{ ...entry, available: false }] })).toEqual({})
  expect(
    ManagedPricing.parse({ models: [{ ...entry, pricing: { ...entry.pricing, tiers: [{ input: -1, output: 25 }] } }] }),
  ).toEqual({})
})

test("pricing preserves the billing basis used to distinguish maximum and exact rates", () => {
  for (const billing_basis of ["provider_reported_cost", "anthropic_token_usage", "azure_token_usage"]) {
    const parsed = ManagedPricing.parse({
      models: [
        {
          ...entry,
          hosting_provider:
            billing_basis === "provider_reported_cost"
              ? "openrouter"
              : billing_basis === "azure_token_usage"
                ? "azure"
                : "anthropic",
          pricing: { ...entry.pricing, billing_basis },
        },
      ],
    })
    expect(parsed[entry.id]?.pricing.billing_basis).toBe(billing_basis)
    expect(parsed[entry.id]?.cost.input).toBe(5)
  }
  expect(ManagedPricing.parse({ models: [entry] })[entry.id]?.pricing.billing_basis).toBeUndefined()
  for (const pricing of [
    { verified: false },
    { service_fee_bps: 100 },
    { billing_basis: "provider_reported_cost" },
    { billing_basis: "unknown_basis" },
  ]) {
    expect(ManagedPricing.parse({ models: [{ ...entry, pricing: { ...entry.pricing, ...pricing } }] })).toEqual({})
  }
})

test("native prices remain readable by the released catalog schema when optional new hosts are omitted", () => {
  // v2.0.133 validates these provider-bearing fields before accepting a price
  // row. Both host positions are optional, but neither enum knows Anthropic.
  const host = z.enum(["azure", "openai", "gemini", "xai", "bedrock", "openrouter"])
  const rate = z.number().finite().nonnegative().max(100_000)
  const tier = z.object({
    input: rate,
    output: rate,
    cache_read: rate.optional(),
    cache_write: rate.optional(),
  })
  const legacy = z.object({
    id: z.string(),
    upstream_provider: z.enum(["anthropic", "gemini", "xai", "meta", "openrouter"]),
    hosting_provider: host.optional(),
    context_length: z.number().int().positive().max(20_000_000),
    fast_mode_details: z.object({ available: z.boolean(), hosting_provider: host.optional() }).optional(),
    pricing: z.object({
      tiers: z.array(tier).min(1).max(8),
      source_url: z.url().max(2048).optional(),
      funding_fee_bps: z.number().int().min(0).max(10_000).optional(),
    }),
  })
  const native = {
    ...entry,
    upstream_provider: "openrouter",
    hosting_provider: "anthropic",
    pricing: {
      ...entry.pricing,
      tiers: [{ input: 4.22, output: 21.1, cache_read: 0.211, cache_write: 5.275 }],
      billing_basis: "anthropic_token_usage",
      funding_fee_bps: 0,
    },
  }
  expect(legacy.safeParse(native).success).toBe(false)
  const compatible = { ...native, hosting_provider: undefined }
  expect(legacy.parse(compatible).pricing).toEqual({
    tiers: native.pricing.tiers,
    source_url: native.pricing.source_url,
    funding_fee_bps: 0,
  })
  expect(
    legacy.safeParse({
      ...compatible,
      fast_mode_details: { available: false, hosting_provider: "anthropic" },
    }).success,
  ).toBe(false)
  expect(legacy.safeParse({ ...compatible, fast_mode_details: { available: false } }).success).toBe(true)
  const modern = ManagedPricing.parse({ models: [native] })[entry.id]!
  const old = ManagedPricing.parse({
    models: [{ ...compatible, pricing: { ...compatible.pricing, hosting_provider: "anthropic" } }],
  })[entry.id]!
  expect(old.cost).toEqual(modern.cost)
  expect(old.pricing).toEqual(modern.pricing)
  expect(modern.pricing.hosting_provider).toBe("anthropic")
  expect(old.cost.input).toBe(4.22)
  expect(old.pricing.source_url).toBe(native.pricing.source_url)
  expect(old.pricing.funding_fee_bps).toBe(0)
})

test("explicit availability survives missing prices and conflicting rows fail closed", () => {
  expect(
    ManagedPricing.availability({
      models: [
        { id: entry.id, available: false },
        { id: entry.id, available: true },
        { id: "openai/gpt-6-astra", available: true },
        { id: "unreviewed/model", available: true },
        { id: "openai/gpt-6-sol" },
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
          ...entry.pricing,
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

test("hosted routes keep the managed transport and Fast follows the catalog's fast host", () => {
  const hosted = (hosting_provider: string, fast?: Record<string, unknown>) =>
    ManagedPricing.parse({
      models: [
        {
          ...entry,
          id: "openai/gpt-6-sol",
          upstream_provider: "openrouter",
          hosting_provider,
          pricing: { ...entry.pricing, tiers: [{ input: 2.11, output: 10.55, cache_read: 0.211 }] },
          ...(fast
            ? {
                fast_mode: true,
                fast_mode_details: {
                  available: true,
                  transport: { service_tier: "priority" },
                  pricing: { funding_fee_bps: 0, verified: true, tiers: [{ input: 4.22, output: 21.1 }] },
                  ...fast,
                },
              }
            : {}),
        },
      ],
    })["openai/gpt-6-sol"]!
  // Azure alone has no priority tier.
  const azure = hosted("azure")
  expect(azure.pricing.hosting_provider).toBe("azure")
  expect(azure.pricing.upstream_provider).toBe("openrouter")
  expect(azure.cost.input).toBe(2.11)
  expect(azure.modes).toEqual({})
  // OpenAI's own priority processing beside an Azure-hosted standard tier.
  expect(hosted("azure", { hosting_provider: "openai" }).modes.fast).toEqual({
    cost: { input: 4.22, output: 21.1, cache: { read: 0, write: 0 }, tiers: [] },
    pricing: { upstream_provider: "openrouter", hosting_provider: "openai", funding_fee_bps: 0 },
    provider: { body: { service_tier: "priority" } },
  })
  // These hosts have no supported Ace priority transport, whatever the catalog says.
  for (const host of ["anthropic", "gemini", "bedrock"]) expect(hosted(host, {}).modes).toEqual({})
  const grok = ManagedPricing.parse({
    models: [
      {
        ...entry,
        id: "x-ai/grok-4.7",
        upstream_provider: "openrouter",
        hosting_provider: "xai",
        context_length: 500_000,
        pricing: { ...entry.pricing, tiers: [{ input: 2.11, output: 6.33, cache_read: 0.5275 }] },
        fast_mode: true,
        fast_mode_details: {
          available: true,
          hosting_provider: "xai",
          transport: { service_tier: "priority" },
          pricing: { funding_fee_bps: 0, verified: true, tiers: [{ input: 4.22, output: 12.66, cache_read: 1.055 }] },
        },
      },
    ],
  })["x-ai/grok-4.7"]!
  expect(grok.pricing.hosting_provider).toBe("xai")
  expect(grok.modes.fast?.provider.body).toEqual({ service_tier: "priority" })
  expect(grok.modes.fast?.cost?.input).toBe(4.22)
})

test("managed controls cannot import native-provider Fast transports into OpenRouter", () => {
  const parsed = ManagedPricing.parse({
    models: [
      {
        ...entry,
        id: "x-ai/grok-4.7",
        upstream_provider: "xai",
        context_length: 500_000,
        context_options: [200_000, 500_000, 1_000_000],
        capabilities: { reasoning_efforts: ["low", "medium", "high", "xhigh"], reasoning_default: "high" },
        fast_mode: true,
        fast_mode_details: {
          available: true,
          transport: { service_tier: "priority", apiKey: "never-import" },
          pricing: { funding_fee_bps: 0, verified: true, tiers: [{ input: 4, output: 12, cache_read: 1 }] },
        },
      },
    ],
  })["x-ai/grok-4.7"]!
  expect(parsed.contextOptions).toEqual([200_000, 500_000])
  expect(parsed.reasoningOptions).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh"], default: "high" },
  ])
  expect(parsed.modes).toEqual({})

  const openrouter = ManagedPricing.parse({
    models: [
      {
        ...entry,
        id: "openai/gpt-6-sol",
        upstream_provider: "openrouter",
        fast_mode: true,
        fast_mode_details: {
          available: true,
          hosting_provider: "openrouter",
          transport: { service_tier: "priority" },
          pricing: { funding_fee_bps: 0, verified: true, tiers: [{ input: 4, output: 12, cache_read: 1 }] },
        },
      },
    ],
  })["openai/gpt-6-sol"]!
  expect(openrouter.modes.fast).toEqual({
    cost: { input: 4, output: 12, cache: { read: 1, write: 0 }, tiers: [] },
    pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 0 },
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
            pricing: { funding_fee_bps: 0, verified: true, tiers: entry.pricing.tiers },
          },
        },
      ],
    })[entry.id]!.modes,
  ).toEqual({})
  for (const details of [
    {
      available: false,
      transport: { speed: "fast" },
      pricing: { funding_fee_bps: 0, verified: true, tiers: entry.pricing.tiers },
    },
    { available: true, transport: { speed: "fast" }, pricing: { verified: false, tiers: entry.pricing.tiers } },
    {
      available: true,
      transport: { service_tier: "priority" },
      pricing: { funding_fee_bps: 0, verified: true, tiers: entry.pricing.tiers },
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
    expect((await ManagedPricing.current())[entry.id]?.pricing.hosting_provider).toBe("anthropic")
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
            hosting_provider: "openrouter",
            pricing: {
              funding_fee_bps: 550,
              billing_basis: "provider_reported_cost",
              tiers: [{ input: 10, output: 50, cache_read: 1, cache_write: 12.5 }],
            },
            fast_mode: true,
            fast_mode_details: {
              available: true,
              hosting_provider: "openrouter",
              transport: { service_tier: "priority" },
              pricing: {
                funding_fee_bps: 0,
                verified: true,
                tiers: [{ input: 20, output: 100, cache_read: 2, cache_write: 25 }],
              },
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
        expect(Provider.Model.parse(restored).pricing?.billing_basis).toBe("provider_reported_cost")
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
          { ...entry, id, upstream_provider: "openrouter", hosting_provider: "anthropic", available: allowed },
          // No prices: an explicit disabled established route must still be removed.
          { id: "openai/gpt-6-luna", available: false },
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
        const disabled = await waitFor((models) => !models["openai/gpt-6-luna"])
        expect(disabled[id]).toBeUndefined()
        expect(disabled["openai/gpt-6-sol"]).toBeDefined()
        expect(disabled["openai/gpt-6-astra"]).toBeDefined()
        await expect(Provider.getModel("openrouter", id)).rejects.toThrow()
        allowed = true
        clock += 61_000
        await waitFor((models) => !!models[id])
        expect((await Provider.getModel("openrouter", id)).name).toBe("Configured Fable")
        await expect(Provider.getModel("openrouter", "anthropic/claude-fable-5")).rejects.toThrow()
        expect((await Provider.getModel("openrouter", id)).pricing?.hosting_provider).toBe("anthropic")
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

test("each hosted route requires its own explicit fee", () => {
  for (const host of ["azure", "openai", "anthropic", "gemini", "xai", "bedrock", "openrouter"]) {
    for (const fee of [undefined, 0, 550, 700, 55.5, -1, 10_000]) {
      const model = ManagedPricing.parse({
        models: [{ ...entry, hosting_provider: host, pricing: { ...entry.pricing, funding_fee_bps: fee } }],
      })[entry.id]
      const valid = Number.isInteger(fee) && fee! >= 0 && fee! < 10_000 && (host === "openrouter" || fee === 0)
      expect(model !== undefined).toBe(valid)
      if (model) expect(ManagedPricing.fundingFeeBps(model)).toBe(fee)
    }
  }
  expect(ManagedPricing.fundingFeeBps({})).toBeUndefined()
  expect(ManagedPricing.parse({ models: [{ ...entry, hosting_provider: undefined }] })).toEqual({})
  expect(
    ManagedPricing.parse({ models: [{ ...entry, pricing: { ...entry.pricing, hosting_provider: "openai" } }] }),
  ).toEqual({})
})

test("an explicit refresh skips the failure cooldown and waits for the answer", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(new URL(request.url).pathname).toBe("/api/cli/model-catalog")
    calls++
    if (calls === 1) return new Response("unavailable", { status: 503 })
    return Response.json(
      { models: [{ ...entry, hosting_provider: "openrouter", pricing: { ...entry.pricing, funding_fee_bps: 700 } }] },
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:org_force",
        },
      },
    )
  }) as typeof fetch
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_force",
      user_id: "fixture",
      organization_id: "org_force",
      workspace_locked: true,
    })
    // The forced read waits for the (failed) fetch instead of answering from nothing.
    expect(await ManagedPricing.current({ force: true })).toEqual({})
    expect(calls).toBe(1)
    // Inside the failure cooldown an ordinary read does not ask again...
    expect(await ManagedPricing.current()).toEqual({})
    expect(calls).toBe(1)
    // ...while the user's Refresh does, and sees the answer in the same read.
    const forced = await ManagedPricing.current({ force: true })
    expect(calls).toBe(2)
    expect(forced[entry.id]?.pricing.funding_fee_bps).toBe(700)
  } finally {
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
  }
})

test("Standard and Fast retain independent hosts, fees and Wallet quotes", async () => {
  const { Session } = await import("../../src/session")
  for (const [standard, fee, fast, premium] of [
    ["openrouter", 550, "openai", 0],
    ["azure", 0, "openai", 0],
    ["openrouter", 700, "openrouter", 700],
    ["xai", 0, "xai", 0],
  ] as const) {
    const parsed = ManagedPricing.parse({
      models: [
        {
          ...entry,
          id: standard === "xai" ? "x-ai/grok-4.7" : "openai/gpt-6-sol",
          upstream_provider: "openrouter",
          hosting_provider: standard,
          pricing: { ...entry.pricing, hosting_provider: standard, funding_fee_bps: fee },
          fast_mode: true,
          fast_mode_details: {
            available: true,
            hosting_provider: fast,
            transport: { service_tier: "priority" },
            pricing: {
              verified: true,
              hosting_provider: fast,
              funding_fee_bps: premium,
              tiers: [
                { input: 4, output: 20, max_input_tokens: 272_000 },
                { input: 8, output: 30, min_input_tokens: 272_001 },
              ],
            },
          },
        },
      ],
    })
    const model = Object.values(parsed)[0]!
    expect(ManagedPricing.fundingFeeBps(model)).toBe(fee)
    expect(ManagedPricing.fundingFeeBps(model, "fast")).toBe(premium)
    expect(model.modes.fast?.cost?.input).toBe(4)
    expect(model.modes.fast?.cost?.tiers?.[0]).toMatchObject({ input: 8, output: 30, threshold: 272_000 })
    for (const [tier, basis] of [
      ["standard", fee],
      ["fast", premium],
    ] as const) {
      const cost = Session.getUsage({
        model: model as Provider.Model,
        tier,
        fundingFeeBps: ManagedPricing.fundingFeeBps(model, tier),
        usage: { inputTokens: 1_000, outputTokens: 10, totalTokens: 1_010 },
        metadata: { openrouter: { usage: { cost: 1 } } },
      })
      expect(cost.cost).toBe(basis === 550 ? 1.055 : basis === 700 ? 1.07 : 1)
    }
  }
})

test("unknown selected-mode pricing refreshes before dispatch and cannot inherit Standard's fee", async () => {
  const { LLM } = await import("../../src/session/llm")
  const original = globalThis.fetch
  let requests = 0
  const model = {
    id: "openai/gpt-6-sol",
    providerID: "openrouter",
    cost: { input: 2, output: 10, cache: { read: 0, write: 0 } },
    pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
    modes: {},
  } as Provider.Model
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/api/cli/model-catalog")
    requests++
    return Response.json(
      { models: [{ ...entry, id: model.id }] },
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:org_missing_fast",
        },
      },
    )
  }) as typeof fetch
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_missing_fast",
      user_id: "fixture",
      organization_id: "org_missing_fast",
      workspace_locked: true,
    })
    expect(ManagedPricing.fundingFeeBps(model, "fast")).toBeUndefined()
    await expect(
      LLM.stream({ model, route: "managed", user: { tier: "fast" } } as Parameters<typeof LLM.stream>[0]),
    ).rejects.toThrow("Refresh Models in Settings")
    expect(requests).toBe(1)
    // A known Standard contract does not refresh or consume paid inference.
    expect(await ManagedPricing.forRequest(model)).toBe(model)
    expect(requests).toBe(1)
  } finally {
    globalThis.fetch = original
    await OpenScience.clearSession()
  }
})
