import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

describe("Locale.truncate", () => {
  test("clamps the budget to a positive number of characters", () => {
    // A zero or negative budget previously sliced with a negative index and
    // returned a string longer than the requested budget.
    expect(Locale.truncate("abcdefg", 0)).toBe("…")
    expect(Locale.truncate("abcdefg", -3)).toBe("…")
  })

  test("keeps normal truncation exact", () => {
    expect(Locale.truncate("abcdefg", 7)).toBe("abcdefg")
    expect(Locale.truncate("abcdefg", 6)).toBe("abcde…")
  })
})

describe("Locale.truncateMiddle", () => {
  test("does not return the whole string when the budget is smaller than the ellipsis", () => {
    // keepEnd fell to zero and `slice(-0)` captured the entire string, so a
    // one-character budget returned "…" followed by the full input.
    expect(Locale.truncateMiddle("abcdefghij", 1)).toBe("…")
    expect(Locale.truncateMiddle("abcdefghij", 0)).toBe("…")
    expect(Locale.truncateMiddle("abcdefghij", -4)).toBe("…")
  })

  test("keeps the middle truncation exact", () => {
    expect(Locale.truncateMiddle("abcdefghij", 10)).toBe("abcdefghij")
    expect(Locale.truncateMiddle("abcdefghij", 9)).toBe("abcd…ghij")
    expect(Locale.truncateMiddle("abcdefghij", 3)).toBe("a…j")
  })

  test("the truncated middle result never exceeds the budget", () => {
    expect([...Locale.truncateMiddle("abcdefghij", 2)]).toHaveLength(2)
    expect(Locale.truncateMiddle("abcdefghij", 2)).toBe("a…")
  })
})

describe("Locale.duration", () => {
  test("rolls hours into days instead of printing zero days", () => {
    // The day branch divided the remainder mod one hour by one day, so days
    // was always zero and hours ran unbounded.
    expect(Locale.duration(90_000_000)).toBe("1d 1h")
    expect(Locale.duration(172_800_000)).toBe("2d 0h")
  })

  test("keeps the smaller units working", () => {
    expect(Locale.duration(500)).toBe("500ms")
    expect(Locale.duration(1_500)).toBe("1.5s")
    expect(Locale.duration(90_000)).toBe("1m 30s")
    expect(Locale.duration(3_600_000)).toBe("1h 0m")
    expect(Locale.duration(5_400_000)).toBe("1h 30m")
  })
})
