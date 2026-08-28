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

describe("General Ace funding", () => {
  test("offers Personal and team Wallet contexts without changing provider credentials", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    const start = source.indexOf("const setFunding")
    const funding = source.slice(start, source.indexOf("return (", start))
    const changed = 'window.dispatchEvent(new Event("openscience:account-changed"))'
    const event = funding.indexOf(changed)
    expect(source).toContain('title="Ace funding"')
    expect(source).toContain('id: "personal", label: "Personal"')
    expect(source).toContain("sdk.client.account.fundingContext.set")
    expect(source.match(new RegExp(changed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2)
    expect(event).toBeGreaterThan(-1)
    expect(funding.indexOf("await loadAccount()")).toBeGreaterThan(event)
    expect(source).toContain("Your keys and subscriptions stay personal.")
  })
})
