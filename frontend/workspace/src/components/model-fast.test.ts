import { describe, expect, test } from "bun:test"
import { exactRouteFastMode } from "./model-fast"

describe("exact-route fast mode", () => {
  test("is absent when the exact selected route does not advertise fast", () => {
    const selected = { modes: { standard: {} } }
    const logicalSibling = { modes: { standard: {}, fast: {} } }

    expect(exactRouteFastMode(selected, "standard")).toBeUndefined()
    expect(exactRouteFastMode(logicalSibling, "standard")).toEqual({ active: false })
  })
})
