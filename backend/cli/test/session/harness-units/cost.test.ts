import { afterEach, expect, test } from "bun:test"
import type { PluginInput } from "@synsci/plugin"
import { CostUnit } from "../../../src/harness/cost"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
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

test("spend accumulates from finished steps and renders beside the time budget", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const unit = await CostUnit({} as PluginInput)
      const lines = async () => {
        const output = { lines: [] as string[] }
        await unit["env.lines"]!({ sessionID: "ses_cost", model: {} as never }, output)
        return output.lines
      }
      expect(await lines()).toEqual(["Spent so far: $0.0000 (0 tokens)"])
      await unit.event!({ event: step("ses_cost", 0.4, 12_000) as never })
      await unit.event!({ event: step("ses_cost", 0.85, 30_000) as never })
      await unit.event!({ event: step("ses_other", 9, 1) as never })
      expect(await lines()).toEqual(["Spent so far: $1.25 (42,000 tokens)"])
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
      const first = { lines: [] as string[] }
      await unit["env.lines"]!({ sessionID: "ses_cap", model: {} as never }, first)
      expect(first.lines[1]).toContain("soft ceiling of $1.00")
      const second = { lines: [] as string[] }
      await unit["env.lines"]!({ sessionID: "ses_cap", model: {} as never }, second)
      expect(second.lines).toHaveLength(1)
    },
  })
})
