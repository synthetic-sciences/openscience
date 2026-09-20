import { describe, expect, test } from "bun:test"
import { readSource, writeSource } from "./last-source"

const storage = () => {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

/** A sandboxed frame throws on the property access itself, not on the call. */
const sealed = () => ({
  getItem: () => {
    throw new DOMException("denied", "SecurityError")
  },
  setItem: () => {
    throw new DOMException("denied", "SecurityError")
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError")
  },
})

describe("the source the picker was left on", () => {
  test("reads back the source it was told to remember", () => {
    const store = storage()
    writeSource("fsg_1", store)

    expect(readSource(store)).toBe("fsg_1")
  })

  test("forgets the source when the pick is cleared, as revoking a grant does", () => {
    const store = storage()
    writeSource("fsg_1", store)
    writeSource(undefined, store)

    expect(readSource(store)).toBeUndefined()
    expect(store.items.size).toBe(0)
  })

  test("treats an empty stored value as no preference rather than an unnamed source", () => {
    const store = storage()
    store.setItem("openscience:files-source", "")

    expect(readSource(store)).toBeUndefined()
  })

  // A preference that cannot be saved is not worth failing a render over, and
  // these run during the pane's render.
  test("survives storage that refuses every access", () => {
    const store = sealed()

    expect(() => writeSource("fsg_1", store)).not.toThrow()
    expect(() => writeSource(undefined, store)).not.toThrow()
    expect(readSource(store)).toBeUndefined()
  })
})
