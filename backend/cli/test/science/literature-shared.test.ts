import { describe, expect, test } from "bun:test"
import { fromInverted } from "../../src/science/connectors/literature/shared"

describe("fromInverted", () => {
  test("reconstructs a plain abstract in position order", () => {
    expect(fromInverted({ Hello: [0], world: [1] })).toBe("Hello world")
  })

  test("keeps every token sharing a position", () => {
    expect(fromInverted({ improve: [3], results: [2], "improves.": [3] })).toBe("results improve improves.")
  })

  test("keeps repeated words at distinct positions without repeating duplicate postings", () => {
    expect(fromInverted({ repeat: [2, 0, 0], middle: [1], alternative: [0, 0] })).toBe(
      "repeat alternative middle repeat",
    )
  })

  test("keeps position order across gaps in the index", () => {
    expect(fromInverted({ end: [5], start: [0], middle: [2] })).toBe("start middle end")
  })

  test("handles sparse positions beyond the array-index range", () => {
    expect(fromInverted({ end: [Number.MAX_SAFE_INTEGER], middle: [2 ** 32], start: [0] })).toBe("start middle end")
  })

  test("ignores negative and non-integer positions", () => {
    expect(fromInverted({ bad: [-1, 1.5, NaN, Infinity, -Infinity], good: [0] })).toBe("good")
    expect(fromInverted({ bad: [-1, 1.5, NaN, Infinity], empty: [] })).toBeUndefined()
  })

  test("returns undefined for missing or empty indexes", () => {
    expect(fromInverted(undefined)).toBeUndefined()
    expect(fromInverted(null)).toBeUndefined()
    expect(fromInverted({})).toBeUndefined()
  })
})
