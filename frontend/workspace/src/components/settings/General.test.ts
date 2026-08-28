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
    expect(source).toContain('title="Workspace"')
    expect(source).toContain('id: "personal", label: "Personal"')
    expect(source).toContain("sdk.client.account.fundingContext.set")
    expect(event).toBeGreaterThan(-1)
    expect(funding.indexOf("await loadAccount()")).toBeGreaterThan(event)
    expect(source).toContain("Provider keys and subscriptions stay personal.")
  })

  test("shows a fresh browser sign-in instead of a failing picker for a scoped workspace key", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    expect(source).toContain("account()?.funding_context?.locked !== true")
    expect(source).toContain("sdk.client.account.loginBrowser()")
    expect(source).toContain('"Change account"')
    expect(source).toContain("Sign in again to choose Personal or another team.")
  })
})
