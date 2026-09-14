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
        "Spent so far: $0.00 on this session's model calls (0 tokens) and $0.00 on its workers; compute jobs are counted separately.",
      ])
      await unit.event!({ event: step("ses_cost", 0.4, 12_000) as never })
      await unit.event!({ event: step("ses_cost", 0.85, 30_000) as never })
      await unit.event!({ event: step("ses_other", 9, 1) as never })
      expect((await lines())[0]).toStartWith("Spent so far: $1.25 on this session's model calls (42,000 tokens)")
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
      expect(output.status[0]).toStartWith("Spent so far: $3.75 on this session's model calls (100,200 tokens)")
      // Later steps add to the seeded figure instead of re-reading the transcript.
      await unit.event!({ event: step(session.id, 0.25, 1_000) as never })
      const again = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: session.id, model: {} as never }, again)
      expect(again.status[0]).toStartWith("Spent so far: $4.00 on this session's model calls (101,200 tokens)")
    },
  })
})

test("a worker's steps bill the lead that delegated to it, live and from the transcript", async () => {
  await using tmp = await tmpdir({ config: { harness: { cost: { max_usd: 5 } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const lead = await Session.create({})
      const worker = await Session.create({ parentID: lead.id })
      const grandchild = await Session.create({ parentID: worker.id })
      const assistant = (sessionID: string, id: string, cost: number) =>
        Session.updateMessage({
          id,
          sessionID,
          role: "assistant",
          parentID: "msg_user",
          mode: "ml",
          agent: "ml",
          path: { cwd: tmp.path, root: tmp.path },
          cost,
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "m",
          providerID: "p",
          time: { created: 1, completed: 2 },
        })
      await assistant(lead.id, "msg_lead", 1)
      await assistant(worker.id, "msg_worker", 2)
      await assistant(grandchild.id, "msg_grandchild", 0.5)
      const unit = await CostUnit({} as PluginInput)
      // Seeding from the transcripts: the lead's own dollar, its worker's two
      // and the worker's worker's half.
      const seeded = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: lead.id, model: {} as never }, seeded)
      expect(seeded.status[0]).toBe(
        "Spent so far: $1.00 on this session's model calls (1,100 tokens) and $2.50 on its workers; compute jobs are counted separately.",
      )
      // A live worker step lands on the lead's worker figure, not its own.
      await unit.event!({ event: step(worker.id, 2, 10_000) as never })
      const live = { lines: [] as string[], status: [] as string[] }
      await unit["env.lines"]!({ sessionID: lead.id, model: {} as never }, live)
      expect(live.status[0]).toStartWith(
        "Spent so far: $1.00 on this session's model calls (1,100 tokens) and $4.50 on its workers",
      )
      // The ceiling counts the workers: $1 + $4.50 passes $5.
      expect(live.status[1]).toContain("soft ceiling of $5.00")
    },
  })
})
