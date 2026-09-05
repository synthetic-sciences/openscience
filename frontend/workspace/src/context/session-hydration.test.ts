import { describe, expect, test } from "bun:test"
import {
  SESSION_MESSAGE_CHUNK,
  createReconnectGenerationGuard,
  mergeHydratedMessages,
  nextReconnectHydrationLimit,
  reconnectHydrationLimit,
  sessionHydrationPlan,
} from "./session-hydration"

const sessionPage = Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()

describe("session transcript hydration", () => {
  test("revisiting a hydrated session refetches without truncating its cached history", () => {
    const cachedMessages = 800
    const plan = sessionHydrationPlan({
      hasSession: true,
      hasMessages: true,
      hydratedLimit: cachedMessages,
      messageCount: cachedMessages,
      refresh: true,
    })

    expect(plan.skip).toBe(false)
    expect(plan.loadMessages).toBe(true)
    expect(plan.limit).toBe(cachedMessages + SESSION_MESSAGE_CHUNK)
  })

  test("the refreshed snapshot updates known messages without dropping cached turns outside its window", () => {
    const cached = [
      { id: "msg_001", text: "oldest cached turn" },
      { id: "msg_002", text: "stale streaming text" },
    ]
    const refreshed = [
      { id: "msg_002", text: "settled streaming text" },
      { id: "msg_003", text: "missed while inactive" },
    ]

    expect(mergeHydratedMessages(cached, refreshed)).toEqual([cached[0], refreshed[0], refreshed[1]])
  })

  test("a live SSE update wins when a reconnect snapshot settles later", () => {
    const live = [
      { id: "msg_001", text: "older cached turn" },
      { id: "msg_002", text: "new text streamed after reconnect began" },
      { id: "msg_004", text: "message streamed while the snapshot was in flight" },
    ]
    const staleSnapshot = [
      { id: "msg_002", text: "older response bytes" },
      { id: "msg_003", text: "message missed while disconnected" },
      { id: "msg_removed", text: "removed by SSE while the snapshot was in flight" },
    ]

    expect(
      mergeHydratedMessages(live, staleSnapshot, {
        preferCached: new Set(["msg_002", "msg_004"]),
        removed: new Set(["msg_removed"]),
      }),
    ).toEqual([live[0], live[1], staleSnapshot[1], live[2]])
  })

  test("reconnect part hydration treats the snapshot as complete but preserves concurrent SSE changes", () => {
    const live = [
      { id: "part_old", text: "removed while disconnected" },
      { id: "part_streaming", text: "latest streamed text" },
      { id: "part_new", text: "created by SSE during fetch" },
    ]
    const staleSnapshot = [
      { id: "part_streaming", text: "stale streamed text" },
      { id: "part_snapshot", text: "missed while disconnected" },
      { id: "part_removed", text: "removed by SSE during fetch" },
    ]

    expect(
      mergeHydratedMessages(live, staleSnapshot, {
        preserveCached: false,
        preferCached: new Set(["part_streaming", "part_new"]),
        removed: new Set(["part_removed"]),
      }),
    ).toEqual([live[2], staleSnapshot[1], live[1]])
  })

  test("a reconnect expands beyond 64 missed events until the snapshot reaches cached history", () => {
    const cachedCount = 100
    const first = reconnectHydrationLimit(cachedCount)
    expect(first).toBe(cachedCount + SESSION_MESSAGE_CHUNK)
    expect(first).toBeGreaterThan(cachedCount + 64)

    const second = nextReconnectHydrationLimit({
      limit: first,
      snapshotCount: first,
      overlapsCached: false,
    })
    expect(second).toBe(first * 2)

    const third = nextReconnectHydrationLimit({
      limit: second!,
      snapshotCount: second!,
      overlapsCached: false,
    })
    expect(third).toBe(second! * 2)
    expect(
      nextReconnectHydrationLimit({
        limit: third!,
        snapshotCount: 1_000,
        overlapsCached: true,
      }),
    ).toBeUndefined()
  })

  test("an older reconnect response cannot overwrite a newer completed backfill", async () => {
    const guard = createReconnectGenerationGuard()
    const key = "project/session"
    let transcript = "cached"
    let resolveOlder!: () => void
    let resolveNewer!: () => void
    const olderResponse = new Promise<void>((resolve) => (resolveOlder = resolve))
    const newerResponse = new Promise<void>((resolve) => (resolveNewer = resolve))

    const commit = async (response: Promise<void>, value: string) => {
      const generation = guard.begin(key)
      await response
      if (guard.isCurrent(key, generation)) transcript = value
    }

    const older = commit(olderResponse, "older snapshot")
    const newer = commit(newerResponse, "newest snapshot")
    resolveNewer()
    await newer
    resolveOlder()
    await older

    expect(transcript).toBe("newest snapshot")
  })

  test("ordinary sync still reuses a complete hydrated cache", () => {
    expect(
      sessionHydrationPlan({
        hasSession: true,
        hasMessages: true,
        hydratedLimit: SESSION_MESSAGE_CHUNK,
        messageCount: 120,
      }),
    ).toEqual({
      skip: true,
      loadMessages: false,
      limit: SESSION_MESSAGE_CHUNK,
    })
  })
})
