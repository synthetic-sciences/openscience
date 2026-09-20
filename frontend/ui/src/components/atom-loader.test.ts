import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import solid from "vite-plugin-solid"
import { createTestServer as createServer } from "../../../workspace/test/vite"
import openscience from "../theme/themes/openscience.json"
import { resolveTheme } from "../theme/resolve"
import type { DesktopTheme } from "../theme/types"

// jsdom has no Path2D and no canvas, which is the environment the wrapper
// must survive: the element stays undefined and the caption reads as text.
const vite = await createServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("@synsci/ui/atom-loader")) as typeof import("./atom-loader")
const cleanups: Array<() => void> = []

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

describe("AtomLoader", () => {
  test("renders the mark with its caption as an attribute and as readable text", () => {
    const host = mount(() => subject.AtomLoader({ size: 120, caption: "Opening session…" }))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("size")).toBe("120")
    expect(loader?.getAttribute("caption")).toBe("Opening session")
    expect(loader?.textContent).toBe("Opening session")
    expect(loader?.hasAttribute("progress")).toBe(false)
    expect(loader?.getAttribute("style")).toContain("--atom-loader-size: 120px")
  })

  test("defaults to a 160 mark captioned Loading", () => {
    const host = mount(() => subject.AtomLoader({}))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("size")).toBe("160")
    expect(loader?.getAttribute("caption")).toBe("Loading")
    expect(loader?.textContent).toBe("Loading")
  })

  test("passes a real progress through and keeps a class", () => {
    const host = mount(() => subject.AtomLoader({ progress: 0.4, class: "pane-loader", caption: "Uploading" }))
    const loader = host.querySelector("synsci-loader.pane-loader")
    expect(loader?.getAttribute("progress")).toBe("0.4")
  })

  test("stays undefined where the canvas cannot draw instead of throwing", () => {
    mount(() => subject.AtomLoader({ caption: "Loading files" }))
    expect(customElements.get("synsci-loader")).toBeUndefined()
  })
})

describe("LoadingScreen", () => {
  test("is a polite status region around a full-size mark", () => {
    const host = mount(() => subject.LoadingScreen({ caption: "Starting workspace" }))
    const screen = host.querySelector('[data-component="loading-screen"]')
    expect(screen?.getAttribute("role")).toBe("status")
    expect(screen?.getAttribute("aria-live")).toBe("polite")
    const loader = screen?.querySelector("synsci-loader")
    expect(loader?.getAttribute("size")).toBe("180")
    expect(loader?.getAttribute("caption")).toBe("Starting workspace")
    expect(screen?.textContent).toBe("Starting workspace")
  })

  test("takes a pane size and a class for the surface it fills", () => {
    const host = mount(() => subject.LoadingScreen({ size: 144, class: "inspector" }))
    const screen = host.querySelector('[data-component="loading-screen"].inspector')
    expect(screen?.querySelector("synsci-loader")?.getAttribute("size")).toBe("144")
    expect(screen?.textContent).toBe("Loading")
  })
})

// The Electron shell has no bundler, so it carries its own copy of the module
// and its own note of the theme's base colours. Both must stay what the
// workspace ships, or the splash and the window stop matching.
describe("desktop splash", () => {
  test("ships the same loader module as the shared UI package", async () => {
    const shared = await Bun.file(new URL("./synsci-loader.js", import.meta.url)).text()
    const splash = await Bun.file(new URL("../../../desktop/src/splash/synsci-loader.js", import.meta.url)).text()
    expect(splash).toBe(shared)
  })

  test("paints the default theme's base background and strong text in both schemes", async () => {
    const resolved = resolveTheme(openscience as DesktopTheme)
    const splash = await Bun.file(new URL("../../../desktop/src/splash/theme.json", import.meta.url)).json()
    for (const mode of ["light", "dark"] as const) {
      expect(splash[mode]).toEqual({
        "background-base": resolved[mode]["background-base"],
        "text-strong": resolved[mode]["text-strong"],
      })
    }
  })
})
