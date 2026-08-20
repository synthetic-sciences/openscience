import { describe, expect, test } from "bun:test"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { ProjectTrust } from "../../src/project/trust"
import { Tool } from "../../src/tool/tool"
import { Agent } from "../../src/agent/agent"

async function trustProject() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
}

describe("tool.registry", () => {
  test("does not initialize tools filtered out for the current turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initialized: string[] = []
        const probe = Tool.define("selection_probe", async () => {
          initialized.push("selection_probe")
          return {
            description: "probe",
            parameters: z.object({}),
            async execute() {
              return { title: "probe", output: "probe", metadata: {} }
            },
          }
        })
        await ToolRegistry.register(probe)

        const tools = await ToolRegistry.tools(
          { providerID: "test", modelID: "test" },
          undefined,
          (id) => id !== probe.id,
        )

        expect(tools.some((tool) => tool.id === probe.id)).toBe(false)
        expect(initialized).toEqual([])
      },
    })
  })

  test("includes the native Atlas host broker", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ToolRegistry.ids()).toEqual(expect.arrayContaining(["atlas", "atlas_record"]))
      },
    })
  })

  test("advertises only the canonical plain runtime tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids.filter((id) => id === "python")).toHaveLength(1)
        expect(ids.filter((id) => id === "r")).toHaveLength(1)
        expect(ids).not.toContain("notebook")
        expect(ids).not.toContain("rkernel")
        expect(ids).toEqual(expect.arrayContaining(["webfetch", "science_search", "science_fetch", "research_search"]))
      },
    })
  })

  test("advertises canonical research search independent of provider and keeps websearch as an alias", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const providerID of ["anthropic", "openai", "synsci"]) {
          const tools = await ToolRegistry.tools({ providerID, modelID: "test-model" })
          expect(tools.map((tool) => tool.id)).toContain("research_search")
          expect(tools.map((tool) => tool.id)).not.toContain("websearch")
        }
        expect((await ToolRegistry.resolve("websearch", { providerID: "openai", modelID: "gpt-test" }))?.id).toBe(
          "research_search",
        )
      },
    })
  })

  test("keeps the atomic multi-file ApplyPatchTool contract for delegated sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const profile of ["execute", "explore"]) {
          const agent = await Agent.get(profile)
          const patch = (await ToolRegistry.tools({ providerID: "openai", modelID: "gpt-5" }, agent)).find(
            (tool) => tool.id === "apply_patch",
          )
          expect(patch?.description).toContain("Multi-file patches are supported in one call")
          expect(patch?.description).toContain("rolls back completed file operations")
          expect(patch?.description).not.toContain(
            "apply_patch verification failed: multi-file patches are not atomic; submit one file per patch",
          )
        }
      },
    })
  })

  test("resolves compatibility aliases without advertising them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await ToolRegistry.resolve("notebook"))?.id).toBe("notebook")
        expect((await ToolRegistry.resolve("rkernel"))?.id).toBe("rkernel")
        expect(await ToolRegistry.resolve("missing-runtime")).toBeUndefined()
      },
    })
  })

  test("project tools cannot shadow canonical or compatibility runtime names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register({
          id: "python",
          async init() {
            throw new Error("shadowed canonical runtime")
          },
        })
        await ToolRegistry.register({
          id: "notebook",
          async init() {
            throw new Error("shadowed compatibility runtime")
          },
        })

        const ids = await ToolRegistry.ids()
        expect(ids.filter((id) => id === "python")).toHaveLength(1)
        expect(ids).not.toContain("notebook")
        expect((await ToolRegistry.resolve("notebook"))?.id).toBe("notebook")
      },
    })
  })

  test("keeps memory unavailable while the feature is paused", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ToolRegistry.ids()).not.toContain("memory")
      },
    })
  })

  test("loads tools from .openscience/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const openscienceDir = path.join(dir, ".openscience")
        await fs.mkdir(openscienceDir, { recursive: true })

        const toolDir = path.join(openscienceDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .openscience/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const openscienceDir = path.join(dir, ".openscience")
        await fs.mkdir(openscienceDir, { recursive: true })

        const toolsDir = path.join(openscienceDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })
})
