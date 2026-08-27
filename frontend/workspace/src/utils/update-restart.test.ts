import { describe, expect, test } from "bun:test"
import { waitForUpdatedServer, type UpdateHealth } from "./update-restart"

const health = (runId: string, version: string): UpdateHealth => ({ healthy: true, runId, version })

describe("update restart verification", () => {
  test("waits for both a new process and the installed version", async () => {
    const values = [health("old", "2.0.49"), undefined, health("new", "2.0.50")]
    const delays: number[] = []
    const result = await waitForUpdatedServer({
      previous: "old",
      version: "2.0.50",
      check: async () => values.shift(),
      sleep: async (delay) => {
        delays.push(delay)
      },
    })

    expect(result).toEqual(health("new", "2.0.50"))
    expect(delays).toEqual([250, 250])
  })

  test("fails clearly when the old server never changes", async () => {
    await expect(
      waitForUpdatedServer({
        previous: "old",
        version: "2.0.50",
        attempts: 2,
        check: async () => health("old", "2.0.49"),
        sleep: async () => {},
      }),
    ).rejects.toThrow("did not restart in time")
  })
})
