import { describe, expect, test } from "bun:test"
import { sessionUnavailable } from "./session-availability"

describe("session availability", () => {
  test("recognizes generated and response-shaped not-found errors", () => {
    expect(sessionUnavailable({ name: "NotFoundError", data: { message: "missing" } })).toBe(true)
    expect(sessionUnavailable({ response: { status: 404 } })).toBe(true)
    expect(sessionUnavailable({ error: { statusCode: 404 } })).toBe(true)
  })

  test("does not prune tabs for transient or unrelated failures", () => {
    expect(sessionUnavailable(new Error("Failed to fetch"))).toBe(false)
    expect(sessionUnavailable({ response: { status: 500 } })).toBe(false)
    expect(sessionUnavailable(undefined)).toBe(false)
  })
})
