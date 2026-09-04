import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { SessionTelemetry } from "../../src/session/telemetry"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.telemetry.recordContext", () => {
  test("publishes a session.context event with the composition bucketed by type", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: any[] = []
        Bus.subscribe(SessionTelemetry.Event.Context, (e) => seen.push(e.properties))
        await SessionTelemetry.recordContext({
          sessionID: "ses_ctx",
          composition: { system: 1, text: 2, reasoning: 3, tool: 4, skills: 5, image: 6, images: 1, total: 21 },
          budget: { total: 30, newest: 20, history: 10, usable: 100, soft: 70, hard: 90 },
        })
        expect(seen).toEqual([
          {
            sessionID: "ses_ctx",
            tokens: { system: 1, text: 2, reasoning: 3, tool: 4, skills: 5, image: 6 },
            images: 1,
            total: 21,
            budget: { total: 30, newest: 20, history: 10, usable: 100, soft: 70, hard: 90 },
          },
        ])
        expect(SessionTelemetry.context("ses_ctx")).toMatchObject({ total: 30, hard: 90, composition: { total: 21 } })
      },
    })
  })
})

describe("session.telemetry.recordCompaction", () => {
  test("publishes a session.compaction event tagged with trigger + mechanism + reclaimed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: any[] = []
        Bus.subscribe(SessionTelemetry.Event.Compaction, (e) => seen.push(e.properties))
        await SessionTelemetry.recordCompaction({
          sessionID: "ses_c",
          trigger: "proactive",
          mechanism: "prune",
          before: 152_000,
          reclaimed: 31_000,
        })
        expect(seen).toEqual([
          {
            sessionID: "ses_c",
            trigger: "proactive",
            mechanism: "prune",
            before: 152_000,
            after: 121_000, // before - reclaimed, filled in when `after` is not given
            reclaimed: 31_000,
          },
        ])
      },
    })
  })

  test("passes an explicit `after` through unchanged (LLM summary path)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: any[] = []
        Bus.subscribe(SessionTelemetry.Event.Compaction, (e) => seen.push(e.properties))
        await SessionTelemetry.recordCompaction({
          sessionID: "ses_s",
          trigger: "overflow",
          mechanism: "summary",
          before: 180_000,
          after: 4_000,
          reclaimed: 176_000,
        })
        expect(seen[0]).toMatchObject({ trigger: "overflow", mechanism: "summary", before: 180_000, after: 4_000 })
      },
    })
  })
})

describe("session.telemetry.recordProgress", () => {
  test("evicts finished requests first and the least recently updated one after that", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Matches LATEST_LIMIT in telemetry.ts.
        const limit = 256
        const record = (n: number, phase: SessionTelemetry.RequestPhase) =>
          SessionTelemetry.recordProgress({
            sessionID: `ses_evict_${n}`,
            messageID: `msg_evict_${n}`,
            attempt: 1,
            agent: "research",
            providerID: "stress",
            modelID: "fixture-model",
            phase,
          })
        Array.from({ length: limit }, (_, n) => record(n, "connecting"))
        // Updating the oldest record makes it the most recent, so the next
        // insert evicts its neighbour instead of cutting it off mid-request.
        record(0, "waiting_first_token")
        record(limit, "connecting")
        expect(SessionTelemetry.progress("ses_evict_0")?.phase).toBe("waiting_first_token")
        expect(SessionTelemetry.progress("ses_evict_1")).toBeUndefined()
        // A finished request goes before any in-flight one, however old.
        record(5, "done")
        record(limit + 1, "connecting")
        expect(SessionTelemetry.progress("ses_evict_5")).toBeUndefined()
        expect(SessionTelemetry.progress("ses_evict_2")?.phase).toBe("connecting")
        expect(SessionTelemetry.progress(`ses_evict_${limit + 1}`)?.phase).toBe("connecting")
      },
    })
  })
})
