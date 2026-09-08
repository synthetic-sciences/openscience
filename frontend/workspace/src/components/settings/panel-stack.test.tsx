import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { JSX } from "solid-js"

const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [fixture, web] = await Promise.all([
  server.ssrLoadModule("/src/components/settings/panel-stack.fixture.tsx") as Promise<
    typeof import("./panel-stack.fixture")
  >,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())
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

describe("SettingsPanelStack", () => {
  test("keeps visited panels mounted while exposing only the active panel", async () => {
    let select!: (id: "models" | "network") => void
    const harness = fixture.createPanelStackFixture((next) => (select = next))
    const host = mount(harness.view)

    const models = host.querySelector<HTMLElement>('[data-settings-panel="models"]')!
    const network = host.querySelector<HTMLElement>('[data-settings-panel="network"]')!
    expect(models.hidden).toBe(false)
    expect(models.hasAttribute("inert")).toBe(false)
    expect(models.getAttribute("aria-hidden")).toBeNull()
    expect(network.hidden).toBe(true)
    expect(network.hasAttribute("inert")).toBe(true)
    expect(network.getAttribute("aria-hidden")).toBe("true")

    const modelFilter = host.querySelector<HTMLInputElement>('[aria-label="Model filter"]')!
    modelFilter.focus()
    expect(document.activeElement).toBe(modelFilter)

    select("network")
    await Promise.resolve()
    expect(models.hidden).toBe(true)
    expect(models.hasAttribute("inert")).toBe(true)
    expect(models.getAttribute("aria-hidden")).toBe("true")
    expect(network.hidden).toBe(false)
    expect(network.hasAttribute("inert")).toBe(false)
    expect(network.getAttribute("aria-hidden")).toBeNull()
    expect(document.activeElement).toBe(network)
    select("models")

    expect(harness.mounts).toEqual({ models: 1, network: 1 })
    expect(modelFilter.value).toBe("remember me")
    expect(host.querySelector(".settings-panel-loading")).toBeNull()
  })

  const settle = () => new Promise((done) => setTimeout(done, 0))

  test("a steady resource keeps the panel on screen while it refetches", async () => {
    const harness = fixture.createRefreshingPanelFixture({ steady: true })
    const host = mount(harness.view)
    expect(host.querySelector(".settings-panel-loading")).not.toBeNull()

    harness.resolve(["ollama"])
    await settle()
    const list = host.querySelector<HTMLElement>('[aria-label="Runtimes"]')!
    expect(list.textContent).toBe("ollama")

    harness.refetch()
    await settle()
    expect(host.querySelector(".settings-panel-loading")).toBeNull()
    expect(host.querySelector('[aria-label="Runtimes"]')).toBe(list)

    harness.resolve(["ollama", "lmstudio"])
    await settle()
    expect(list.textContent).toBe("ollamalmstudio")
  })

  test("a plain resource swaps the panel for its skeleton on refetch", async () => {
    const harness = fixture.createRefreshingPanelFixture({ steady: false })
    const host = mount(harness.view)
    harness.resolve(["ollama"])
    await settle()
    expect(host.querySelector('[aria-label="Runtimes"]')).not.toBeNull()

    harness.refetch()
    await settle()
    expect(host.querySelector(".settings-panel-loading")).not.toBeNull()
    expect(host.querySelector('[aria-label="Runtimes"]')).toBeNull()
    harness.resolve([])
  })
})
