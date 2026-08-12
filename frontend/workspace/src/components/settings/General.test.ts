import { describe, expect, test } from "bun:test"
import { commitPreference } from "./preference-write"

describe("General preference writes", () => {
  test("applies the backend-confirmed value only after the write succeeds", async () => {
    const order: string[] = []
    const result = await commitPreference(
      async () => {
        order.push("write")
        return { atlas_enabled: true }
      },
      (value) => order.push(`apply:${value.atlas_enabled}`),
    )

    expect(result).toEqual({ ok: true })
    expect(order).toEqual(["write", "apply:true"])
  })

  test("reports a failed write and leaves current UI state untouched", async () => {
    let applyCalls = 0
    const result = await commitPreference(
      async () => {
        throw new Error("disk is read-only")
      },
      () => applyCalls++,
    )

    expect(result).toEqual({ ok: false, error: "disk is read-only" })
    expect(applyCalls).toBe(0)
  })
})
