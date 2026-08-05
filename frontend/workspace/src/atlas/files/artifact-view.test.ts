import { describe, expect, test } from "bun:test"
import { DEFAULT_VIEW, readView, writeView, type View } from "./artifact-view"

const store = (seed?: string) => {
  const map = new Map<string, string>()
  if (seed !== undefined) map.set("openscience:artifacts-view", seed)
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

describe("artifact view state", () => {
  test("round-trips a choice", () => {
    const storage = store()
    const view: View = { sort: "name", layout: "list", sizes: true }

    writeView(view, storage)

    expect(readView(storage)).toEqual(view)
  })

  test("falls back to the default rather than rendering a broken toolbar", () => {
    expect(readView(store())).toEqual(DEFAULT_VIEW)
    expect(readView(store("not json at all"))).toEqual(DEFAULT_VIEW)
    expect(readView(store('{"sort":"sideways","layout":"grid","sizes":false}'))).toEqual(DEFAULT_VIEW)
    expect(readView(store('{"sort":"name"}'))).toEqual(DEFAULT_VIEW)
  })

  // Private-mode browsers throw on access rather than returning null.
  test("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }

    expect(readView(hostile)).toEqual(DEFAULT_VIEW)
    expect(() => writeView(DEFAULT_VIEW, hostile)).not.toThrow()
  })
})
