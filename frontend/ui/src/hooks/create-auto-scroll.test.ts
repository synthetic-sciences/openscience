import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const observers = new Set<Observer>()
const previousObserver = globalThis.ResizeObserver
class Observer {
  targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }
}
Object.assign(globalThis, { ResizeObserver: Observer })
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const reactive = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const hooks = (await vite.ssrLoadModule("/src/hooks/create-auto-scroll.tsx")) as typeof import("./create-auto-scroll")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const fixture = async (working = false) => {
  const scroll = document.createElement("div")
  const content = document.createElement("div")
  const button = document.createElement("button")
  button.setAttribute("aria-expanded", "false")
  content.append(button)
  scroll.append(content)
  document.body.append(scroll)
  const size = { height: 3000, viewport: 500, button: 2750, top: 2500 }
  Object.defineProperties(scroll, {
    scrollHeight: { get: () => size.height },
    clientHeight: { get: () => size.viewport },
    scrollTop: {
      get: () => size.top,
      set: (value: number) => (size.top = Math.max(0, Math.min(value, size.height - size.viewport))),
    },
  })
  content.getBoundingClientRect = () => new DOMRect(0, -size.top, 700, size.height)
  button.getBoundingClientRect = () => new DOMRect(0, size.button - size.top, 100, 24)
  const follow = reactive.createRoot((dispose) => {
    cleanups.push(dispose)
    const follow = hooks.createAutoScroll({ working: () => working })
    follow.scrollRef(scroll)
    follow.contentRef(content)
    return follow
  })
  await settle()
  const resize = (target = content) => {
    for (const observer of [...observers]) {
      if (!observer.targets.has(target)) continue
      const rect = target === content ? content.getBoundingClientRect() : new DOMRect(0, 0, 700, size.viewport)
      const box = [{ inlineSize: rect.width, blockSize: rect.height }]
      observer.callback(
        [{ target, contentRect: rect, borderBoxSize: box, contentBoxSize: box, devicePixelContentBoxSize: box }],
        observer,
      )
    }
  }
  resize()
  return { scroll, content, button, size, follow, resize }
}

afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
afterAll(async () => {
  Object.assign(globalThis, { ResizeObserver: previousObserver })
  await vite.close()
})

describe("conversation scroll anchoring", () => {
  test.each([false, true])(
    "disclosure keeps its viewport position during earlier-content expansion (working=%s)",
    async (working) => {
      const view = await fixture(working)
      const before = view.button.getBoundingClientRect().top
      view.button.addEventListener("click", () => {
        view.size.height += 4000
        view.size.button += 4000
      })
      view.button.click()
      view.resize()
      expect(view.button.getBoundingClientRect().top).toBe(before)
      expect(view.follow.userScrolled()).toBe(true)
    },
  )

  test("native anchor correction is not counted twice, including keyboard-generated clicks", async () => {
    const view = await fixture()
    const before = view.button.getBoundingClientRect().top
    view.button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }))
    view.size.height += 1000
    view.size.button += 1000
    view.size.top += 1000
    view.resize()
    expect(view.button.getBoundingClientRect().top).toBe(before)
    expect(view.size.top).toBe(3500)
  })

  test("manual scrolling cancels disclosure restoration and resume releases the old anchor", async () => {
    const view = await fixture(true)
    view.button.click()
    view.scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }))
    view.size.top -= 40
    view.size.height += 500
    view.size.button += 500
    view.resize()
    expect(view.size.top).toBe(2460)
    view.button.click()
    view.follow.resume()
    view.size.height += 200
    view.resize()
    expect(view.size.top).toBe(view.size.height - view.size.viewport)
  })

  test("viewport resizing keeps live bottom-follow without recapturing a detached reader", async () => {
    const view = await fixture(true)
    view.size.viewport = 300
    view.resize(view.scroll)
    expect(view.size.top).toBe(2700)
    view.size.top = 1000
    view.follow.handleScroll()
    view.size.viewport = 200
    view.resize(view.scroll)
    expect(view.size.top).toBe(1000)
  })

  test.each(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "])(
    "manual %s scrolling releases a disclosure anchor before the next resize",
    async (key) => {
      const view = await fixture(true)
      view.button.click()
      view.scroll.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      view.size.top -= 40
      view.size.height += 500
      view.size.button += 500
      view.resize()
      expect(view.size.top).toBe(2460)
    },
  )

  test.each(["Enter", " "])("%s disclosure activation keeps its viewport anchor", async (key) => {
    const view = await fixture()
    const before = view.button.getBoundingClientRect().top
    view.button.click()
    view.button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    view.size.height += 500
    view.size.button += 500
    view.resize()
    expect(view.button.getBoundingClientRect().top).toBe(before)
    view.button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }))
    view.size.height -= 500
    view.size.button -= 500
    view.resize()
    expect(view.button.getBoundingClientRect().top).toBe(before)
  })
})
