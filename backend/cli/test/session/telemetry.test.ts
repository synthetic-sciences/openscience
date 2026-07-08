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
        })
        expect(seen).toEqual([
          {
            sessionID: "ses_ctx",
            tokens: { system: 1, text: 2, reasoning: 3, tool: 4, skills: 5, image: 6 },
            images: 1,
            total: 21,
          },
        ])
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
