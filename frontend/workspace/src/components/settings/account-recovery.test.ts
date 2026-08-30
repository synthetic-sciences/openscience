import { describe, expect, test } from "bun:test"
import { createAccountRecovery } from "./account-recovery"

describe("account refresh recovery", () => {
  test("automatically retries an incomplete successful response and then stops", async () => {
    const completed = Promise.withResolvers<void>()
    const applied: (number | null)[] = []
    const state = { calls: 0 }
    const recovery = createAccountRecovery({
      read: async () => (++state.calls === 1 ? null : 20),
      apply: (value) => {
        applied.push(value)
        if (value !== null) completed.resolve()
      },
      loading: () => {},
      failed: completed.reject,
      retry: (value) => value === null,
      timeoutMs: 100,
      delays: [1],
    })
    try {
      await recovery.load()
      await completed.promise
      await Bun.sleep(10)
      expect(applied).toEqual([null, 20])
      expect(state.calls).toBe(2)
    } finally {
      recovery.dispose()
    }
  })

  test("deduplicates a request and discards old-workspace results after invalidation", async () => {
    const old = Promise.withResolvers<string>()
    const applied: string[] = []
    const state = { calls: 0, aborted: false }
    const recovery = createAccountRecovery({
      read: (signal) => {
        if (++state.calls > 1) return Promise.resolve("new workspace")
        signal.addEventListener("abort", () => (state.aborted = true))
        return old.promise
      },
      apply: (value) => applied.push(value),
      loading: () => {},
      failed: () => {},
      retry: () => false,
      timeoutMs: 100,
    })
    try {
      const pending = recovery.load()
      expect(recovery.load()).toBe(pending)
      await Promise.resolve()
      recovery.invalidate()
      await recovery.load()
      old.resolve("old workspace")
      await pending
      expect(state.aborted).toBe(true)
      expect(applied).toEqual(["new workspace"])
    } finally {
      recovery.dispose()
    }
  })

  test("a deadline recovers on a later read without waiting for the hung transport", async () => {
    const completed = Promise.withResolvers<void>()
    const state = { calls: 0, errors: 0 }
    const recovery = createAccountRecovery({
      read: () => (++state.calls === 1 ? new Promise<number>(() => {}) : Promise.resolve(20)),
      apply: () => completed.resolve(),
      loading: () => {},
      failed: () => state.errors++,
      retry: () => false,
      timeoutMs: 5,
      delays: [1],
    })
    try {
      await recovery.load()
      await completed.promise
      expect(state.calls).toBe(2)
      expect(state.errors).toBe(1)
    } finally {
      recovery.dispose()
    }
  })

  test("disposing cancels retries and suppresses late results", async () => {
    const late = Promise.withResolvers<number>()
    const applied: number[] = []
    const recovery = createAccountRecovery({
      read: () => late.promise,
      apply: (value) => applied.push(value),
      loading: () => {},
      failed: () => {},
      retry: () => true,
      timeoutMs: 100,
      delays: [1],
    })
    const pending = recovery.load()
    recovery.dispose()
    late.resolve(20)
    await pending
    await recovery.load()
    expect(applied).toEqual([])
  })
})
