import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"

const root = fileURLToPath(new URL("../..", import.meta.url))
const context = `
import { createStore } from "solid-js/store"
import { modelVariantDefault, modelVariantOptions, normalizedVariant, promptVariant } from "@/context/model-variant"
import { modelContextOptions } from "@/context/model-context"
export const [state, setState] = createStore({ models: [], index: 0, effort: {}, tier: {}, billing: "managed" })
const current = () => state.models[state.index]
const key = () => current()?.provider.id + "/" + current()?.id
const variants = () => Object.keys(current()?.variants ?? {})
const fallback = () => current() ? modelVariantDefault(current()) : undefined
export const useLocal = () => ({ model: {
  current, list: () => state.models, recent: () => [], pinned: () => [], visible: () => true,
  pin: { has: () => false },
  set: value => setState("index", state.models.findIndex(model => model.id === value.modelID && model.provider.id === value.providerID)),
  variant: {
    list: () => modelVariantOptions(variants(), fallback()),
    current: () => normalizedVariant(state.effort[key()], variants(), fallback()),
    set: value => setState("effort", key(), promptVariant(value, variants(), fallback())),
  },
  tier: {
    list: () => ["standard", ...Object.keys(current()?.modes ?? {})],
    current: () => state.tier[key()] ?? "standard",
    set: value => setState("tier", key(), value),
  },
  context: {
    list: () => current() ? modelContextOptions(current()) : [],
    current: () => current()?.limit.context ?? 0,
    set: () => {},
  },
} })
export const useSync = () => ({ data: { config: { get billing() { return { llm: state.billing } } } } })
export const events = { refresh: async () => {} }
export const useGlobalSync = () => ({ refreshProviders: () => events.refresh() })
export const useDialog = () => ({ show: () => {} })
export const DialogSettings = () => undefined
`
const imports = new Set([
  "@/context/local",
  "@/context/sync",
  `${root}/src/context/local`,
  `${root}/src/context/sync`,
  `${root}/src/context/global-sync`,
  "@synsci/ui/context/dialog",
  "./dialog-settings",
])
const server = await createServer({
  configFile: false,
  root,
  logLevel: "silent",
  plugins: [
    {
      name: "isolated-composer-state",
      enforce: "pre",
      resolveId: (id) => (imports.has(id) ? "\0composer-state" : undefined),
      load: (id) => (id === "\0composer-state" ? context : undefined),
    },
    solid({ ssr: false, dev: false }),
  ],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { alias: { "@": `${root}/src` }, conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await server.ssrLoadModule(
  "/src/components/model-settings-popover.tsx",
)) as typeof import("./model-settings-popover")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const fixture = (await server.ssrLoadModule("\0composer-state")) as {
  state: { index: number; effort: Record<string, string>; tier: Record<string, string> }
  setState: (...args: unknown[]) => void
  events: { refresh: () => Promise<void> }
}
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  fixture.events.refresh = async () => {}
  fixture.setState("billing", "managed")
})
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
const route = (providerID: string, variants: string[]) => ({
  id: providerID === "openrouter" ? "openai/gpt-5.6-sol" : "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: { id: providerID, name: providerID, source: providerID === "openrouter" ? "managed" : "custom" },
  capabilities: { reasoning: true },
  variants: Object.fromEntries(variants.map((variant) => [variant, {}])),
  modes: { fast: {} },
  reasoningOptions: [{ type: "effort", values: variants, default: "medium" }],
  contextOptions: [272000, 1050000],
  limit: { context: 1050000 },
  // Wallet rates carry the 5.5% funding fee: a $5 / $30 provider price.
  cost: { input: 5.275, output: 31.65 },
  pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
})
const mount = () => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => web.createComponent(subject.ModelSettingsPopover, {}), host))
  return host
}

test("redacted provider variants retain the real composer effort and Fast controls across route changes", async () => {
  fixture.setState({
    models: [
      route("openrouter", ["none", "low", "medium", "high", "xhigh", "max"]),
      route("openai-codex", ["low", "medium", "high", "xhigh", "max"]),
    ],
    index: 0,
    effort: {},
    tier: {},
  })
  const host = mount()
  const chip = () => host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")
  // Research defaults to the deepest ordinary effort the route offers.
  expect(chip()?.textContent).toContain("High")
  chip()!.click()
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(6)
  expect(document.querySelector('[data-model-option-id="none"]')?.textContent).toContain("Off")
  document.querySelector<HTMLButtonElement>('[data-model-option-id="xhigh"]')!.click()
  document.querySelector<HTMLInputElement>("[data-model-fast-toggle] input")!.click()
  await settle()
  expect(fixture.state.effort["openrouter/openai/gpt-5.6-sol"]).toBe("xhigh")
  expect(fixture.state.tier["openrouter/openai/gpt-5.6-sol"]).toBe("fast")
  expect(chip()?.textContent).toContain("Extra high")
  expect(host.querySelector("[data-model-fast-indicator]")).not.toBeNull()

  fixture.setState("index", 1)
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(5)
  expect(document.querySelector('[data-model-option-id="none"]')).toBeNull()
  expect(chip()?.textContent).toContain("High")
  expect(host.querySelector("[data-model-fast-indicator]")).toBeNull()
})

test("the composer's Fast toggle shows its price consequence from the route's catalog rates", async () => {
  const model = route("openrouter", ["low", "medium", "high"])
  fixture.setState({
    models: [
      {
        ...model,
        modes: {
          fast: {
            pricing: { upstream_provider: "openrouter", hosting_provider: "openai", funding_fee_bps: 0 },
            cost: { input: 10.55, output: 63.3, cache: { read: 1, write: 0 } },
          },
        },
      },
    ],
    index: 0,
    effort: {},
    tier: {},
  })
  const host = mount()
  host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!.click()
  await settle()
  expect(document.querySelector("[data-model-fast-toggle]")).not.toBeNull()
  // The footer row states the rate in force for the selections above, so
  // toggling Fast moves the numbers there; nothing else on the surface
  // repeats them.
  const text = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim()
  const rate = () =>
    [text("[data-model-rate] .model-settings-heading"), text("[data-model-rate] .model-settings-rate-value")].join(" ")
  expect(document.querySelector("[data-model-fast-rate]")).toBeNull()
  expect(rate()).toBe("Rate $5.275 in · $31.65 out /1M tokens")
  document.querySelector<HTMLInputElement>("[data-model-fast-toggle] input")!.click()
  await settle()
  expect(fixture.state.tier["openrouter/openai/gpt-5.6-sol"]).toBe("fast")
  expect(rate()).toBe("Rate $10.55 in · $63.30 out /1M tokens")
  expect(document.querySelector("[data-model-rate-basis]")).toBeNull()
  expect(document.querySelector("[data-model-rate]")?.getAttribute("title")).toBe("Wallet rates")
})

test("the composer labels variable Wallet rates as maxima and keeps exact native rates unqualified", async () => {
  const model = route("openrouter", ["low", "medium", "high"])
  fixture.setState({
    models: [
      {
        ...model,
        pricing: { ...model.pricing, billing_basis: "provider_reported_cost" },
        cost: { ...model.cost, tiers: [{ input: 10.55, output: 63.3, threshold: 272000 }] },
        modes: {},
      },
    ],
    index: 0,
    effort: {},
    tier: {},
  })
  const host = mount()
  host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!.click()
  await settle()
  const rate = () => document.querySelector("[data-model-rate]")!
  expect(rate().textContent).toContain("Up to $5.275 in · Up to $31.65 out")
  expect(rate().getAttribute("title")).toBe("Wallet maximum input and output rates")
  expect(document.querySelector("[data-model-rate-step]")?.textContent).toContain("Up to $10.55 in · Up to $63.30 out")
  expect(rate().textContent).not.toMatch(/OpenRouter|provider|fee|%/i)
  fixture.setState("models", 0, "pricing", "billing_basis", "azure_token_usage")
  await settle()
  expect(rate().textContent).toContain("$5.275 in · $31.65 out")
  expect(rate().textContent).not.toContain("Up to")
  expect(rate().getAttribute("title")).toBe("Wallet rates")
})

test("a provider metadata refresh restores options without replacing the chosen model", async () => {
  const model = route("openrouter", [])
  fixture.setState({
    models: [{ ...model, modes: {}, contextOptions: [1050000], pricing: undefined }],
    index: 0,
    effort: {},
    tier: {},
  })
  const host = mount()
  const chip = host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!
  expect(chip.textContent).toContain("Options")
  chip.click()
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(0)
  expect(document.querySelector("[data-model-fast-toggle]")).toBeNull()
  const refresh = () => document.querySelector<HTMLButtonElement>("[data-model-options-refresh]")!
  let complete: (() => void) | undefined
  let calls = 0
  fixture.events.refresh = async () => {
    calls++
    await new Promise<void>((resolve) => (complete = resolve))
    throw new Error("offline")
  }
  refresh().click()
  await settle()
  expect(refresh().disabled).toBe(true)
  refresh().click()
  expect(calls).toBe(1)
  complete!()
  await settle()
  await settle()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not refresh")
  expect(refresh().disabled).toBe(false)
  fixture.events.refresh = async () => {
    fixture.setState("models", 0, route("openrouter", ["none", "low", "medium", "high", "xhigh", "max"]))
  }
  refresh().click()
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(6)
  expect(document.querySelector("[data-model-fast-toggle]")).not.toBeNull()
  expect(host.querySelector("[data-model-settings-trigger]")?.textContent).toContain("5.6 Sol")
  expect(host.querySelector("[data-model-effort-chip]")?.textContent).toContain("High")
})

test("reviewed effort stays usable while pricing-gated Fast settings are unavailable", async () => {
  const model = route("openrouter", ["none", "low", "medium", "high", "xhigh", "max"])
  fixture.setState({ models: [{ ...model, modes: {}, pricing: undefined }], index: 0, effort: {}, tier: {} })
  const host = mount()
  const chip = host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!
  expect(chip.textContent).toContain("High")
  chip.click()
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(6)
  expect(document.querySelector("[data-model-fast-toggle]")).toBeNull()
  expect(document.body.textContent).toContain(
    "Current Ace rates have not loaded. Verified effort choices are still available.",
  )
  document.querySelector<HTMLButtonElement>('[data-model-option-id="high"]')!.click()
  expect(fixture.state.effort["openrouter/openai/gpt-5.6-sol"]).toBe("high")
  expect(chip.textContent).toContain("High")
})

const served = (input: { id: string; name: string; provider: string; label: string; source: string }) => ({
  ...route(input.provider, []),
  id: input.id,
  name: input.name,
  provider: { id: input.provider, name: input.label, source: input.source },
})
const funded = [
  served({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", label: "OpenAI", source: "custom" }),
  served({ id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "anthropic", label: "Anthropic", source: "api" }),
  served({
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    provider: "openrouter",
    label: "OpenRouter",
    source: "managed",
  }),
  served({ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "google", label: "Google", source: "env" }),
  served({
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    provider: "openrouter",
    label: "OpenRouter",
    source: "managed",
  }),
  served({ id: "qwen3:32b", name: "Qwen3 32B", provider: "ollama", label: "Ollama", source: "config" }),
]
const byline = (selector: string) =>
  document.querySelector(`${selector} .model-settings-model small`)?.textContent?.replace(/\s+/g, " ").trim()
const openMenu = async (host: HTMLElement) => {
  host.querySelector<HTMLButtonElement>("[data-model-settings-trigger]")!.click()
  await settle()
}

test("a model served by a key and by the Wallet says which one the row selects, and selects it", async () => {
  fixture.setState({ models: funded, index: 0, effort: {}, tier: {}, billing: "byok" })
  const host = mount()
  await openMenu(host)
  const opus = '[data-model-quick][data-model-choice="anthropic/claude-opus-5-5"]'
  expect(byline('[data-model-quick][aria-checked="true"]')).toBe("Subscription · OpenAI · 1.05M context")
  expect(byline(opus)).toBe("Your key · Anthropic · 1.05M context")
  expect(document.querySelector(opus)?.getAttribute("aria-label")).toBe("Opus 5.5, Anthropic, Your key")

  fixture.setState("billing", "managed")
  await settle()
  expect(byline(opus)).toBe("Wallet · Anthropic · 1.05M context")
  document.querySelector<HTMLButtonElement>(opus)!.click()
  await settle()
  expect(funded[fixture.state.index]?.provider).toEqual({ id: "openrouter", name: "OpenRouter", source: "managed" })
})

test("All models keeps a choice on the credential already in use", async () => {
  fixture.setState({ models: funded, index: 1, effort: {}, tier: {}, billing: "managed" })
  const host = mount()
  await openMenu(host)
  document.querySelector<HTMLButtonElement>('[data-model-menu-row="model"]')!.click()
  await settle()
  const gemini = '[data-model-catalog-item][data-model-choice="google/gemini-3-7-flash"]'
  const local = '[data-model-catalog-item][data-model-choice="ollama/qwen3:32b"]'
  // Opus runs on the Anthropic key, which Gemini has no route through, so the Model access mode decides.
  expect(byline(gemini)).toBe("Wallet · Reasoning · 1.05M context · Google")
  expect(byline(local)).toBe("Local · Reasoning · 1.05M context · Ollama")

  fixture.setState("billing", "byok")
  await settle()
  expect(byline(gemini)).toBe("Your key · Reasoning · 1.05M context · Google")

  // On the Wallet's Opus route the next choice stays on the Wallet whatever the mode says.
  fixture.setState("index", 2)
  await settle()
  expect(byline(gemini)).toBe("Wallet · Reasoning · 1.05M context · Google")
  document.querySelector<HTMLButtonElement>(gemini)!.click()
  await settle()
  expect(funded[fixture.state.index]?.id).toBe("google/gemini-3.7-flash")
})

test("the composer switches maximum Standard quotes to exact direct Fast rates", async () => {
  const model = route("openrouter", ["low", "medium", "high"])
  fixture.setState({
    models: [
      {
        ...model,
        pricing: { ...model.pricing, billing_basis: "provider_reported_cost" },
        modes: {
          fast: {
            cost: { input: 10, output: 60, cache: { read: 1, write: 0 } },
            pricing: {
              upstream_provider: "openrouter",
              hosting_provider: "openai",
              funding_fee_bps: 0,
              billing_basis: "openai_token_usage",
            },
          },
        },
      },
    ],
    index: 0,
    effort: {},
    tier: {},
  })
  const host = mount()
  host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!.click()
  await settle()
  const row = () => document.querySelector("[data-model-rate]")!
  expect(row().textContent).toContain("Up to $5.275")
  document.querySelector<HTMLInputElement>("[data-model-fast-toggle] input")!.click()
  await settle()
  expect(row().textContent).toContain("$10.00 in")
  expect(row().textContent).not.toMatch(/Up to|OpenAI|OpenRouter|fee|%/)
  expect(row().getAttribute("title")).toBe("Wallet rates")
})
