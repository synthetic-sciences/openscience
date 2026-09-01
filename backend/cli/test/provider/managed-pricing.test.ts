import { expect, test } from "bun:test"
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
