import { describe, expect, test } from "bun:test"
import { exactRouteFastMode } from "./model-fast"

describe("exact-route fast mode", () => {
  test("is absent when the exact selected route does not advertise fast", () => {
    const selected = { modes: { standard: {} } }
    const logicalSibling = { modes: { standard: {}, fast: {} } }

    expect(exactRouteFastMode(selected, "standard")).toBeUndefined()
    expect(exactRouteFastMode(logicalSibling, "standard")).toEqual({ active: false })
  })

  test("carries the Fast price consequence once the route's pricing has loaded", () => {
    const priced = {
      cost: { input: 5, output: 30 },
      modes: { fast: { cost: { input: 10, output: 60, cache: { read: 1, write: 0 } } } },
    }
    expect(exactRouteFastMode(priced, "fast")).toEqual({
      active: true,
      rate: "2× standard · $10.00 in · $60.00 out per 1M tokens",
    })
    // Without the standard rates the multiple is unknown; the Fast rates still are.
    expect(exactRouteFastMode({ modes: priced.modes }, "standard")).toEqual({
      active: false,
      rate: "$10.00 in · $60.00 out per 1M tokens",
    })
    // A placeholder price before the catalog loads is not "free Fast".
    expect(exactRouteFastMode({ modes: { fast: { cost: { input: 0, output: 0 } } } }, "standard")).toEqual({
      active: false,
    })
    expect(exactRouteFastMode({ modes: { fast: { cost: { input: "10" } } } }, "standard")).toEqual({ active: false })
  })
})
