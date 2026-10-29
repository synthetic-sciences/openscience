import { describe, expect, test } from "bun:test"
import { Reason } from "../../src/util/reason"

describe("Reason.capture", () => {
  test("distinguishes falsey rejections from successful values", async () => {
    for (const value of [undefined, null, false, 0, ""]) {
      expect(await Reason.capture(Promise.reject(value))).toEqual({ ok: false, error: value })
      expect(await Reason.capture(Promise.resolve(value))).toEqual({ ok: true, value })
    }
  })
})

describe("Reason.of", () => {
  test("keeps the message of an Error rejection", () => {
    expect(Reason.of(new Error("quota exhausted"))).toBe("quota exhausted")
    expect(Reason.of(Object.assign(new Error("boom"), { code: "EACCES" }))).toBe("boom")
    expect(Reason.of(new AggregateError([new Error("one")], "batch"))).toBe("batch")
  })

  test('a rejection may not be an Error instance: strings, objects, and null must render, not "undefined"', () => {
    expect(Reason.of("host unreachable: connection refused")).toBe("host unreachable: connection refused")
    expect(Reason.of({ code: "ETIMEDOUT", syscall: "connect" })).toBe("[object Object]")
    expect(Reason.of(undefined)).toBe("undefined")
    expect(Reason.of(null)).toBe("null")
  })
})
