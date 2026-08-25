import { describe, expect, test } from "bun:test"
import { nextServerHealth, SERVER_FAILURE_THRESHOLD } from "./server"

describe("server health hysteresis", () => {
  test("keeps a usable server through transient probe failures", () => {
    const first = nextServerHealth(true, 0, false)
    const second = nextServerHealth(first.healthy, first.failures, false)

    expect(first).toEqual({ healthy: true, failures: 1 })
    expect(second).toEqual({ healthy: true, failures: 2 })
  })

  test("disconnects after the bounded threshold and recovers immediately", () => {
    const failed = nextServerHealth(true, SERVER_FAILURE_THRESHOLD - 1, false)
    expect(failed).toEqual({ healthy: false, failures: SERVER_FAILURE_THRESHOLD })
    expect(nextServerHealth(failed.healthy, failed.failures, true)).toEqual({ healthy: true, failures: 0 })
  })
})
