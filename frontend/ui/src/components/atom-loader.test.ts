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

  test("names the mark with its caption for assistive tech", () => {
    // The component's own caption is aria-hidden and its canvas says only
    // "Loading", so the caption has to be the host's accessible name.
    const host = mount(() => subject.AtomLoader({ caption: "Opening session…" }))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("role")).toBe("img")
    expect(loader?.getAttribute("aria-label")).toBe("Opening session")
  })

  test("defaults to a 160 mark captioned Loading", () => {
    const host = mount(() => subject.AtomLoader({}))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("size")).toBe("160")
    expect(loader?.getAttribute("caption")).toBe("Loading")
    expect(loader?.getAttribute("aria-label")).toBe("Loading")
    expect(loader?.textContent).toBe("Loading")
  })

  test("passes a real progress through and keeps a class", () => {
    const host = mount(() => subject.AtomLoader({ progress: 0.4, class: "pane-loader", caption: "Uploading" }))
    const loader = host.querySelector("synsci-loader.pane-loader")
    expect(loader?.getAttribute("progress")).toBe("0.4")
  })

  test("a determinate caller gets a progressbar host carrying the value", () => {
    // `img` has presentational children, so the canvas the component labels as
    // a progressbar is pruned under it; the value has to be on the host.
    const host = mount(() => subject.AtomLoader({ progress: 0.4, caption: "Uploading" }))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("role")).toBe("progressbar")
    expect(loader?.getAttribute("aria-valuenow")).toBe("40")
    expect(loader?.getAttribute("aria-valuetext")).toBe("40%")
    expect(loader?.getAttribute("aria-label")).toBe("Uploading")
  })

  test("reports a complete and an untouched determinate mark as 100 and 0", () => {
    const full = mount(() => subject.AtomLoader({ progress: 1 })).querySelector("synsci-loader")
    expect(full?.getAttribute("aria-valuenow")).toBe("100")
    const none = mount(() => subject.AtomLoader({ progress: 0 })).querySelector("synsci-loader")
    expect(none?.getAttribute("role")).toBe("progressbar")
    expect(none?.getAttribute("aria-valuenow")).toBe("0")
  })

  test("an indeterminate mark stays an image with no value", () => {
    const host = mount(() => subject.AtomLoader({ caption: "Loading files" }))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("role")).toBe("img")
    expect(loader?.hasAttribute("aria-valuenow")).toBe(false)
    expect(loader?.hasAttribute("aria-valuetext")).toBe(false)
  })

  test("a progress that is not a real fraction stays indeterminate", () => {
    const host = mount(() => subject.AtomLoader({ progress: Number.NaN }))
    const loader = host.querySelector("synsci-loader")
    expect(loader?.getAttribute("role")).toBe("img")
    expect(loader?.hasAttribute("aria-valuenow")).toBe(false)
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
    expect(loader?.getAttribute("aria-label")).toBe("Starting workspace")
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

  test("ships the same pre-upgrade stylesheet as the shared UI package", async () => {
    const shared = await Bun.file(new URL("./atom-loader-fallback.css", import.meta.url)).text()
    const splash = await Bun.file(
      new URL("../../../desktop/src/splash/atom-loader-fallback.css", import.meta.url),
    ).text()
    expect(splash).toBe(shared)
  })

  test("loads that stylesheet within a policy that allows it", async () => {
    const page = await Bun.file(new URL("../../../desktop/src/splash/splash.html", import.meta.url)).text()
    document.head.innerHTML = page.slice(page.indexOf("<head>") + "<head>".length, page.indexOf("</head>"))
    try {
      const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content
      const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')
      expect(link?.getAttribute("href")).toBe("atom-loader-fallback.css")
      // A same-origin stylesheet needs 'self'; the component's shadow styles
      // and the page's own block still need the inline allowance.
      expect(policy).toContain("style-src 'self' 'unsafe-inline'")
      expect(policy).toContain("default-src 'none'")
    } finally {
      document.head.innerHTML = ""
    }
  })

  test("captions and labels the mark for the state in its URL", async () => {
    const page = await Bun.file(new URL("../../../desktop/src/splash/splash.html", import.meta.url)).text()
    const script = await Bun.file(new URL("../../../desktop/src/splash/splash.js", import.meta.url)).text()
    const markup = page.slice(page.indexOf("<body>") + "<body>".length, page.indexOf("<script"))
    const states = [
      ["start", "Starting your local workspace"],
      ["install", "Installing in Applications"],
    ] as const
    try {
      for (const [state, caption] of states) {
        document.body.innerHTML = markup
        history.replaceState(null, "", `/?state=${state}&scheme=light&background=%23f7f7f7&foreground=%231f1f1f`)
        new Function(script)()
        const loader = document.querySelector<HTMLElement>("synsci-loader")
        expect(loader?.getAttribute("caption")).toBe(caption)
        expect(loader?.getAttribute("aria-label")).toBe(caption)
        expect(loader?.getAttribute("role")).toBe("img")
        // The shared pre-upgrade rules show the element's own text, as the
        // workspace's wrapper does; the splash has no ::after of its own, and
        // it reserves the box from the size the mark will draw at.
        expect(loader?.textContent).toBe(caption)
        expect(loader?.style.getPropertyValue("--atom-loader-size")).toBe(`${loader?.getAttribute("size")}px`)
        expect(document.documentElement.dataset.colorScheme).toBe("light")
        expect(document.documentElement.style.getPropertyValue("--background-base")).toBe("#f7f7f7")
      }
    } finally {
      history.replaceState(null, "", "/")
      delete document.documentElement.dataset.colorScheme
      document.documentElement.removeAttribute("style")
    }
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
