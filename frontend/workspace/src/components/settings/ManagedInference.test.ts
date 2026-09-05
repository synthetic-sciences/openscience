import { describe, expect, test } from "bun:test"
import {
  aceContractLabel,
  accountUnavailable,
  canSelectManaged,
  commitBilling,
  formatCreditBalance,
  withAccountDeadline,
  walletBalanceLabel,
} from "./ManagedInference"

const source = await Bun.file(new URL("./ManagedInference.tsx", import.meta.url)).text()

describe("Ace model access", () => {
  test("waits for the server's one account deadline instead of racing its own short timeout", async () => {
    const deadline = await import("./account-deadline")
    // The server bounds account reads at 15 s and propagates that to its
    // outbound fetches; the UI must never give up before that answer lands.
    expect(deadline.ACCOUNT_DEADLINE_MS).toBeGreaterThanOrEqual(15_000)
    expect(source).toContain("timeoutMs: ACCOUNT_DEADLINE_MS")
    expect(source).not.toMatch(/ACCOUNT_TIMEOUT_MS|6_000/)
    const general = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    expect(general).not.toContain("12_000")
    // The import plus the account load and the credential sync.
    expect(general.match(/ACCOUNT_DEADLINE_MS/g)).toHaveLength(3)
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
        accessVerified: true,
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

  test("retries incomplete account reads without treating redacted balances or denials as transient", () => {
    const wallet = {
      signedIn: true,
      accessVerified: true,
      balanceUsd: null,
      billingMode: null,
      managedSupported: true,
      managedUnlocked: false,
      aceEnabled: false,
    } as const
    expect(accountUnavailable(wallet)).toBe(true)
    expect(accountUnavailable({ ...wallet, balanceRedacted: true })).toBe(false)
    expect(accountUnavailable({ ...wallet, managedSupported: false })).toBe(false)
    expect(accountUnavailable({ ...wallet, signedIn: false })).toBe(false)
    expect(source).toContain('state.account !== "ready" || !canSelectManaged(state.wallet)')
  })

  test("a successful balance cannot enable Ace when the access check is unavailable", () => {
    const wallet = {
      signedIn: true,
      balanceUsd: 20,
      billingMode: null,
      managedSupported: true,
      managedUnlocked: true,
      aceEnabled: true,
      accessVerified: false,
    } as const
    expect(canSelectManaged(wallet)).toBe(false)
    expect(accountUnavailable(wallet)).toBe(true)
    expect(accountUnavailable({ ...wallet, balanceRedacted: true })).toBe(true)
    expect(canSelectManaged({ ...wallet, accessVerified: undefined })).toBe(false)
  })

  test("a confirmed access denial stays disabled without an automatic retry loop", () => {
    const wallet = {
      signedIn: true,
      balanceUsd: null,
      billingMode: null,
      managedSupported: false,
      managedUnlocked: false,
      aceEnabled: false,
      accessVerified: true,
    } as const
    expect(canSelectManaged(wallet)).toBe(false)
    expect(accountUnavailable(wallet)).toBe(false)
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

  test("renders useful account controls immediately and recovers from a stalled Wallet read", async () => {
    expect(source).not.toMatch(/Checking account|Checking balance/)
    expect(source).toContain('"/settings/wallet?summary=true"')
    expect(source).toContain('if (state.account === "error") return "Account unavailable"')
    expect(source).toContain('if (state.account === "error") return "Retry"')

    const state = { aborted: false }
    const stalled = withAccountDeadline(
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", () => (state.aborted = true), { once: true })
        }),
      5,
    )
    await expect(stalled).rejects.toThrow("Ace account refresh timed out. Try again.")
    expect(state.aborted).toBe(true)
  })
})
