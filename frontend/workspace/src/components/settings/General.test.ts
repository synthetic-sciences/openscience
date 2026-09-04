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

describe("General Ace account", () => {
  test("keeps Ace optional while providing login, logout, Wallet, and billing controls", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    expect(source).toContain('title="Ace account"')
    expect(source).toContain('"/account/login-browser"')
    expect(source).toContain('"/account/logout"')
    expect(source).toContain("walletBalanceLabel")
    expect(source).toContain("URLS.dashboardBilling")
    expect(source).toContain("Sign in for Ace or workspace credentials")
    expect(source).toContain('"/account/sync"')
    expect(source).toContain("Retry sync")
    expect(source).not.toMatch(/promotional|promo credit/i)
    expect(source).not.toContain("AccountGate")
    expect(source).not.toContain("DataUse")
  })

  test("switches unlocked funding context locally but reauthorizes locked workspace keys", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    const start = source.indexOf("const setWorkspace")
    const flow = source.slice(start, source.indexOf("onMount", start))
    expect(source).toContain('account()?.credential?.type === "organization"')
    expect(source).toContain("account()?.credential?.legacy === false")
    expect(flow).toContain("!canDirectlySwitchWorkspace()")
    expect(flow).toContain('await login("workspace")')
    expect(flow).toContain('"/account/funding-context"')
    expect(source).toContain("Switch workspace")
    expect(source).toContain("Personal")
    expect(source).toContain("Unavailable")
    expect(source).toContain('organization.membership_status === "active"')
    expect(source).toContain("organization.funding_available !== false")
    expect(source).toContain("organization.use_shared_wallet !== false")
  })
})

describe("General context rows", () => {
  test("exposes the auto-compact threshold row backed by /settings/preferences", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    expect(source).toContain('language.t("settings.general.section.context")')
    expect(source).toContain('language.t("settings.general.context.threshold.title")')
    expect(source).toContain("thresholdOptions(context()?.compaction_threshold)")
    expect(source).toContain("saveContext({ compaction_threshold: option.value })")
    expect(source).toContain('settingsApi<ContextPreferences>(sdk.url, fetchFn, "/settings/preferences", {')
    expect(source).toContain("commitPreference(")
    expect(source).not.toContain("product-preferences")
    expect(source).toContain("<AccountRow")
  })

  test("carries no warn-above-N-tokens row or its field styling", async () => {
    const source = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./preference-panels.css", import.meta.url)).text()
    expect(source).not.toContain("compaction_warn_tokens")
    expect(source).not.toContain("settings.general.context.warn")
    expect(source).not.toContain("@/pages/session-context")
    expect(css).not.toContain("settings-context-tokens")
  })
})
