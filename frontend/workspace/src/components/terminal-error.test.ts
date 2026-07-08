import { describe, expect, test } from "bun:test"
import { connectionError } from "./terminal-error"

describe("connectionError", () => {
  test("passes an Error through untouched", () => {
    const cause = new Error("Session not found")
    expect(connectionError(cause)).toBe(cause)
  })

  test("wraps the bare error Event WebKit fires when a socket drops", () => {
    const wrapped = connectionError(new Event("error"))
    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped.message).toBe("connection to the server was lost")
  })

  test("wraps any other non-Error rejection", () => {
    expect(connectionError(undefined).message).toBe("connection to the server was lost")
    expect(connectionError("boom").message).toBe("connection to the server was lost")
  })
})
