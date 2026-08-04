import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { LearnTool } from "../../src/tool/learn"

const name = "test-learn-proposal"
const context = {
  sessionID: "learn-proposal-session",
  messageID: "message",
  callID: "call",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
}

afterEach(async () => {
  await fs.rm(path.join(Global.Path.data, "learned-skill-proposals", name), { recursive: true, force: true })
  await fs.rm(path.join(Global.Path.data, "learned-skills", name), { recursive: true, force: true })
})

describe("learn tool", () => {
  test("creates an inactive proposal instead of self-promoting or uploading", async () => {
    const description = "Use when testing a learned workflow safely."
    const tool = await LearnTool.init()
    const result = await tool.execute(
      {
        name,
        description,
        content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# Safe workflow\n`,
      },
      context,
    )
    expect(result.title).toBe(`Skill proposal: ${name}`)
    expect(result.metadata).toMatchObject({ name, status: "pending" })
    expect(result.output).toContain("quarantined and inactive")
    expect(await Bun.file(path.join(Global.Path.data, "learned-skills", name, "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(Global.Path.data, "learned-skill-proposals", name, "SKILL.md")).exists()).toBe(true)
  })
})
