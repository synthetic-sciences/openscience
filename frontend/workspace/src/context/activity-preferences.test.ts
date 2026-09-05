import { describe, expect, test } from "bun:test"
import { activityExpanded, activityPreferenceKey, readActivityMode, writeActivityMode } from "./activity-preferences"

describe("activity view preference", () => {
  test("detailed activity remains visible after completion while compact activity folds", () => {
    expect(activityExpanded("detailed", undefined, true)).toBe(true)
    expect(activityExpanded("detailed", undefined, false)).toBe(true)
    expect(activityExpanded("compact", undefined, true)).toBe(true)
    expect(activityExpanded("compact", undefined, false)).toBe(false)
  })

  test("explicit opening and closing override both the mode and the working default", () => {
    for (const mode of ["detailed", "compact"] as const) {
      for (const working of [true, false]) {
        expect(activityExpanded(mode, false, working)).toBe(false)
        expect(activityExpanded(mode, true, working)).toBe(true)
      }
    }
  })

  test("new installs show detail and an explicit compact choice survives reopening", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    expect(readActivityMode(storage)).toBe("detailed")
    writeActivityMode("compact", storage)
    expect(readActivityMode(storage)).toBe("compact")
    writeActivityMode("detailed", storage)
    expect(readActivityMode(storage)).toBe("detailed")
    values.set(activityPreferenceKey, "invalid")
    expect(readActivityMode(storage)).toBe("detailed")
  })

  test("blocked storage cannot break conversation rendering or controls", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(readActivityMode(storage)).toBe("detailed")
    expect(() => writeActivityMode("compact", storage)).not.toThrow()
  })
})
