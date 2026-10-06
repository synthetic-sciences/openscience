import { describe, expect, test } from "bun:test"
import { fromInverted } from "../../src/science/connectors/literature/shared"

describe("fromInverted", () => {
  test("reconstructs a plain abstract in position order", () => {
    expect(fromInverted({ Hello: [0], world: [1] })).toBe("Hello world")
  })

  test("keeps every token sharing a position", () => {
    // Hyphen splits and attached punctuation routinely land two tokens on one
    // position in OpenAlex's inverted index; the last writer used to win.
    expect(fromInverted({ improve: [3], results: [2], "improves.": [3] })).toBe("results improve improves.")
  })

  test("keeps position order across gaps in the index", () => {
    expect(fromInverted({ end: [5], start: [0], middle: [2] })).toBe("start middle end")
  })

  test("ignores negative and non-integer positions", () => {
    expect(fromInverted({ bad: [-1, 1.5], good: [0] })).toBe("good")
  })

  test("returns undefined for missing or empty indexes", () => {
    expect(fromInverted(undefined)).toBeUndefined()
    expect(fromInverted(null)).toBeUndefined()
    expect(fromInverted({})).toBeUndefined()
  })
})
