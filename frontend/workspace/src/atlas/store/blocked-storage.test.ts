import { describe, expect, test } from "bun:test"
import { createArtifactState } from "../../artifacts/context"
import { defaultWorkspaceScope } from "./scope"
import { createSessionTabs } from "./sessionTabs"
import { createContextState } from "./ui"

/** A sandboxed frame, a denied origin or `dom.storage.enabled=false` makes
 *  reading the `localStorage` global throw. These three factories run at module
 *  scope, so an unguarded read takes the whole workspace down instead of just
 *  losing persistence. */
function withStorage<T>(items: Map<string, string>, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      if (items === blocked) throw new Error("storage blocked")
      return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
      }
    },
  })
  try {
    return fn()
  } finally {
    // `original` is undefined when `localStorage` is not an own property of
    // globalThis, which is the usual case. Skipping the restore then left the
    // throwing getter installed for every later test file in the run, because
    // the suite shares globals. Delete the property we added instead.
    if (original) Object.defineProperty(globalThis, "localStorage", original)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
}

const blocked = new Map<string, string>()

describe("state when browser storage is blocked", () => {
  test("context, session tabs and artifacts still start", () => {
    withStorage(blocked, () => {
      expect(() => createContextState()).not.toThrow()
      expect(() => createSessionTabs()).not.toThrow()
      expect(() => createArtifactState()).not.toThrow()
    })
  })

  test("context state works in memory, with persistence quietly off", () => {
    withStorage(blocked, () => {
      const state = createContextState()
      expect(state.open()).toBe(false)
      state.activateScope("project-a", "session-a")
      state.openFile("/work/a", "results/a.csv")
      expect(state.scope()).toBeTruthy()
    })
  })

  test("a working storage is still read, so persistence is not silently lost", () => {
    const items = new Map([
      [
        "openscience-context-state-v2",
        JSON.stringify({ version: 2, scopes: { [defaultWorkspaceScope()]: { open: true, mode: "files" } } }),
      ],
    ])
    withStorage(items, () => {
      const state = createContextState()
      // Restored only if browserStorage() handed the real global through.
      expect(state.open()).toBe(true)
      expect(state.scope()).toBe(defaultWorkspaceScope())
    })
  })
})
