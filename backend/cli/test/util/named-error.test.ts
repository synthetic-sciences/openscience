import { expect, test } from "bun:test"
import { NamedError } from "../../../../tooling/util/src/error"

test("named error predicate handles null and non-error rejection values", () => {
  expect(NamedError.Unknown.isInstance(null)).toBe(false)
  expect(NamedError.Unknown.isInstance(undefined)).toBe(false)
  expect(NamedError.Unknown.isInstance("network failure")).toBe(false)
  expect(NamedError.Unknown.isInstance(0)).toBe(false)
  expect(NamedError.Unknown.isInstance({})).toBe(false)
})

test("named error predicate still recognizes the intended named error", () => {
  const error = new NamedError.Unknown({ message: "failure" })
  expect(NamedError.Unknown.isInstance(error)).toBe(true)
  expect(NamedError.Unknown.isInstance({ name: "UnknownError" })).toBe(true)
  expect(NamedError.Unknown.isInstance(new Error("other"))).toBe(false)
})
