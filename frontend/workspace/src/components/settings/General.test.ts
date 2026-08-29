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

describe("General workspace switching", () => {
  test("requires browser reauthorization instead of relabeling the active credential locally", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    expect(source).toContain('title="Workspace"')
    expect(source).toContain("Switch workspace")
    expect(source).toContain("sdk.client.account.loginBrowser()")
    expect(source).not.toContain("sdk.client.account.fundingContext.set")
    expect(source).not.toContain("<FilterMenu")
    expect(source).toContain("approve Personal or one of your teams")
  })

  test("keeps the current workspace active while browser approval is pending or fails", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    const start = source.indexOf("const switchWorkspace")
    const flow = source.slice(start, source.indexOf("return (", start))
    const changed = 'window.dispatchEvent(new Event("openscience:account-changed"))'
    const event = flow.indexOf(changed)
    expect(flow.indexOf("sdk.client.account.loginBrowser()")).toBeGreaterThan(-1)
    expect(event).toBeGreaterThan(-1)
    expect(flow.indexOf("await loadAccount()")).toBeGreaterThan(event)
    expect(source).toContain("Your current workspace stays active until approval completes.")
    expect(source).toContain('title: "Workspace unchanged"')
    expect(source).toContain("disabled={fundingBusy()}")
  })

  test("shows the resolved Personal, team, and unavailable workspace labels", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    expect(source).toContain('return "Personal"')
    expect(source).toContain('"Unavailable team"')
    expect(source).toContain("description: `OpenScience is now connected to ${fundingLabel()}.`")
    expect(source).toContain("Switch workspaces to choose Personal or another team.")
  })
})
