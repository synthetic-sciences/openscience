import { describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

describe("tool registry agent boundaries", () => {
  test("exposes canonical Python and R runtimes to every scientific primary agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const name of ["research", "physics", "ml"]) {
          const agent = await Agent.get(name)
          const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
          const ids = tools.map((tool) => tool.id)

          expect(ids).toContain("python")
          expect(ids).toContain("r")
          expect(ids).not.toContain("notebook")
          expect(ids).not.toContain("rkernel")
          expect(ids).toContain("compute_job")
          expect(ids).not.toContain("modal")
          expect(ids).not.toContain("query_uniprot")
        }
      },
    })
  })

  test("advertises one JobBroker while retaining the legacy Modal resolver", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("research")
        const advertised = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
        const ids = advertised.map((tool) => tool.id)

        expect(ids.filter((id) => id === "compute_job")).toHaveLength(1)
        expect(ids).not.toContain("modal")
        expect(await ToolRegistry.ids()).not.toContain("modal")

        const legacy = await ToolRegistry.resolve("modal", undefined, agent)
        expect(legacy?.id).toBe("modal")
      },
    })
  })

  test("keeps database tools scoped to biology without hiding the runtimes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("biology")
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
        const ids = tools.map((tool) => tool.id)

        expect(ids).toContain("python")
        expect(ids).toContain("r")
        expect(ids).toContain("query_uniprot")
      },
    })
  })
})
