import { afterEach, expect, test } from "bun:test"
import { MemoryTool } from "../../src/tool/memory"
import { Memory } from "../../src/settings/memory"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const blank = () => ({ enabled: true, categories: [] })

afterEach(async () => {
  await Memory.set("global", { enabled: false, categories: [] })
})

test("writes are refused with an honest message when memory is disabled", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Memory.set("project", { enabled: false, categories: [] })
      const memory = await MemoryTool.init()
      const result = await memory.execute({ action: "add", text: "should not be saved" }, ctx)
      expect(result.title).toBe("Memory disabled")
      expect(result.output).toContain("disabled in Settings")
      expect((await Memory.get("project")).categories.flatMap((c) => c.notes)).toHaveLength(0)
      await Memory.set("project", blank())
    },
  })
})

test("add then search round-trips through the full-text index", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Memory.set("project", blank())
      const memory = await MemoryTool.init()
      const added = await memory.execute(
        { action: "add", text: "Pangolin dataset checksums live in data/manifests", category: "Data" },
        ctx,
      )
      expect(added.title).toBe("Memory saved")
      expect(added.output).toMatch(/Capacity \[\d+% — \d+\/\d+ chars\]/)

      const note = (await Memory.get("project")).categories.flatMap((c) => c.notes)[0]
      expect(note?.source).toBe("agent")

      const found = await memory.execute({ action: "search", query: "pangolin checksums" }, ctx)
      expect(found.output).toContain("Pangolin dataset checksums")
      expect(found.output).toMatch(/Capacity: /)
      await Memory.set("project", blank())
    },
  })
})

test("duplicate adds error through the tool", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Memory.set("project", blank())
      const memory = await MemoryTool.init()
      await memory.execute({ action: "add", text: "Quoll runs need 2 GPUs" }, ctx)
      await expect(memory.execute({ action: "add", text: "quoll runs NEED 2 gpus" }, ctx)).rejects.toThrow(/duplicate/i)
      await Memory.set("project", blank())
    },
  })
})

test("replace and remove operate on the default project scope", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Memory.set("project", blank())
      const memory = await MemoryTool.init()
      await memory.execute({ action: "add", text: "Solver tolerance is 1e-6" }, ctx)
      const replaced = await memory.execute({ action: "replace", old_text: "1e-6", text: "1e-8" }, ctx)
      expect(replaced.output).toContain("Solver tolerance is 1e-8")
      const removed = await memory.execute({ action: "remove", old_text: "Solver tolerance" }, ctx)
      expect(removed.title).toBe("Memory removed")
      expect((await Memory.get("project")).categories.flatMap((c) => c.notes)).toHaveLength(0)
      await Memory.set("project", blank())
    },
  })
})

test("search reports when nothing is enabled anywhere", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Memory.set("global", { enabled: false, categories: [] })
      await Memory.set("project", { enabled: false, categories: [] })
      const memory = await MemoryTool.init()
      const result = await memory.execute({ action: "search", query: "anything" }, ctx)
      expect(result.title).toBe("Memory disabled")
      await Memory.set("project", blank())
    },
  })
})

test("missing parameters produce actionable errors", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Memory.set("project", blank())
      const memory = await MemoryTool.init()
      expect((await memory.execute({ action: "add" }, ctx)).output).toContain("`text`")
      expect((await memory.execute({ action: "search" }, ctx)).output).toContain("`query`")
      expect((await memory.execute({ action: "remove" }, ctx)).output).toContain("`old_text`")
    },
  })
})
