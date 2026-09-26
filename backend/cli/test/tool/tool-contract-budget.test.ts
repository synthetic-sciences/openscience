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
      // The default twenty-minute stop is stated in the contract: a call that
      // hung a worker for half an hour is why the model is told.
      expect(contracts.bash).toBeLessThanOrEqual(2_350)
      // The dispatch grace is stated: a start that settles is the whole step.
      expect(contracts.compute_job).toBeLessThanOrEqual(4_250)
      expect(contracts.python).toBeLessThanOrEqual(2_100)
      expect(contracts.skill).toBeLessThanOrEqual(1_800)
      // Seven listed workers (the general worker joined the six) and the
      // full-path rule for briefs.
      expect(contracts.task).toBeLessThanOrEqual(3_200)
      expect(contracts.todowrite).toBeLessThanOrEqual(1_750)
      expect(contracts.webfetch).toBeLessThanOrEqual(2_700)
    },
  })
})
