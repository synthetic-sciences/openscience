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
// Sequential: concurrent ssrLoadModule entries can each evaluate their own
// solid-js instance, and the provider below would then hand its context to a
// different runtime than the one persisted() reads it from.
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const store = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const platform = (await server.ssrLoadModule("/src/context/platform.tsx")) as typeof import("../context/platform")
const subject = (await server.ssrLoadModule("/src/utils/persist.ts")) as typeof import("./persist")

const cleanups: Array<() => void> = []
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original)
  return server.close()
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

/** happy-dom's storage has no quota, so simulate the browser limit. */
function quotaStorage(limit: number) {
  const items = new Map<string, string>()
  const writes: string[] = []
  const used = () => [...items.values()].reduce((sum, value) => sum + value.length, 0)
  const storage = {
    writes,
    get length() {
      return items.size
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      writes.push(key)
      const next = used() - (items.get(key)?.length ?? 0) + value.length
      if (next > limit) throw new DOMException("quota exceeded", "QuotaExceededError")
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
    clear: () => items.clear(),
  }
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  return storage
}

const web = { platform: "web" } as Platform

/**
 * Runs `body` under a web PlatformProvider inside a disposable root. The
 * children getter is evaluated inside a memo, so `body` runs untracked the way
 * a component body does; otherwise the store reads in persisted() would make
 * that memo re-run on the hydration write.
 */
function mount<T>(body: () => T) {
  return solidjs.createRoot((dispose) => {
    cleanups.push(dispose)
    const out = { value: undefined as T | undefined }
    platform.PlatformProvider({
      value: web,
      get children() {
        out.value = solidjs.untrack(body)
        return undefined
      },
    })
    return out.value as T
  })
}

const key = (name: string) => `openscience.global.dat:${name}`

describe("persisted local storage", () => {
  test("coalesces a burst of mutations into one write and skips unchanged values", () => {
    const storage = quotaStorage(Infinity)
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("dedupe"), store.createStore({ n: 0 })))

    setState("n", 1)
    setState("n", 2)
    expect(storage.getItem(key("dedupe"))).toBeNull()

    subject.flushPersisted()
    expect(storage.getItem(key("dedupe"))).toBe('{"n":2}')
    expect(storage.writes).toEqual([key("dedupe")])

    setState("n", 2)
    subject.flushPersisted()
    expect(storage.writes).toEqual([key("dedupe")])
  })

  test("serves the queued value to readers before it reaches storage", () => {
    const storage = quotaStorage(Infinity)
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("queued"), store.createStore({ n: 0 })))

    setState("n", 5)
    const [state] = mount(() => subject.persisted(subject.Persist.global("queued"), store.createStore({ n: 0 })))

    expect(state.n).toBe(5)
    expect(storage.getItem(key("queued"))).toBeNull()
  })

  test("flushes queued writes on its own within the cap", async () => {
    const storage = quotaStorage(Infinity)
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("timer"), store.createStore({ n: 0 })))

    setState("n", 1)
    expect(storage.getItem(key("timer"))).toBeNull()
    await Bun.sleep(400)
    expect(storage.getItem(key("timer"))).toBe('{"n":1}')
  })

  test("flushes synchronously before the page is hidden", () => {
    const storage = quotaStorage(Infinity)
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("hide"), store.createStore({ open: false })),
    )

    setState("open", true)
    expect(storage.getItem(key("hide"))).toBeNull()
    window.dispatchEvent(new Event("pagehide"))
    expect(storage.getItem(key("hide"))).toBe('{"open":true}')
  })

  test("evicts only siblings from the same store family when the quota is hit", () => {
    const storage = quotaStorage(400)
    const other = "openscience.workspace.abc.1.dat:workspace:file-view"
    storage.setItem(other, "x".repeat(150))
    storage.setItem(key("sibling"), "y".repeat(150))
    storage.setItem("unrelated", "z".repeat(50))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("evict"), store.createStore({ text: "" })),
    )

    setState("text", "t".repeat(100))
    subject.flushPersisted()

    expect(storage.getItem(key("evict"))).toBe(JSON.stringify({ text: "t".repeat(100) }))
    expect(storage.getItem(key("sibling"))).toBeNull()
    expect(storage.getItem(other)).toHaveLength(150)
    expect(storage.getItem("unrelated")).toHaveLength(50)
  })

  // Last: a write that cannot fit even after eviction disables storage for
  // the rest of this module's life, exactly as it does in the browser.
  test("leaves unrelated stores alone when nothing in the family can be evicted", () => {
    const storage = quotaStorage(200)
    const other = "openscience.workspace.abc.1.dat:workspace:file-view"
    storage.setItem(other, "x".repeat(150))
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("full"), store.createStore({ text: "" })))

    setState("text", "t".repeat(100))
    subject.flushPersisted()

    expect(storage.getItem(other)).toHaveLength(150)
    expect(storage.getItem(key("full"))).toBeNull()
  })
})
