import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const stores = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await server.ssrLoadModule("/src/atlas/PaneResizer.tsx")) as typeof import("./PaneResizer")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const shield = () => document.querySelector<HTMLElement>("[data-pane-resize-shield]")
const pointer = (target: EventTarget, type: string, init: PointerEventInit = {}) => {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 7,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 700,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  )
}
const mount = (
  preferredWidth?: number,
  options: { edge?: "left" | "right"; min?: number; max?: number; width?: number } = {},
) => {
  const [state, setState] = stores.createStore({
    owner: "project-a",
    disabled: false,
    width: options.width ?? 500,
    max: options.max ?? 1400,
  })
  const committed: number[] = []
  const resets: number[] = []
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      subject.PaneResizer({
        get owner() {
          return state.owner
        },
        get disabled() {
          return state.disabled
        },
        get width() {
          return state.width
        },
        get max() {
          return state.max
        },
        controls: "inspector",
        preferredWidth,
        edge: options.edge,
        min: options.min,
        onResize: (value) => setState("width", value),
        onCommit: (value) => committed.push(value),
        onReset: () => resets.push(1),
      }),
    host,
  )
  cleanups.push(dispose)
  const handle = host.querySelector<HTMLElement>("[role=separator]")!
  const captures = new Set<number>()
  // Happy DOM has no native pointer capture. Only this browser primitive is
  // substituted; all event listeners, ownership and cleanup use the component.
  handle.setPointerCapture = (id) => {
    captures.add(id)
  }
  handle.hasPointerCapture = (id) => captures.has(id)
  handle.releasePointerCapture = (id) => {
    captures.delete(id)
  }
  return { state, setState, committed, resets, handle, captures, dispose }
}

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  document.body.style.removeProperty("cursor")
})

describe("workspace pane separator", () => {
  test("captures a drag above iframe previews and cleans up without touching the body cursor", async () => {
    document.body.style.cursor = "crosshair"
    const view = mount()
    await settle()
    const iframe = document.createElement("iframe")
    document.body.append(iframe)
    pointer(view.handle, "pointerdown")
    expect(view.captures.has(7)).toBe(true)
    expect(shield()?.style.cursor).toBe("ew-resize")
    expect(shield()?.style.position).toBe("fixed")
    expect(shield()?.style.zIndex).toBe("2147483647")
    expect(document.body.style.cursor).toBe("crosshair")
    pointer(shield()!, "pointermove", { clientX: 100 })
    expect(view.state.width).toBe(1100)
    pointer(window, "pointerup", { pointerId: 8 })
    expect(shield()).not.toBeNull()
    pointer(window, "pointerup", { clientX: 100, buttons: 0 })
    expect(view.committed).toEqual([1100])
    expect(shield()).toBeNull()
    expect(view.captures.size).toBe(0)
    expect(document.body.style.cursor).toBe("crosshair")
    pointer(window, "pointermove", { clientX: 50 })
    expect(view.state.width).toBe(1100)
  })

  for (const end of ["pointercancel", "lostpointercapture", "blur", "buttons-released"] as const) {
    test(`terminates and saves once on ${end}`, async () => {
      const view = mount()
      await settle()
      pointer(view.handle, "pointerdown")
      pointer(window, "pointermove", { clientX: 600 })
      if (end === "blur") window.dispatchEvent(new Event("blur"))
      else if (end === "buttons-released") pointer(window, "pointermove", { buttons: 0 })
      else pointer(end === "lostpointercapture" ? view.handle : window, end)
      expect(shield()).toBeNull()
      expect(view.committed).toEqual([600])
      pointer(window, "pointerup")
      expect(view.committed).toEqual([600])
    })
  }

  test("visibility loss releases the drag even without pointerup", async () => {
    const view = mount()
    await settle()
    pointer(view.handle, "pointerdown")
    const prior = Object.getOwnPropertyDescriptor(document, "visibilityState")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    try {
      document.dispatchEvent(new Event("visibilitychange"))
      expect(shield()).toBeNull()
      expect(view.committed).toEqual([500])
    } finally {
      if (prior) Object.defineProperty(document, "visibilityState", prior)
      else Reflect.deleteProperty(document, "visibilityState")
    }
  })

  test("handles capture/release failures without a stuck cursor shield", async () => {
    const view = mount()
    await settle()
    view.handle.setPointerCapture = () => {
      throw new Error("capture unavailable")
    }
    view.handle.hasPointerCapture = () => true
    view.handle.releasePointerCapture = () => {
      throw new Error("already detached")
    }
    pointer(view.handle, "pointerdown")
    pointer(shield()!, "pointermove", { clientX: 600 })
    pointer(shield()!, "pointerup")
    expect(shield()).toBeNull()
    expect(view.committed).toEqual([600])
  })

  test("Escape restores the original width without persisting a partial drag", async () => {
    const view = mount()
    await settle()
    pointer(view.handle, "pointerdown")
    pointer(window, "pointermove", { clientX: 300 })
    expect(view.state.width).toBe(900)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(view.state.width).toBe(500)
    expect(view.committed).toEqual([])
    expect(shield()).toBeNull()
  })

  test("Escape preserves the preferred width when a narrow window temporarily clamps it", async () => {
    const view = mount(1200)
    await settle()
    pointer(view.handle, "pointerdown")
    pointer(window, "pointermove", { clientX: 600 })
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(view.state.width).toBe(1200)
    expect(view.committed).toEqual([])
    expect(shield()).toBeNull()
  })

  test("a hidden pane or changed project cancels without saving into another project", async () => {
    const view = mount()
    await settle()
    pointer(view.handle, "pointerdown")
    pointer(window, "pointermove", { clientX: 600 })
    view.setState({ owner: "project-b", width: 800 })
    await settle()
    expect(shield()).toBeNull()
    pointer(window, "pointerup")
    expect(view.committed).toEqual([])
    expect(view.state.width).toBe(800)
    pointer(view.handle, "pointerdown")
    view.setState("disabled", true)
    await settle()
    expect(shield()).toBeNull()
    expect(view.handle.hidden).toBe(true)
    expect(view.handle.tabIndex).toBe(-1)
    expect(view.committed).toEqual([])
  })

  test("unmount removes global listeners and pointer shield", async () => {
    const view = mount()
    await settle()
    pointer(view.handle, "pointerdown")
    view.dispose()
    expect(shield()).toBeNull()
    pointer(window, "pointermove", { clientX: 300 })
    pointer(window, "pointerup")
    expect(view.state.width).toBe(500)
    expect(view.committed).toEqual([])
  })

  test("ignores secondary buttons and unrelated pointers", async () => {
    const view = mount()
    await settle()
    pointer(view.handle, "pointerdown", { button: 2 })
    expect(shield()).toBeNull()
    pointer(view.handle, "pointerdown", { isPrimary: false })
    expect(shield()).toBeNull()
    pointer(view.handle, "pointerdown")
    pointer(window, "pointermove", { pointerId: 9, clientX: 200 })
    expect(view.state.width).toBe(500)
  })

  test("keyboard sizing is accessible, bounded, faster with Shift, and supports Home/End", async () => {
    const view = mount()
    await settle()
    const key = (key: string, shiftKey = false) =>
      view.handle.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      )
    expect(view.handle.getAttribute("aria-controls")).toBe("inspector")
    expect(view.handle.getAttribute("aria-valuenow")).toBe("500")
    key("ArrowLeft")
    expect(view.state.width).toBe(516)
    key("ArrowRight", true)
    expect(view.state.width).toBe(452)
    key("Home")
    expect(view.state.width).toBe(320)
    key("ArrowRight")
    expect(view.state.width).toBe(320)
    key("End")
    expect(view.state.width).toBe(1400)
    expect(view.handle.getAttribute("aria-valuetext")).toBe("1400 pixels")
    view.setState("max", 650)
    key("End")
    expect(view.state.width).toBe(650)
    expect(view.handle.getAttribute("aria-valuemax")).toBe("650")
    view.handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(view.resets).toEqual([1])
    view.setState("disabled", true)
    key("Home")
    expect(view.state.width).toBe(650)
    expect(view.committed.at(-1)).toBe(650)
  })

  test("the session sidebar uses the same cleanup with the opposite resize direction and its own bounds", async () => {
    const view = mount(undefined, { edge: "right", min: 208, max: 320, width: 232 })
    await settle()
    pointer(view.handle, "pointerdown")
    pointer(window, "pointermove", { clientX: 750 })
    expect(view.state.width).toBe(282)
    pointer(window, "pointermove", { clientX: 1200 })
    expect(view.state.width).toBe(320)
    window.dispatchEvent(new Event("blur"))
    expect(view.committed).toEqual([320])
    expect(shield()).toBeNull()
    view.handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    expect(view.state.width).toBe(304)
    view.handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(view.state.width).toBe(320)
    view.handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(view.state.width).toBe(208)
    expect(view.handle.getAttribute("aria-valuemin")).toBe("208")
  })
})
