import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"

describe("tool.registry", () => {
  test("includes the native Atlas host broker", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ToolRegistry.ids()).toEqual(expect.arrayContaining(["atlas", "atlas_record"]))
      },
    })
  })

  test("registers one canonical notebook tool", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids.filter((id) => id === "notebook")).toHaveLength(1)
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
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })
})
