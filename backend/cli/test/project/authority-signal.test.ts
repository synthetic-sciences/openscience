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

  test("a fresh watcher behind a stale unsettled entry does not stop its own project over a gap that never named it", async () => {
    // What CI showed: an entry from an earlier project left pending at revision
    // 133, two hundred later revisions for other projects, and every new
    // watcher walking from 132, finding a gap the history could not cover and
    // stopping everything it owned. Only a revision addressed to this project,
    // or to every project, may cost it a resync.
    await using tmp = await tmpdir({ git: true })
    void tmp
    const stale = await AuthoritySignal.publish({
      kind: "filesystem",
      projectID: "prj_stale",
      sessionID: "ses_stale",
      scope: "session",
    })
    for (let index = 0; index < 40; index++) {
      const published = await AuthoritySignal.publish(trust(`prj_other_${index}`))
      await AuthoritySignal.settle(published.revision)
    }
    // Another process's writes are what a gap cannot vouch for.
    await Storage.update<{ history: Array<{ origin: number }> }>(["authority", "revision"], (draft) => {
      for (const item of draft.history) item.origin = process.pid + 1
    })
    const seen: AuthoritySignal.Change[] = []
    const watcher = await AuthoritySignal.watch(
      async (change) => {
        seen.push(change)
        return change.type === "event" && change.event.projectID === "prj_mine"
      },
      1_000_000,
      { projectID: "prj_mine" },
    )
    try {
      await watcher.poll()
      // The stale entry is offered (and declined); nothing in the gap resyncs.
      expect(seen.map((change) => change.type)).not.toContain("resync")
      expect(seen[0]).toMatchObject({ type: "event", revision: stale.revision })
      seen.length = 0
      const mine = await AuthoritySignal.publish(trust("prj_mine"))
      await watcher.poll()
      expect(seen).toEqual([{ type: "event", revision: mine.revision, event: mine.event }])
    } finally {
      await watcher[Symbol.asyncDispose]()
    }
  })

  test("a fresh watcher behind a stale entry still resyncs when the gap did name its project", async () => {
    await using tmp = await tmpdir({ git: true })
    void tmp
    await AuthoritySignal.publish({
      kind: "filesystem",
      projectID: "prj_stale",
      sessionID: "ses_stale",
      scope: "session",
    })
    for (let index = 0; index < 40; index++) {
      const published = await AuthoritySignal.publish(trust(index === 20 ? "prj_mine" : `prj_other_${index}`))
      await AuthoritySignal.settle(published.revision)
    }
    await Storage.update<{ history: Array<{ origin: number }> }>(["authority", "revision"], (draft) => {
      for (const item of draft.history) item.origin = process.pid + 1
    })
    const seen: AuthoritySignal.Change[] = []
    const watcher = await AuthoritySignal.watch(
      async (change) => {
        seen.push(change)
      },
      1_000_000,
      { projectID: "prj_mine" },
    )
    try {
      await watcher.poll()
      expect(seen.some((change) => change.type === "resync")).toBe(true)
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
