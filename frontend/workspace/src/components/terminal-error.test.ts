import { describe, expect, test } from "bun:test"
import { connectionError } from "./terminal-error"
import { backoff } from "./terminal"

describe("connectionError", () => {
  test("passes an Error through untouched", () => {
    const cause = new Error("Session not found")
    expect(connectionError(cause)).toBe(cause)
  })

  test("wraps the bare error Event WebKit fires when a socket drops", () => {
    const wrapped = connectionError(new Event("error"))
    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped.message).toBe("Connection to the server was lost.")
  })

  test("wraps any other non-Error rejection", () => {
    expect(connectionError(undefined).message).toBe("Connection to the server was lost.")
    expect(connectionError("boom").message).toBe("Connection to the server was lost.")
  })
})

describe("backoff", () => {
  test("doubles from 250 ms across five reconnect attempts", () => {
    expect([1, 2, 3, 4, 5].map(backoff)).toEqual([250, 500, 1000, 2000, 4000])
  })

  test("gives up once the attempt budget is spent so the loss gets reported", () => {
    expect(backoff(6)).toBeUndefined()
    expect(backoff(60)).toBeUndefined()
  })
})
