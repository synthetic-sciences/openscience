import { afterEach, expect, test } from "bun:test"
import type { PluginInput } from "@synsci/plugin"
import { CostUnit } from "../../../src/harness/cost"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { tmpdir } from "../../fixture/fixture"

afterEach(() => HarnessState.reset())

const step = (sessionID: string, cost: number, tokens: number) => ({
  type: "message.part.updated" as const,
  properties: {
    part: {
      id: "prt_step",
      sessionID,
      messageID: "msg_a",
      type: "step-finish" as const,
      reason: "stop",
      cost,
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
})

test("spend accumulates from finished steps and renders as per-step status, never in <env>", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const unit = await CostUnit({} as PluginInput)
      const lines = async () => {
        const output = { lines: [] as string[], status: [] as string[] }
        await unit["env.lines"]!({ sessionID: "ses_cost", model: {} as never }, output)
        // A figure that changes every step would discard the cached prefix.
        expect(output.lines).toEqual([])
        return output.status
      }
      expect(await lines()).toEqual([
        "Spent so far on this session's model calls: $0.0000 (0 tokens); workers and compute jobs are counted separately.",
      ])
      await unit.event!({ event: step("ses_cost", 0.4, 12_000) as never })
      await unit.event!({ event: step("ses_cost", 0.85, 30_000) as never })
      await unit.event!({ event: step("ses_other", 9, 1) as never })
      expect((await lines())[0]).toStartWith("Spent so far on this session's model calls: $1.25 (42,000 tokens)")
    },
  })
})

test("the soft ceiling adds a wrap-up reminder once and never stops the loop", async () => {
  await using tmp = await tmpdir({ config: { harness: { cost: { max_usd: 1 } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const unit = await CostUnit({} as PluginInput)
      await unit.event!({ event: step("ses_cap", 1.5, 100) as never })
      const first = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: "ses_cap", model: {} as never }, first)
      expect(first.status[1]).toContain("soft ceiling of $1.00")
      const second = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: "ses_cap", model: {} as never }, second)
      expect(second.status).toHaveLength(1)
    },
  })
})

test("a process that restarts mid-session picks the count up from the transcript, once", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const assistant = (id: string, cost: number, input: number) =>
        Session.updateMessage({
          id,
          sessionID: session.id,
          role: "assistant",
          parentID: "msg_user",
          mode: "research",
          agent: "research",
          path: { cwd: tmp.path, root: tmp.path },
          cost,
          tokens: { input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "m",
          providerID: "p",
          time: { created: 1, completed: 2 },
        })
      await assistant("msg_a1", 1.5, 40_000)
      await assistant("msg_a2", 2.25, 60_000)
      const unit = await CostUnit({} as PluginInput)
      const output = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: session.id, model: {} as never }, output)
      expect(output.status[0]).toStartWith("Spent so far on this session's model calls: $3.75 (100,200 tokens)")
      // Later steps add to the seeded figure instead of re-reading the transcript.
      await unit.event!({ event: step(session.id, 0.25, 1_000) as never })
      const again = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: session.id, model: {} as never }, again)
      expect(again.status[0]).toStartWith("Spent so far on this session's model calls: $4.00 (101,200 tokens)")
    },
  })
})
