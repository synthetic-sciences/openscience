import { describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

describe("tool registry agent boundaries", () => {
  test("exposes the Python notebook to every scientific primary agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const name of ["research", "physics", "ml"]) {
          const agent = await Agent.get(name)
          const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
          const ids = tools.map((tool) => tool.id)

          expect(ids).toContain("notebook")
          expect(ids).toContain("compute_job")
          expect(ids).not.toContain("query_uniprot")
        }
      },
    })
  })

  test("keeps database tools scoped to biology without hiding the notebook", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("biology")
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
        const ids = tools.map((tool) => tool.id)

        expect(ids).toContain("notebook")
        expect(ids).toContain("query_uniprot")
      },
    })
  })
})
