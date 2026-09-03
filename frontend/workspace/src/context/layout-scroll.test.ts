import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { makePersisted, type SyncStorage } from "@solid-primitives/storage"
import { createScrollPersistence } from "./layout-scroll"

describe("createScrollPersistence", () => {
  test("keeps rapid conversation positions isolated and restores them from persisted snapshots", () => {
    const snapshots: Record<string, Record<string, { x: number; y: number }>> = {}
    const first = createScrollPersistence({
      debounceMs: 1_000,
      getSnapshot: (session) => snapshots[session],
      onFlush: (session, scroll) => {
        snapshots[session] = scroll
      },
    })

    for (const index of Array.from({ length: 20 }, (_, value) => value)) {
      first.setScroll(index % 2 ? "project-a/session-a" : "project-b/session-a", "conversation", {
        x: 0,
        y: index,
      })
    }
    first.flushAll()
    first.dispose()

    const restored = createScrollPersistence({
      getSnapshot: (session) => snapshots[session],
      onFlush: () => {},
    })

    expect(restored.scroll("project-a/session-a", "conversation")).toEqual({ x: 0, y: 19 })
    expect(restored.scroll("project-b/session-a", "conversation")).toEqual({ x: 0, y: 18 })
    expect(restored.scroll("project-a/session-b", "conversation")).toBeUndefined()
    restored.dispose()
  })

  test("debounces persisted scroll writes", async () => {
    const key = "layout-scroll.test"
    const data = new Map<string, string>()
    const writes: string[] = []
    const stats = { flushes: 0 }

    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v)
        if (k === key) writes.push(v)
      },
      removeItem: (k: string) => {
        data.delete(k)
      },
    } as SyncStorage

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const [raw, setRaw] = createStore({
          sessionView: {} as Record<string, { scroll: Record<string, { x: number; y: number }> }>,
        })

        const [store, setStore] = makePersisted([raw, setRaw], { name: key, storage })

        const scroll = createScrollPersistence({
          debounceMs: 30,
          getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
          onFlush: (sessionKey, next) => {
            stats.flushes += 1

            const current = store.sessionView[sessionKey]
            if (!current) {
              setStore("sessionView", sessionKey, { scroll: next })
              return
            }
            setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...(prev ?? {}), ...next }))
          },
        })

        const run = async () => {
          await new Promise((r) => setTimeout(r, 0))
          writes.length = 0

          for (const i of Array.from({ length: 100 }, (_, n) => n)) {
            scroll.setScroll("session", "review", { x: 0, y: i })
          }

          await new Promise((r) => setTimeout(r, 120))

          expect(stats.flushes).toBeGreaterThanOrEqual(1)
          expect(writes.length).toBeGreaterThanOrEqual(1)
          expect(writes.length).toBeLessThanOrEqual(2)
        }

        void run()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            scroll.dispose()
            dispose()
          })
      })
    })
  })
})
