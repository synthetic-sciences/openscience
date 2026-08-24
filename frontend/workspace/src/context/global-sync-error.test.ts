import { describe, expect, test } from "bun:test"
import { handleInstanceDisposed, syncErrorMessage } from "./global-sync"

describe("global sync errors", () => {
  test("unwraps structured SDK errors instead of rendering object coercions", () => {
    expect(syncErrorMessage({ data: { message: "Project is unavailable" } })).toBe("Project is unavailable")
    expect(syncErrorMessage({ error: { detail: "Session list failed" } })).toBe("Session list failed")
    expect(syncErrorMessage({ status: 503 })).toBe("Request failed with status 503.")
    expect(syncErrorMessage({})).toBe("The server returned an unexpected response.")
    expect(syncErrorMessage({})).not.toBe("[object Object]")
  })
})

describe("instance disposal", () => {
  test("clears stale session status before preserving the normal resync", () => {
    const calls: string[] = []

    handleInstanceDisposed(
      () => calls.push("clear"),
      () => calls.push("sync"),
    )

    expect(calls).toEqual(["clear", "sync"])
  })
})
