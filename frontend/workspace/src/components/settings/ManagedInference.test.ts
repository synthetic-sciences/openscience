import { expect, test } from "bun:test"
import { commitBilling } from "./ManagedInference"

// commitBilling is the write-then-refresh ordering ManagedInference.update()
// depends on: a mode switch must land in the provider catalog without a
// reload, which only happens if refreshProviders() runs strictly after the
// billing write resolves — and never runs at all on a failed write. These
// tests exercise the real exported function with plain async stand-ins for
// the SDK call and refreshProviders(), asserted on call order rather than
// timing, so no live backend or SDK/globalSync mocking is needed.

test("refreshes the provider catalog only after the write resolves and its data is applied", async () => {
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
    async () => {
      order.push("refresh")
    },
  )

  expect(ok).toBe(true)
  expect(order).toEqual(["write", "apply", "refresh"])
  expect(applied).toEqual(["managed".length])
})

test("does not refresh when the write comes back without data", async () => {
  const order: string[] = []
  let applyCalls = 0
  let refreshCalls = 0

  const ok = await commitBilling<{ llm: string }>(
    async () => {
      order.push("write")
      return {}
    },
    () => applyCalls++,
    async () => {
      refreshCalls++
    },
  )

  expect(ok).toBe(false)
  expect(order).toEqual(["write"])
  expect(applyCalls).toBe(0)
  expect(refreshCalls).toBe(0)
})

test("propagates a write rejection without applying data or refreshing", async () => {
  let applyCalls = 0
  let refreshCalls = 0

  const rejection = commitBilling<{ llm: string }>(
    async () => {
      throw new Error("network down")
    },
    () => applyCalls++,
    async () => {
      refreshCalls++
    },
  )

  await expect(rejection).rejects.toThrow("network down")
  expect(applyCalls).toBe(0)
  expect(refreshCalls).toBe(0)
})
