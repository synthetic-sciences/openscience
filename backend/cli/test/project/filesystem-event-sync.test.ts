import { describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { subscribeFilesystemEvents } from "../../src/project/filesystem-event-sync"

describe("project filesystem event sync", () => {
  test("uses one global listener for many live project subscribers and preserves an existing subscriber", () => {
    const baseline = GlobalBus.listenerCount("event")
    let existingCount = 0
    const releaseExisting = subscribeFilesystemEvents(() => {
      existingCount += 1
    })
    const shared = GlobalBus.listenerCount("event")
    const counts = Array.from({ length: 12 }, () => 0)
    const releases = counts.map((_, index) =>
      subscribeFilesystemEvents(() => {
        counts[index] += 1
      }),
    )

    try {
      // A clean process attaches the shared dispatcher here; a long-lived test
      // or server process may already have it. Either way, another dozen
      // subscribers must not add another EventEmitter listener.
      expect(shared).toBeGreaterThanOrEqual(baseline)
      expect(shared).toBeLessThanOrEqual(baseline + 1)
      expect(GlobalBus.listenerCount("event")).toBe(shared)
      GlobalBus.emit("event", { payload: { type: "test" } })
      expect(existingCount).toBe(1)
      expect(counts).toEqual(Array.from({ length: 12 }, () => 1))

      for (const release of releases.slice(0, -1)) release()
      expect(GlobalBus.listenerCount("event")).toBe(shared)
      releases.at(-1)?.()
      expect(GlobalBus.listenerCount("event")).toBe(shared)

      for (const release of releases) release()
      expect(GlobalBus.listenerCount("event")).toBe(shared)
    } finally {
      for (const release of releases) release()
      releaseExisting()
    }
    expect(GlobalBus.listenerCount("event")).toBe(baseline)
  })
})
