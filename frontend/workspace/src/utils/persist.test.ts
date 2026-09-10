import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Platform } from "@/context/platform"
import type { PersistFailure } from "./persist"

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
  const removes: string[] = []
  const used = () => [...items.values()].reduce((sum, value) => sum + value.length, 0)
  // Lets a test make storage itself fail, rather than merely run out of room.
  const fault = { error: undefined as Error | undefined }
  const storage = {
    writes,
    removes,
    fault,
    get length() {
      return items.size
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      writes.push(key)
      if (fault.error) throw fault.error
      const next = used() - (items.get(key)?.length ?? 0) + value.length
      if (next > limit) throw new DOMException("quota exceeded", "QuotaExceededError")
      items.set(key, value)
    },
    removeItem: (key: string) => {
      removes.push(key)
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
const dump = (storage: {
  length: number
  key: (index: number) => string | null
  getItem: (key: string) => string | null
}) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? "") ?? "").join("")

describe("removePersisted outside a Solid owner", () => {
  test("removes with a platform captured earlier, as the layout prune timer must", async () => {
    const storage = quotaStorage(Infinity)
    const target = subject.Persist.session("/work/alpha", "ses_old", "prompt")
    const stored = `${target.storage}:${target.key}`
    storage.setItem(stored, '{"draft":"keep me"}')

    // No owner here: this is a timer callback, not a component.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(() => subject.removePersisted(target)).toThrow()
        subject.removePersisted(target, web)
        resolve()
      }, 0)
    })
    expect(storage.getItem(stored)).toBeNull()
  })
})

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

  test("preserves every existing key when a new value exceeds the quota", () => {
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

    expect(storage.getItem(key("evict"))).toBeNull()
    expect(storage.getItem(key("sibling"))).toHaveLength(150)
    expect(storage.getItem(other)).toHaveLength(150)
    expect(storage.getItem("unrelated")).toHaveLength(50)
  })

  // A permitted 20 MiB attachment reaches the prompt store as a ~26.7 MiB data
  // URL. No browser quota holds that, so the family's own state is worth more
  // than a doomed attempt to make room for it.
  test("refuses a value the family can never hold instead of evicting its siblings", () => {
    const storage = quotaStorage(500)
    const sibling = key("session:s1:layout")
    storage.setItem(sibling, "s".repeat(200))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("attach"), store.createStore({ prompt: "" })),
    )

    setState("prompt", `data:image/png;base64,${"A".repeat(800)}`)
    subject.flushPersisted()

    expect(storage.getItem(key("attach"))).toBeNull()
    expect(storage.getItem(sibling)).toHaveLength(200)
    expect(dump(storage)).not.toContain("data:image/png")
  })

  test("reports the dropped write so the UI can say the draft is not saved", () => {
    quotaStorage(500)
    const failures: PersistFailure[] = []
    cleanups.push(subject.onPersistFailure((failure) => failures.push(failure)))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("reported"), store.createStore({ prompt: "" })),
    )

    setState("prompt", `data:image/png;base64,${"A".repeat(800)}`)
    subject.flushPersisted()
    // Shorter, so the retry gate lets it through, and still far past the
    // quota, so it reaches the listener and is silenced by having been said.
    setState("prompt", `data:image/png;base64,${"A".repeat(700)}`)
    subject.flushPersisted()

    expect(failures).toHaveLength(1)
    expect(failures[0].key).toBe(key("reported"))
  })

  test("keeps its neighbours persisting after a value is refused", () => {
    const storage = quotaStorage(4000)
    const [, setAttach] = mount(() =>
      subject.persisted(subject.Persist.global("refused"), store.createStore({ prompt: "" })),
    )
    const [, setPanel] = mount(() =>
      subject.persisted(subject.Persist.global("neighbour"), store.createStore({ open: false })),
    )

    setAttach("prompt", `data:image/png;base64,${"A".repeat(6000)}`)
    setPanel("open", true)
    subject.flushPersisted()

    expect(storage.getItem(key("refused"))).toBeNull()
    expect(storage.getItem(key("neighbour"))).toBe('{"open":true}')
  })

  test("persists the store again once the oversized value is gone", () => {
    const storage = quotaStorage(4000)
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("recover"), store.createStore({ prompt: "" })),
    )

    setState("prompt", `data:image/png;base64,${"A".repeat(6000)}`)
    subject.flushPersisted()
    expect(storage.getItem(key("recover"))).toBeNull()

    setState("prompt", "back to typing")
    subject.flushPersisted()
    expect(storage.getItem(key("recover"))).toBe('{"prompt":"back to typing"}')
  })

  // The draft that was already saved is the user's work too. Making room for a
  // value that cannot land must not spend it.
  test("leaves an already saved draft readable when the new value is refused", () => {
    const storage = quotaStorage(4000)
    const sibling = key("session:s1:layout")
    storage.setItem(sibling, "s".repeat(200))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("draft"), store.createStore({ prompt: "" })),
    )

    setState("prompt", "a long prompt worth keeping")
    subject.flushPersisted()
    const saved = storage.getItem(key("draft"))
    expect(saved).toBe('{"prompt":"a long prompt worth keeping"}')

    setState("prompt", `data:image/png;base64,${"A".repeat(6000)}`)
    subject.flushPersisted()

    expect(storage.getItem(key("draft"))).toBe(saved)
    expect(storage.getItem(sibling)).toHaveLength(200)
  })

  test("does not retry a multi-megabyte write for a small edit", () => {
    const storage = quotaStorage(4000)
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("edit"), store.createStore({ prompt: "" })),
    )

    setState("prompt", `data:image/png;base64,${"A".repeat(1_500_000)}`)
    subject.flushPersisted()
    const attempts = storage.writes.length

    setState("prompt", `data:image/png;base64,${"A".repeat(1_499_999)}`)
    subject.flushPersisted()
    expect(storage.writes).toHaveLength(attempts)

    setState("prompt", "typing again")
    subject.flushPersisted()
    expect(storage.writes.length).toBeGreaterThan(attempts)
    expect(storage.getItem(key("edit"))).toBe('{"prompt":"typing again"}')
  })

  // Evicting the sibling here would make the write land. Refusing is still the
  // safe outcome: the attempted store is named to the user, while the sibling
  // is state they did not ask to discard.
  test("refuses a value that eviction could have squeezed in, and keeps the sibling", () => {
    const storage = quotaStorage(300)
    const sibling = key("panel")
    storage.setItem(sibling, "s".repeat(100))
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("band"), store.createStore({ text: "" })))

    // 250 bytes: too big for the 200 free, small enough to fit the 300 cap
    // once the 100-byte sibling is gone, and larger than that sibling.
    setState("text", "t".repeat(239))
    subject.flushPersisted()

    expect(storage.getItem(key("band"))).toBeNull()
    expect(storage.getItem(sibling)).toHaveLength(100)
  })

  test("does not remove a sibling even when its value alone could fund the write", () => {
    const storage = quotaStorage(300)
    const sibling = key("name-panel")
    storage.setItem(sibling, "s".repeat(200))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("name-cost"), store.createStore({ text: "" })),
    )

    // The new value would fit after deleting the sibling. That retry is
    // deliberately forbidden because a failed setItem has changed nothing.
    setState("text", "t".repeat(179))
    subject.flushPersisted()

    expect(storage.getItem(key("name-cost"))).toBeNull()
    expect(storage.getItem(sibling)).toHaveLength(200)
  })

  // The decision happens before anything is freed, so a value that cannot fit
  // even with the key's own bytes and every sibling gone never costs a removal.
  test("leaves storage untouched when the write cannot fit even with everything freed", () => {
    const storage = quotaStorage(4000)
    const sibling = key("hopeless-panel")
    storage.setItem(sibling, "s".repeat(200))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("hopeless"), store.createStore({ prompt: "" })),
    )

    setState("prompt", "saved before the attachment")
    subject.flushPersisted()
    const saved = storage.getItem(key("hopeless"))
    expect(saved).toBe('{"prompt":"saved before the attachment"}')
    const removals = storage.removes.length

    setState("prompt", `data:image/png;base64,${"A".repeat(6000)}`)
    subject.flushPersisted()

    expect(storage.getItem(key("hopeless"))).toBe(saved)
    expect(storage.getItem(sibling)).toHaveLength(200)
    expect(storage.removes).toHaveLength(removals)
  })

  // An ordinary draft costs nothing to re-serialize, so it must keep retrying
  // on any shrink; only a payload big enough to stall the composer waits for a
  // halving.
  test("saves a small value again as soon as it fits, without waiting for a halving", () => {
    const storage = quotaStorage(300)
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("small-band"), store.createStore({ text: "" })),
    )

    setState("text", "t".repeat(489))
    subject.flushPersisted()
    expect(storage.getItem(key("small-band"))).toBeNull()

    setState("text", "t".repeat(279))
    subject.flushPersisted()

    expect(storage.getItem(key("small-band"))).toBe(`{"text":"${"t".repeat(279)}"}`)
  })

  test("preserves the current saved copy and its sibling on replacement failure", () => {
    const storage = quotaStorage(240)
    const sibling = key("panel-b")
    storage.setItem(sibling, "s".repeat(50))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("twice"), store.createStore({ text: "" })),
    )

    setState("text", "t".repeat(89))
    subject.flushPersisted()
    const saved = storage.getItem(key("twice"))
    expect(saved).toHaveLength(100)
    const removals = storage.removes.length

    setState("text", "t".repeat(189))
    subject.flushPersisted()

    expect(storage.getItem(key("twice"))).toBe(saved)
    expect(storage.getItem(sibling)).toHaveLength(50)
    expect(storage.removes).toHaveLength(removals)
  })

  test("does not call a failure listener after it unsubscribes", () => {
    const storage = quotaStorage(200)
    const failures: PersistFailure[] = []
    const stop = subject.onPersistFailure((failure) => failures.push(failure))
    stop()
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("stopped"), store.createStore({ text: "" })),
    )

    setState("text", "t".repeat(239))
    subject.flushPersisted()

    expect(storage.getItem(key("stopped"))).toBeNull()
    expect(failures).toHaveLength(0)
  })

  test("keeps flushing other stores when a failure listener throws", () => {
    const storage = quotaStorage(4000)
    cleanups.push(
      subject.onPersistFailure(() => {
        throw new Error("broken toast")
      }),
    )
    const [, setAttach] = mount(() =>
      subject.persisted(subject.Persist.global("observed"), store.createStore({ prompt: "" })),
    )
    const [, setPanel] = mount(() =>
      subject.persisted(subject.Persist.global("after-observer"), store.createStore({ open: false })),
    )

    setAttach("prompt", `data:image/png;base64,${"A".repeat(6000)}`)
    setPanel("open", true)
    subject.flushPersisted()

    expect(storage.getItem(key("observed"))).toBeNull()
    expect(storage.getItem(key("after-observer"))).toBe('{"open":true}')
  })

  test("says the store recovered once a refused key saves again", () => {
    const storage = quotaStorage(500)
    const back: string[] = []
    cleanups.push(subject.onPersistRecovered((key) => back.push(key)))
    const [, setState] = mount(() =>
      subject.persisted(subject.Persist.global("recovered"), store.createStore({ prompt: "" })),
    )

    setState("prompt", `data:image/png;base64,${"A".repeat(800)}`)
    subject.flushPersisted()
    expect(back).toEqual([])

    setState("prompt", "back to typing")
    subject.flushPersisted()

    expect(storage.getItem(key("recovered"))).toBe('{"prompt":"back to typing"}')
    expect(back).toEqual([key("recovered")])
  })

  test("leaves unrelated stores alone when a write cannot fit", () => {
    const storage = quotaStorage(200)
    const other = "openscience.workspace.abc.1.dat:workspace:file-view"
    storage.setItem(other, "x".repeat(150))
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("full"), store.createStore({ text: "" })))

    setState("text", "t".repeat(100))
    subject.flushPersisted()

    expect(storage.getItem(other)).toHaveLength(150)
    expect(storage.getItem(key("full"))).toBeNull()
  })

  // Last: a non-quota error means storage itself is unusable, which disables
  // persistence for the rest of this module's life exactly as it does in the
  // browser, so no test can follow it.
  test("lets a non-quota storage error disable persistence instead of reporting a refusal", () => {
    const storage = quotaStorage(Infinity)
    const failures: PersistFailure[] = []
    cleanups.push(subject.onPersistFailure((failure) => failures.push(failure)))
    const [, setState] = mount(() => subject.persisted(subject.Persist.global("fatal"), store.createStore({ n: 0 })))

    storage.fault.error = new TypeError("storage is gone")
    setState("n", 1)
    subject.flushPersisted()

    expect(failures).toEqual([])
    expect(storage.getItem(key("fatal"))).toBeNull()

    storage.fault.error = undefined
    const [, setLater] = mount(() =>
      subject.persisted(subject.Persist.global("after-fatal"), store.createStore({ n: 0 })),
    )
    setLater("n", 2)
    subject.flushPersisted()

    expect(storage.getItem(key("after-fatal"))).toBeNull()
  })
})
