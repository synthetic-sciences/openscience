import { describe, expect, test } from "bun:test"
import {
  aceContractLabel,
  canSelectManaged,
  commitBilling,
  formatCreditBalance,
  walletBalanceLabel,
} from "./ManagedInference"

const source = await Bun.file(new URL("./ManagedInference.tsx", import.meta.url)).text()

describe("Ace model access", () => {
  test("keeps BYOK and Ace as explicit routing contracts", () => {
    expect(source.indexOf('title: "BYOK / Subscription"')).toBeGreaterThan(-1)
    expect(source.indexOf('title: "Ace"')).toBeGreaterThan(source.indexOf('title: "BYOK / Subscription"'))
    expect(source).toContain('id="synsci"')
    expect(source).toContain('settingsApi<LoginResult>(sdk.url, fetchFn, "/account/login-browser"')
    expect(source).toContain("platform.openLink(URLS.dashboardBilling)")
    expect(source).toContain('return "Turn on Ace"')
    expect(source).not.toContain("setInterval")
  })

  test("shows only exact purchased-Wallet dollars", () => {
    expect(formatCreditBalance(984)).toBe("$984.00")
    expect(formatCreditBalance(984.6)).toBe("$984.60")
    expect(walletBalanceLabel({ signedIn: true, balanceUsd: -1 })).toBe("$-1.00 balance")
    expect(walletBalanceLabel({ signedIn: true, balanceUsd: null })).toBe("Balance unavailable")
    expect(walletBalanceLabel({ signedIn: false, balanceUsd: 20 })).toBe("Not signed in")
    expect(source).not.toMatch(/promotional balance|promo credit/i)
  })

  test("renders the server-authoritative authorization and fixed reload terms", () => {
    expect(
      aceContractLabel({
        activationAuthorizationUsd: 0,
        reloadThresholdUsd: 5,
        reloadAmountUsd: 20,
        serviceMarginPercent: 2,
        processingFeeDisclosedSeparately: true,
        reloadControlledByAce: true,
      }),
    ).toBe(
      "Ace is a $0 authorization, not a purchase or subscription. While Ace is on, a purchased Wallet balance below $5 triggers one fixed $20 reload; the processing fee is disclosed separately before payment.",
    )
  })

  test("requires an authorized signed-in Wallet for managed routing", () => {
    expect(canSelectManaged(undefined)).toBe(false)
    expect(
      canSelectManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: false,
        balanceUsd: 20,
        billingMode: null,
      }),
    ).toBe(true)
    expect(
      canSelectManaged({
        signedIn: false,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: true,
        balanceUsd: 20,
        billingMode: null,
      }),
    ).toBe(false)
  })

  test("acknowledges the billing write before catalog refresh", async () => {
    const order: string[] = []
    await commitBilling(
      async () => {
        order.push("write")
        return { llm: "managed" }
      },
      () => order.push("apply"),
    )
    expect(order).toEqual(["write", "apply"])
  })

  test("refreshes account state immediately and provider availability in the background", () => {
    expect(source).toContain('window.addEventListener("openscience:account-changed", accountChanged)')
    expect(source).toContain("void Promise.all([loadWallet(), loadBilling()])")
    expect(source).toContain('void syncProviders("The Ace account changed")')
  })
})
