import { describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { subscribeFilesystemEvents } from "../../src/project/filesystem-event-sync"

describe("project filesystem event sync", () => {
  test("uses one global listener for many live project subscribers and detaches it", () => {
    const baseline = GlobalBus.listenerCount("event")
    const counts = Array.from({ length: 12 }, () => 0)
    const releases = counts.map((_, index) =>
      subscribeFilesystemEvents(() => {
        counts[index] += 1
      }),
    )

    expect(GlobalBus.listenerCount("event")).toBe(baseline + 1)
    GlobalBus.emit("event", { payload: { type: "test" } })
    expect(counts).toEqual(Array.from({ length: 12 }, () => 1))

    for (const release of releases.slice(0, -1)) release()
    expect(GlobalBus.listenerCount("event")).toBe(baseline + 1)
    releases.at(-1)?.()
    expect(GlobalBus.listenerCount("event")).toBe(baseline)

    for (const release of releases) release()
    expect(GlobalBus.listenerCount("event")).toBe(baseline)
  })
})
