import { expect, test } from "bun:test"
import { sessionTabTarget } from "./session-tab-navigation"

test("horizontal session tabs wrap and support first or last navigation", () => {
  expect(sessionTabTarget("ArrowRight", 0, 3)).toBe(1)
  expect(sessionTabTarget("ArrowRight", 2, 3)).toBe(0)
  expect(sessionTabTarget("ArrowLeft", 0, 3)).toBe(2)
  expect(sessionTabTarget("Home", 2, 3)).toBe(0)
  expect(sessionTabTarget("End", 0, 3)).toBe(2)
})

test("horizontal session tabs ignore unrelated keys and invalid positions", () => {
  expect(sessionTabTarget("ArrowDown", 0, 3)).toBeUndefined()
  expect(sessionTabTarget("ArrowRight", -1, 3)).toBeUndefined()
  expect(sessionTabTarget("ArrowRight", 0, 0)).toBeUndefined()
})
