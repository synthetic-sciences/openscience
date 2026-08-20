import { expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

test("keeps the research tool contract within its model context budget", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("research")
      if (!agent) throw new Error("Missing research agent")
      const tools = await ToolRegistry.tools({ providerID: "openai-codex", modelID: "gpt-5.6-codex" }, agent)
      const contracts = Object.fromEntries(
        tools.map((tool) => [
          tool.id,
          Buffer.byteLength(tool.description) + Buffer.byteLength(JSON.stringify(z.toJSONSchema(tool.parameters))),
        ]),
      )
      const bytes = Object.values(contracts).reduce((sum, size) => sum + size, 0)

      expect(bytes).toBeLessThanOrEqual(50_000)
      expect(contracts.bash).toBeLessThanOrEqual(1_800)
      expect(contracts.compute_job).toBeLessThanOrEqual(4_000)
      expect(contracts.python).toBeLessThanOrEqual(2_100)
      expect(contracts.r).toBeLessThanOrEqual(1_600)
      expect(contracts.research_contract).toBeLessThanOrEqual(3_500)
      expect(contracts.skill).toBeLessThanOrEqual(1_800)
      expect(contracts.task).toBeLessThanOrEqual(2_500)
      expect(contracts.todowrite).toBeLessThanOrEqual(1_750)
      expect(contracts.webfetch).toBeLessThanOrEqual(2_500)
    },
  })
})
