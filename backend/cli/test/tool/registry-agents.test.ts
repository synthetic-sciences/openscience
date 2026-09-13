import { describe, expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolVisibility } from "../../src/tool/visibility"
import { tmpdir } from "../fixture/fixture"

describe("tool registry agent boundaries", () => {
  test("the default set is shared; runtimes beyond python wait for a skill or an agent rule", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const name of ["research", "physics", "ml"]) {
          const agent = await Agent.get(name)
          const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
          const ids = tools.map((tool) => tool.id)

          expect(ids).toContain("python")
          expect(ids).toContain("compute_job")
          expect(ids).not.toContain("r")
          expect(ids).not.toContain("notebook")
          expect(ids).not.toContain("rkernel")
          expect(ids).not.toContain("provider_compute")
          expect(ids).not.toContain("scientific_capability")
          expect(ids).not.toContain("research_contract")
          expect(ids).not.toContain("modal")
          expect(ids).not.toContain("query_uniprot")
          expect(ids).not.toContain("batch")
          expect(ids).not.toContain("todoread")
        }
        // The data specialist opts R in through its own ruleset.
        const data = await Agent.get("data")
        const ids = (await ToolRegistry.tools({ providerID: "test", modelID: "test" }, data)).map((tool) => tool.id)
        expect(ids).toContain("r")
        expect(data?.unlocks).toEqual(["r"])
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

  test("keeps every research tool object-rooted for strict providers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("research")
        const tools = await ToolRegistry.tools({ providerID: "deepseek", modelID: "deepseek-chat" }, agent)

        for (const tool of tools) {
          const schema = z.toJSONSchema(tool.parameters) as { type?: string }
          expect(schema.type, tool.id).toBe("object")
        }
      },
    })
  })

  test("a specialist's domain tools come from its own allow rules, and a configured rule unlocks too", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { geoscience: { mode: "subagent", permission: { r: "allow", generate_image: "allow" } } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const biology = await Agent.get("biology")
        const ids = (await ToolRegistry.tools({ providerID: "test", modelID: "test" }, biology)).map((tool) => tool.id)
        expect(ids).toContain("python")
        expect(ids).toContain("query_uniprot")
        expect(ids).toContain("science_search")
        expect(ids).not.toContain("r")
        // Untrusted project config is inert, so the configured agent is absent
        // here; the unlock derivation itself is what the rule contributes.
        expect(
          ToolVisibility.unlocks([
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "r", pattern: "*", action: "allow" },
            { permission: "generate_image", pattern: "*", action: "allow" },
            { permission: "modal", pattern: "*", action: "deny" },
            { permission: "read", pattern: "*", action: "allow" },
          ]),
        ).toEqual(["r", "generate_image"])
      },
    })
  })
})
