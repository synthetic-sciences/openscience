import { describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const MEMORY = path.join(".openscience", "memory")

// Project memory is a directory convention, not a config key: a project opts in
// by writing markdown under .openscience/memory and every later session inherits
// it. These tests pin the three behaviours a reader depends on: the files are
// injected, an absent directory is harmless, and memory loses to instructions
// when the combined budget runs out.
describe("InstructionPrompt project memory", () => {
  test("injects markdown from .openscience/memory into the system prompt", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, MEMORY, "decision.md"), "# 课题方向\n无人机路径规划\n")
        await Bun.write(path.join(dir, MEMORY, "nested", "dataset.md"), "VisDrone\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const decision = path.join(tmp.path, MEMORY, "decision.md")
        const dataset = path.join(tmp.path, MEMORY, "nested", "dataset.md")

        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(decision)).toBe(true)
        expect(paths.has(dataset)).toBe(true)

        const entries = await InstructionPrompt.system()
        expect(entries).toContain(`Instructions from: ${decision}\n# 课题方向\n无人机路径规划\n`)
        expect(entries).toContain(`Instructions from: ${dataset}\nVisDrone\n`)
      },
    })
  })

  test("ignores a project without a memory directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entries = await InstructionPrompt.system()
        expect(entries.some((entry) => entry.includes(path.join(tmp.path, MEMORY)))).toBe(false)
        expect(entries.some((entry) => entry.includes(path.join(tmp.path, "AGENTS.md")))).toBe(true)
      },
    })
  })

  test("drops project memory before other instructions when the budget is exhausted", async () => {
    // Four instruction sources just below the per-source limit fill the combined
    // 1 MiB budget, leaving no room for the memory entry appended after them.
    await using tmp = await tmpdir({
      init: async (dir) => {
        const rules = Array.from({ length: 4 }, (_, index) => path.join(dir, `rules-${index}.md`))
        await Promise.all(rules.map((file) => Bun.write(file, "x".repeat(260_000))))
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ instructions: rules }))
        await Bun.write(path.join(dir, MEMORY, "decision.md"), "y".repeat(200_000))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entries = await InstructionPrompt.system()
        expect(entries.some((entry) => entry.includes(path.join(tmp.path, "rules-0.md")))).toBe(true)
        expect(entries.some((entry) => entry.includes(path.join(tmp.path, MEMORY, "decision.md")))).toBe(false)
      },
    })
  })

  test("keeps memory behind the configured instructions in precedence order", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "extra.md"), "Configured instructions\n")
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ instructions: ["extra.md"] }))
        await Bun.write(path.join(dir, MEMORY, "decision.md"), "Recorded decision\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entries = await InstructionPrompt.system()
        const configured = entries.findIndex((entry) => entry.includes(path.join(tmp.path, "extra.md")))
        const memory = entries.findIndex((entry) => entry.includes(path.join(tmp.path, MEMORY, "decision.md")))
        expect(configured).toBeGreaterThanOrEqual(0)
        expect(memory).toBeGreaterThan(configured)
      },
    })
  })

  test("tells the agent where a new note goes", async () => {
    // The read path alone leaves the directory empty. The guide is what closes the
    // loop: it names the file to append to, so "remember this" produces a note the
    // next session actually loads.
    await using tmp = await tmpdir({ init: async () => {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entries = await InstructionPrompt.system()
        const guide = entries.at(-1) ?? ""
        expect(guide).toContain(".openscience/memory/decision.md")
        expect(guide).toContain("asks you to remember")
      },
    })
  })
})
