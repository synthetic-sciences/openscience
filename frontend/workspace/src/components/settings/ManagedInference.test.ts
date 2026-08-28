import { expect, test } from "bun:test"
import { canSelectManaged, commitBilling, formatCreditBalance, walletBalanceLabel } from "./ManagedInference"

const source = await Bun.file(new URL("./ManagedInference.tsx", import.meta.url)).text()

test("presents the two actual routing contracts", () => {
  const accounts = source.indexOf('title: "BYOK / Subscription"')
  const managed = source.indexOf('title: "Managed"')

  expect(accounts).toBeGreaterThan(-1)
  expect(managed).toBeGreaterThan(accounts)
  expect(source).toContain('value: "managed"')
  expect(source).toContain('value: "byok"')
  expect(source).not.toContain('title: "Automatic"')
  expect(source).toContain("platform.openLink(URLS.dashboardBilling)")
})

test("keeps a real negative wallet balance distinct from an unavailable balance", () => {
  expect(walletBalanceLabel({ signedIn: true, balanceUsd: -1 })).toBe("$-1.00 balance")
  expect(walletBalanceLabel({ signedIn: true, balanceUsd: null })).toBe("Balance unavailable")
  expect(walletBalanceLabel({ signedIn: false, balanceUsd: -1 })).toBe("Not signed in")
})

test("formats the purchased-credit balance to exact cents", () => {
  expect(formatCreditBalance(984)).toBe("$984.00")
  expect(formatCreditBalance(984.6)).toBe("$984.60")
  expect(formatCreditBalance(0)).toBe("$0.00")
})

test("allows Managed whenever the server authorizes Wallet or reload access", () => {
  expect(canSelectManaged(undefined)).toBe(false)
  expect(
    canSelectManaged({ signedIn: false, managedSupported: true, aceEnabled: true, balanceUsd: 20, billingMode: null }),
  ).toBe(false)
  expect(
    canSelectManaged({ signedIn: true, managedSupported: false, aceEnabled: true, balanceUsd: 20, billingMode: null }),
  ).toBe(false)
  expect(
    canSelectManaged({ signedIn: true, managedSupported: true, aceEnabled: false, balanceUsd: 20, billingMode: null }),
  ).toBe(true)
  expect(
    canSelectManaged({ signedIn: true, managedSupported: true, aceEnabled: true, balanceUsd: 0, billingMode: null }),
  ).toBe(true)
})

// The provider catalog is intentionally not part of this helper. It is a
// multi-megabyte follow-up synchronization; including it here used to keep all
// three routing buttons disabled long after the small billing write had saved.
test("resolves as soon as the billing write is applied", async () => {
  const order: string[] = []
  const applied: number[] = []

  const ok = await commitBilling<{ llm: string }>(
    async () => {
      order.push("write")
      return { data: { llm: "managed" } }
    },
    (data) => {
      order.push("apply")
      applied.push(data.llm.length)
    },
  )

  expect(ok).toBe(true)
  expect(order).toEqual(["write", "apply"])
  expect(applied).toEqual(["managed".length])
})

test("does not apply when the write comes back without data", async () => {
  const order: string[] = []
  let applyCalls = 0

  const ok = await commitBilling<{ llm: string }>(
    async () => {
      order.push("write")
      return {}
    },
    () => applyCalls++,
  )

  expect(ok).toBe(false)
  expect(order).toEqual(["write"])
  expect(applyCalls).toBe(0)
})

test("propagates a write rejection without applying data", async () => {
  let applyCalls = 0

  const rejection = commitBilling<{ llm: string }>(
    async () => {
      throw new Error("network down")
    },
    () => applyCalls++,
  )

  await expect(rejection).rejects.toThrow("network down")
  expect(applyCalls).toBe(0)
})
