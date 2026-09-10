import { describe, expect, test } from "bun:test"
import { AuthoritySignal } from "../../src/project/authority-signal"
import { tmpdir } from "../fixture/fixture"

const trust = (projectID: string) => ({ kind: "trust" as const, projectID, denied: true })

describe("AuthoritySignal.watch", () => {
  test("a watcher that polled past a settled burst replays the events it missed instead of resyncing", async () => {
    await using tmp = await tmpdir({ git: true })
    void tmp
    const seen: AuthoritySignal.Change[] = []
    const watcher = await AuthoritySignal.watch(async (change) => {
      seen.push(change)
    }, 1_000_000)
    try {
      // Two other-process style mutations land and are settled by their
      // publishers before this watcher polls once.
      const first = await AuthoritySignal.publish(trust("prj_first"))
      await AuthoritySignal.settle(first.revision)
      const second = await AuthoritySignal.publish(trust("prj_second"))
      await AuthoritySignal.settle(second.revision)
      const third = await AuthoritySignal.publish({
        kind: "filesystem",
        projectID: "prj_third",
        sessionID: "ses_third",
        scope: "project",
      })
      // Same-process settled events are skipped in the tail; leave the last
      // one pending so the watcher must reach it through the gap.
      await watcher.poll()
      expect(seen.map((change) => change.type)).toEqual(["event", "event", "event"])
      expect(seen.map((change) => change.revision)).toEqual([first.revision, second.revision, third.revision])
      expect(seen.some((change) => change.type === "resync")).toBe(false)
      expect(seen.filter((change) => change.type === "event").map((change) => change.event.kind)).toEqual([
        "trust",
        "trust",
        "filesystem",
      ])
    } finally {
      await watcher[Symbol.asyncDispose]()
    }
  })

  test("a gap older than the retained history still resyncs conservatively", async () => {
    await using tmp = await tmpdir({ git: true })
    void tmp
    const seen: AuthoritySignal.Change[] = []
    const watcher = await AuthoritySignal.watch(async (change) => {
      seen.push(change)
    }, 1_000_000)
    try {
      let last = 0
      for (let index = 0; index < 70; index++) {
        const published = await AuthoritySignal.publish(trust(`prj_${index}`))
        last = published.revision
        if (index < 69) await AuthoritySignal.settle(published.revision)
      }
      await watcher.poll()
      expect(seen[0]).toEqual({ type: "resync", revision: last - 1 })
      expect(seen.at(-1)).toMatchObject({ type: "event", revision: last })
    } finally {
      await watcher[Symbol.asyncDispose]()
    }
  })
})
