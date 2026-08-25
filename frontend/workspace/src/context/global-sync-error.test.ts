import { describe, expect, test } from "bun:test"
import { handleInstanceDisposed, syncErrorMessage } from "./global-sync"

const source = Bun.file(new URL("./global-sync.tsx", import.meta.url)).text()

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

describe("event stream recovery", () => {
  test("rebuilds root and project state when a replacement stream connects", async () => {
    const component = await source
    const connected = component.slice(
      component.indexOf('case "server.connected"'),
      component.indexOf('case "global.disposed"'),
    )

    expect(connected).toContain("refresh()")
    expect(connected).toContain("Object.keys(children)")
    expect(connected).toContain("push(directory)")
  })
})
