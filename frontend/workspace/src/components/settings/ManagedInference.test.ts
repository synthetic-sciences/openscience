import { expect, test } from "bun:test"
import { commitBilling } from "./ManagedInference"

// commitBilling is the write-then-refresh ordering ManagedInference.update()
// depends on: a mode switch must land in the provider catalog without a
// reload, which only happens if refreshProviders() runs strictly after the
// billing write resolves — and never runs at all on a failed write. These
// tests exercise the real exported function with plain async stand-ins for
// the SDK call and refreshProviders(), asserted on call order rather than
// timing, so no live backend or SDK/globalSync mocking is needed.

// A macrotask hop (setTimeout, not a bare microtask) a refresh stand-in must
// cross before it's "done". An `async () => order.push(...)` stand-in with no
// internal await runs its body synchronously the instant it's *called* —
// whether or not the caller awaits the returned promise — so it can't tell a
// real `await refresh()` apart from a dropped one; both produce the same
// order array. Forcing a real event-loop turn here means the "refresh"
// entry only lands if commitBilling's returned promise genuinely waited for
// it, which is the actual property under test.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("refreshes the provider catalog only after the write resolves and its data is applied, and does not resolve until refresh completes", async () => {
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
      await tick()
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

test("propagates a refresh rejection to the caller instead of swallowing it", async () => {
  // If commitBilling ever called refresh() without awaiting it, this
  // rejection would never reach the caller's .catch(fail) — it would surface
  // as an unhandled promise rejection instead, and commitBilling would
  // resolve `true` as if the refresh had succeeded.
  const rejection = commitBilling<{ llm: string }>(
    async () => ({ data: { llm: "managed" } }),
    () => {},
    async () => {
      await tick()
      throw new Error("refresh failed")
    },
  )

  await expect(rejection).rejects.toThrow("refresh failed")
})
