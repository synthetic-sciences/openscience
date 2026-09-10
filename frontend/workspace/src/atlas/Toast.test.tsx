import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Platform } from "@/context/platform"

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

const runtime = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const store = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const platform = (await server.ssrLoadModule("/src/context/platform.tsx")) as typeof import("../context/platform")
const persist = (await server.ssrLoadModule("/src/utils/persist.ts")) as typeof import("../utils/persist")
const subject = (await server.ssrLoadModule("/src/atlas/Toast.tsx")) as typeof import("./Toast")
const uiToast = (await server.ssrLoadModule("@synsci/ui/toast")) as typeof import("@synsci/ui/toast")

const cleanups: Array<() => void> = []
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const webPlatform = { platform: "web" } as Platform

afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original)
  return server.close()
})

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  uiToast.toaster.clear()
  document.body.replaceChildren()
})

function quotaStorage(limit: number) {
  const items = new Map<string, string>()
  const storage = {
    get length() {
      return items.size
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      const used = [...items.values()].reduce((sum, item) => sum + item.length, 0)
      const next = used - (items.get(key)?.length ?? 0) + value.length
      if (next > limit) throw new DOMException("quota exceeded", "QuotaExceededError")
      items.set(key, value)
    },
    removeItem: (key: string) => items.delete(key),
    clear: () => items.clear(),
  }
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
}

function mountContainer() {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(() => web.createComponent(subject.ToastContainer, {}), host)
  cleanups.push(dispose)
  return dispose
}

function composer(key: string) {
  return runtime.createRoot((dispose) => {
    cleanups.push(dispose)
    let setState: ReturnType<typeof store.createStore<{ prompt: string }>>[1] | undefined
    platform.PlatformProvider({
      value: webPlatform,
      get children() {
        ;[, setState] = persist.persisted(persist.Persist.global(key), store.createStore({ prompt: "" }))
        return undefined
      },
    })
    return setState!
  })
}

function refuse(key: string) {
  const setState = composer(key)
  setState("prompt", "x".repeat(1000))
  persist.flushPersisted()
  return setState
}

const visibleToasts = () => document.querySelectorAll('[data-component="toast"]')

describe("persistence failure toast", () => {
  test("shows one accessible notification however many stores are failing", () => {
    quotaStorage(200)
    mountContainer()

    refuse("toast-first")
    refuse("toast-second")

    const region = document.querySelector('[role="region"][aria-label="Notifications"]')
    const notification = document.querySelector<HTMLElement>('[data-component="toast"]')
    expect(region).not.toBeNull()
    expect(visibleToasts()).toHaveLength(1)
    expect(notification?.getAttribute("role")).toBe("status")
    expect(notification?.getAttribute("aria-live")).toBe("assertive")
    expect(notification?.getAttribute("aria-atomic")).toBe("true")
    expect(notification?.textContent).toContain("Not saved in this browser")
    expect(notification?.textContent).toContain("Remove it to start saving again")
    expect(notification?.querySelector('button[aria-label="Dismiss"]')).not.toBeNull()
  })

  test("takes the notification back once the store saves again", () => {
    quotaStorage(200)
    mountContainer()

    const setState = refuse("toast-recovered")
    expect(visibleToasts()).toHaveLength(1)

    setState("prompt", "short")
    persist.flushPersisted()

    expect(visibleToasts()).toHaveLength(0)
  })

  test("keeps the notification up while another store is still failing", () => {
    quotaStorage(200)
    mountContainer()

    const first = refuse("toast-one")
    refuse("toast-two")
    expect(visibleToasts()).toHaveLength(1)

    first("prompt", "short")
    persist.flushPersisted()

    expect(visibleToasts()).toHaveLength(1)
  })

  test("takes the notification down on unmount and can raise it again on remount", () => {
    quotaStorage(200)
    const dispose = mountContainer()
    refuse("toast-mounted")
    expect(visibleToasts()).toHaveLength(1)

    dispose()
    cleanups.splice(cleanups.indexOf(dispose), 1)
    expect(visibleToasts()).toHaveLength(0)

    refuse("toast-unmounted")
    expect(visibleToasts()).toHaveLength(0)

    mountContainer()
    refuse("toast-remounted")
    expect(visibleToasts()).toHaveLength(1)
  })
})
