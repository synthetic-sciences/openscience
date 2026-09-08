import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import type { DialogHandle } from "./dialog.fixture"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: globalThis.ResizeObserver ?? Observer })

const vite = await createServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, external: ["fuzzysort"], resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const fixture = (await vite.ssrLoadModule(
  fileURLToPath(new URL("./dialog.fixture.tsx", import.meta.url)),
)) as typeof import("./dialog.fixture")

const cleanups: Array<() => void> = []
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

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

const panels = () =>
  [...document.querySelectorAll<HTMLElement>("[data-dialog-panel]")].map((el) => el.dataset.dialogPanel)

describe("dialog stacking", () => {
  test("a stacked dialog returns to the one underneath when it closes", async () => {
    let dialog!: DialogHandle
    mount(fixture.createDialogFixture((handle) => (dialog = handle)))

    dialog.show(fixture.panel("settings"))
    await settle()
    expect(panels()).toEqual(["settings"])

    let closed = 0
    dialog.show(fixture.panel("confirm"), { onClose: () => closed++, stack: true })
    await settle()
    expect(panels()).toEqual(["settings", "confirm"])

    dialog.close()
    await settle(150)
    expect(closed).toBe(1)
    expect(panels()).toEqual(["settings"])
    expect(dialog.active).toBeDefined()

    dialog.close()
    await settle(150)
    expect(panels()).toEqual([])
    expect(dialog.active).toBeUndefined()
  })

  test("an unstacked dialog still replaces everything that was open", async () => {
    let dialog!: DialogHandle
    mount(fixture.createDialogFixture((handle) => (dialog = handle)))

    dialog.show(fixture.panel("settings"))
    dialog.show(fixture.panel("confirm"), { stack: true })
    await settle()
    expect(panels()).toEqual(["settings", "confirm"])

    dialog.show(fixture.panel("palette"))
    await settle()
    expect(panels()).toEqual(["palette"])
  })

  test("stacking on nothing opens an ordinary dialog", async () => {
    let dialog!: DialogHandle
    mount(fixture.createDialogFixture((handle) => (dialog = handle)))

    dialog.show(fixture.panel("confirm"), { stack: true })
    await settle()
    expect(panels()).toEqual(["confirm"])
    dialog.close()
    await settle(150)
    expect(panels()).toEqual([])
  })
})
