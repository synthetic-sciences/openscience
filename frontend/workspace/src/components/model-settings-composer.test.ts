import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const root = fileURLToPath(new URL("../..", import.meta.url))
const context = `
import { createStore } from "solid-js/store"
import { modelVariantDefault, modelVariantOptions, normalizedVariant, promptVariant } from "@/context/model-variant"
import { modelContextOptions } from "@/context/model-context"
export const [state, setState] = createStore({ models: [], index: 0, effort: {}, tier: {} })
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
export const useSync = () => ({ data: { config: { billing: { llm: "managed" } } } })
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
  state: { effort: Record<string, string>; tier: Record<string, string> }
  setState: (...args: unknown[]) => void
  events: { refresh: () => Promise<void> }
}
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  fixture.events.refresh = async () => {}
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
  cost: { input: 5, output: 30 },
  pricing: { upstream_provider: "openrouter" },
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
  expect(chip()?.textContent).toContain("Medium")
  chip()!.click()
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(6)
  expect(document.querySelector('[data-model-option-id="none"]')?.textContent).toContain("Off")
  document.querySelector<HTMLButtonElement>('[data-model-option-id="high"]')!.click()
  document.querySelector<HTMLInputElement>("[data-model-fast-toggle] input")!.click()
  await settle()
  expect(fixture.state.effort["openrouter/openai/gpt-5.6-sol"]).toBe("high")
  expect(fixture.state.tier["openrouter/openai/gpt-5.6-sol"]).toBe("fast")
  expect(chip()?.textContent).toContain("High")
  expect(host.querySelector("[data-model-fast-indicator]")).not.toBeNull()

  fixture.setState("index", 1)
  await settle()
  expect(document.querySelectorAll('[data-model-option="effort"]')).toHaveLength(5)
  expect(document.querySelector('[data-model-option-id="none"]')).toBeNull()
  expect(chip()?.textContent).toContain("Medium")
  expect(host.querySelector("[data-model-fast-indicator]")).toBeNull()
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
  expect(host.querySelector("[data-model-effort-chip]")?.textContent).toContain("Medium")
})

test("reviewed effort stays usable while pricing-gated Fast settings are unavailable", async () => {
  const model = route("openrouter", ["none", "low", "medium", "high", "xhigh", "max"])
  fixture.setState({ models: [{ ...model, modes: {}, pricing: undefined }], index: 0, effort: {}, tier: {} })
  const host = mount()
  const chip = host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!
  expect(chip.textContent).toContain("Medium")
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
