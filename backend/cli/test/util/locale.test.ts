import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

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
