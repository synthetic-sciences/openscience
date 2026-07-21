import { describe, expect, test } from "bun:test"
import { wantsJson } from "../../src/web/serve"

describe("wantsJson", () => {
  test("content-type application/json → true", () => {
    expect(wantsJson(null, "application/json")).toBe(true)
  })

  test("accept includes application/json, no text/html → true", () => {
    expect(wantsJson("application/json, text/plain", null)).toBe(true)
  })

  test("browser navigation accept header → false", () => {
    expect(wantsJson("text/html,application/xhtml+xml,*/*", null)).toBe(false)
  })

  test("text/html present alongside application/json → treated as navigation, false", () => {
    expect(wantsJson("text/html,application/json", null)).toBe(false)
  })

  test("wildcard accept → false", () => {
    expect(wantsJson("*/*", null)).toBe(false)
  })

  test("both null → false", () => {
    expect(wantsJson(null, null)).toBe(false)
  })
})
