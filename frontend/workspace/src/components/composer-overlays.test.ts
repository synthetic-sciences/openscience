import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"

const root = fileURLToPath(new URL("../..", import.meta.url))
const Response = (await Bun.fetch("data:text/plain,")).constructor as typeof globalThis.Response

// The composer's model and effort popovers read the whole local/sync context;
// the menus under test only need a route that offers both chips.
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
  set: () => {},
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
export const useGlobalSync = () => ({ refreshProviders: async () => {} })
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
const vite = await createServer({
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
const [overlays, tools, folder, models, web, fixture] = await Promise.all([
  vite.ssrLoadModule("/src/components/overlay-group.ts") as Promise<typeof import("./overlay-group")>,
  vite.ssrLoadModule("/src/components/composer-tools.tsx") as Promise<typeof import("./composer-tools")>,
  vite.ssrLoadModule("/src/components/working-folder.tsx") as Promise<typeof import("./working-folder")>,
  vite.ssrLoadModule("/src/components/model-settings-popover.tsx") as Promise<
    typeof import("./model-settings-popover")
  >,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  vite.ssrLoadModule("\0composer-state") as Promise<{ setState: (...args: unknown[]) => void }>,
])

const cleanups: Array<() => void> = []
afterAll(() => vite.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

const route = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: { id: "openrouter", name: "openrouter", source: "managed" },
  capabilities: { reasoning: true },
  variants: { low: {}, medium: {}, high: {} },
  modes: { fast: {} },
  reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"], default: "medium" }],
  contextOptions: [272000, 1050000],
  limit: { context: 1050000 },
  cost: { input: 5.275, output: 31.65 },
}

const snapshot = () => ({
  workspace: { scratchRoot: "/scratch" },
  toolDirectory: "/research/RINR",
  grants: [{ source: "api", scope: "project", access: "write", path: "/research/RINR", time: { created: 1 } }],
})

/** The four composer menus on one surface, each the component the composer
 * renders: the Tools shell that carries the composer's registration, the folder
 * chip, and the model and effort popovers. Only the body of Tools stands in for
 * the composer's — it reads the whole session context, while the menu it lives
 * in does not. */
async function compose() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(snapshot()),
  })
  cleanups.push(() => void server.stop(true))
  fixture.setState({ models: [route], index: 0, effort: {}, tier: {} })
  const host = document.createElement("div")
  document.body.append(host)
  const closed = { count: 0 }
  cleanups.push(
    web.render(() => {
      const action = document.createElement("button")
      action.type = "button"
      action.dataset.composerToolsItem = ""
      action.textContent = "MCP servers"
      return [
        web.createComponent(tools.ComposerTools, {
          children: action,
          onClose: () => (closed.count += 1),
        }),
        folder.WorkingFolderChip({
          client: createOpenScienceClient({ baseUrl: server.url.origin, fetch: Bun.fetch }),
          sessionID: "ses_fixture",
          pending: undefined,
          onPending() {},
        }),
        web.createComponent(models.ModelSettingsPopover, {}),
      ]
    }, host),
  )
  await until(() => host.querySelector(".working-folder summary") !== null)
  const details = (selector: string) => host.querySelector<HTMLDetailsElement>(selector)!
  // A Kobalte popover keeps its content mounted between openings; the trigger's
  // aria-expanded is the state it publishes to the person reading the composer.
  const popover = (selector: string) => () => host.querySelector(selector)!.getAttribute("aria-expanded") === "true"
  const click = (selector: string) => host.querySelector<HTMLElement>(selector)!.click()
  return {
    closed,
    tools: {
      open: () => click("[data-composer-tools] summary"),
      isOpen: () => details("[data-composer-tools]").open,
      menu: () => details("[data-composer-tools]"),
      item: () => host.querySelector<HTMLElement>("[data-composer-tools-item]")!,
    },
    folder: {
      open: () => click(".working-folder summary"),
      isOpen: () => details("details.working-folder").open,
      menu: () => details("details.working-folder"),
      item: () => host.querySelector<HTMLElement>(".working-folder__option")!,
    },
    model: {
      open: () => click("[data-model-settings-trigger]"),
      isOpen: popover("[data-model-settings-trigger]"),
    },
    effort: {
      open: () => click("[data-model-effort-chip]"),
      isOpen: popover("[data-model-effort-chip]"),
    },
  }
}

const pairs = [
  ["tools", "model"],
  ["tools", "effort"],
  ["tools", "folder"],
  ["folder", "model"],
  ["folder", "effort"],
] as const

for (const [first, second] of pairs) {
  test(`the ${first} and ${second} composer menus close each other`, async () => {
    const menus = await compose()
    menus[first].open()
    await settle()
    expect(menus[first].isOpen()).toBe(true)

    menus[second].open()
    await settle()
    expect(menus[second].isOpen()).toBe(true)
    expect(menus[first].isOpen()).toBe(false)

    menus[first].open()
    await settle()
    expect(menus[first].isOpen()).toBe(true)
    expect(menus[second].isOpen()).toBe(false)
  })
}

for (const name of ["folder", "tools"] as const) {
  test(`a pointerdown outside the ${name} menu closes it, one inside keeps it open`, async () => {
    const menus = await compose()
    menus[name].open()
    await settle()
    expect(menus[name].isOpen()).toBe(true)

    // On a row of the menu, not on the `<details>` itself: pressing an option
    // is the gesture that must not dismiss the menu under the finger already
    // on it, and it is the one that reaches the deepest node.
    menus[name].item().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    expect(menus[name].isOpen()).toBe(true)

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    expect(menus[name].isOpen()).toBe(false)
  })

  test(`Escape closes the ${name} menu and returns focus to its summary`, async () => {
    const menus = await compose()
    menus[name].open()
    await settle()
    expect(menus[name].isOpen()).toBe(true)

    menus[name].menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(menus[name].isOpen()).toBe(false)
    // Its own summary, not one belonging to a `<details>` nested in its body.
    expect(document.activeElement).toBe(menus[name].menu().querySelector(":scope > summary"))
  })
}

// The Tools menu contains a `<details>` of its own, so "the summary" is
// ambiguous unless the binding says which one it means. Escape from inside the
// nested one still has to land on the menu the reader was in.
test("Escape returns focus to the menu's own summary, not one nested inside it", async () => {
  const menus = await compose()
  const nested = document.createElement("details")
  nested.innerHTML = "<summary>Action approval</summary>"
  menus.tools.item().before(nested)
  menus.tools.open()
  await settle()

  nested.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))

  expect(menus.tools.isOpen()).toBe(false)
  expect(document.activeElement).toBe(menus.tools.menu().querySelector(":scope > summary"))
})

// The composer leaves sub-menus open inside Tools. Whoever closes Tools —
// another composer menu claiming the surface included — has to report it, or
// the next opening starts on a sub-menu nobody chose.
test("the Tools menu reports every close, including one another menu caused", async () => {
  const menus = await compose()
  menus.tools.open()
  await settle()
  expect(menus.closed.count).toBe(0)

  menus.folder.open()
  await settle()

  expect(menus.tools.isOpen()).toBe(false)
  expect(menus.closed.count).toBe(1)
})

// The ids are a module singleton. A second live member under one id takes the
// first one's closer out of the map, leaving a menu the group can no longer
// close — silently, until someone notices two menus on screen at once.
test("an overlay id registered twice while still registered is reported", () => {
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
  try {
    const group = overlays.createOverlayGroup()
    group.register("tools", () => {})
    group.register("tools", () => {})
    expect(warnings.join(" ")).toContain("tools")

    // A remount is not a collision: the outgoing member unregisters, and the
    // one that replaces it takes the id back without a word.
    warnings.length = 0
    const remounted = overlays.createOverlayGroup()
    remounted.register("tools", () => {})()
    remounted.register("tools", () => {})
    expect(warnings).toEqual([])
  } finally {
    console.warn = warn
  }
})
