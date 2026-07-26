import { test, expect } from "bun:test"

// Live check that models.dev still lists the models the suite pins. This is the
// ONLY test that talks to real models.dev, so it runs solely in the scheduled
// catalog job (gated on OPENSCIENCE_LIVE_CATALOG). PR CI uses the committed
// fixture (test/preload.ts seeds it) and never hits the network.
//
// When this fails, models.dev delisted a pinned model — do BOTH:
//   1. update FRONTIER_MODELS in provider.test.ts and CATALOG_PINS below, and
//   2. regenerate the fixture: curl -fsSL https://models.dev/api.json | (minify) >
//      test/fixture/models-catalog.json, then gzip it to models-catalog.json.gz.
//
const CATALOG_PINS = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"],
  openai: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  xai: [
    "grok-4.3",
    "grok-4.5",
    "grok-build-0.1",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-multi-agent-0309",
  ],
  moonshotai: ["kimi-k3"],
  vercel: ["meta/muse-spark-1.1"],
  openrouter: [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-fable-5",
    "openai/gpt-5.6-sol",
    "x-ai/grok-4.5",
    "moonshotai/kimi-k3",
    "meta/muse-spark-1.1",
  ],
}

test.skipIf(!process.env["OPENSCIENCE_LIVE_CATALOG"])("models.dev still lists the pinned catalog models", async () => {
  const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20_000) })
  expect(res.ok).toBe(true)
  const catalog = (await res.json()) as Record<string, { models?: Record<string, unknown> }>
  for (const [provider, expected] of Object.entries(CATALOG_PINS)) {
    const models = Object.keys(catalog[provider]?.models ?? {})
    expect(models.length).toBeGreaterThan(0)
    for (const id of expected) {
      if (models.includes(id)) continue
      throw new Error(`models.dev no longer lists ${provider}/${id} — update the pins and regenerate the fixture`)
    }
  }
})
