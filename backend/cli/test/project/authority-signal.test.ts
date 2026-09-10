import { describe, expect, test } from "bun:test"
import { AuthoritySignal } from "../../src/project/authority-signal"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

const trust = (projectID: string) => ({ kind: "trust" as const, projectID, denied: true })

describe("AuthoritySignal.watch", () => {
  test("a watcher that polled past its own process's settled burst does not resync", async () => {
    await using tmp = await tmpdir({ git: true })
    void tmp
    const seen: AuthoritySignal.Change[] = []
    const watcher = await AuthoritySignal.watch(async (change) => {
      seen.push(change)
    }, 1_000_000)
    try {
      // Two mutations from this process land and settle before the watcher
      // polls once; the in-process bus already carried them to every instance.
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
      await watcher.poll()
      expect(seen).toEqual([{ type: "event", revision: third.revision, event: third.event }])
    } finally {
      await watcher[Symbol.asyncDispose]()
    }
  })

  test("a gap holding another process's settled work still resyncs conservatively", async () => {
    await using tmp = await tmpdir({ git: true })
    void tmp
    const seen: AuthoritySignal.Change[] = []
    const watcher = await AuthoritySignal.watch(async (change) => {
      seen.push(change)
    }, 1_000_000)
    try {
      const foreign = await AuthoritySignal.publish(trust("prj_foreign"))
      await AuthoritySignal.settle(foreign.revision)
      // Rewrite the record's memory of that revision as another process's.
      await Storage.update<{ history: Array<{ revision: number; origin: number }> }>(
        ["authority", "revision"],
        (draft) => {
          for (const item of draft.history) if (item.revision === foreign.revision) item.origin = process.pid + 1
        },
      )
      const next = await AuthoritySignal.publish(trust("prj_next"))
      await watcher.poll()
      expect(seen[0]).toEqual({ type: "resync", revision: next.revision - 1 })
      expect(seen[1]).toMatchObject({ type: "event", revision: next.revision })
    } finally {
      await watcher[Symbol.asyncDispose]()
    }
  })
})
