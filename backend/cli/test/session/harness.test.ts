import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { SessionHarness } from "../../src/session/harness"

function tools(reverse = false) {
  const bash = tool({
    description: "Run a command",
    inputSchema: jsonSchema({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
  })
  const read = tool({
    description: "Read a file",
    inputSchema: jsonSchema({
      required: ["path"],
      properties: { path: { type: "string" } },
      type: "object",
    }),
  })
  return reverse ? { read, bash } : { bash, read }
}

describe("session harness fingerprint", () => {
  test("is stable across tool insertion order without storing prompt content", async () => {
    const input = {
      agent: { name: "research", mode: "primary" as const },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["private system text"],
      instructions: "private instructions",
    }
    const first = await SessionHarness.snapshot({ ...input, tools: tools() })
    const second = await SessionHarness.snapshot({ ...input, tools: tools(true) })

    expect(first).toEqual(second)
    expect(first.tools.map((item) => item.name)).toEqual(["bash", "read"])
    expect(JSON.stringify(first)).not.toContain("private")
    expect(first.fingerprint).toHaveLength(64)
  })

  test("changes when a model-visible contract changes", async () => {
    const base = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["system v1"],
      tools: tools(),
    })
    const changed = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["system v2"],
      tools: tools(),
    })

    expect(changed.systemHash).not.toBe(base.systemHash)
    expect(changed.fingerprint).not.toBe(base.fingerprint)
  })
})
