import { expect, test } from "bun:test"
import { Context } from "../../src/util/context"

test("AsyncLocalStorage contexts preserve provided false, zero and empty-string values", () => {
  const enabled = Context.create<boolean>("enabled")
  const retries = Context.create<number>("retries")
  const label = Context.create<string>("label")
  expect(enabled.provide(false, () => enabled.use())).toBe(false)
  expect(retries.provide(0, () => retries.use())).toBe(0)
  expect(label.provide("", () => label.use())).toBe("")
  expect(() => enabled.use()).toThrow(Context.NotFound)
})

test("nested asynchronous contexts restore their outer value", async () => {
  const ctx = Context.create<number>("level")
  await ctx.provide(0, async () => {
    await Promise.resolve()
    expect(ctx.use()).toBe(0)
    expect(ctx.provide(2, () => ctx.use())).toBe(2)
    expect(ctx.use()).toBe(0)
  })
  expect(() => ctx.use()).toThrow(Context.NotFound)
})
