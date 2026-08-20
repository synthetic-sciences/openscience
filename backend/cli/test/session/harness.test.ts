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
    expect(first.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bash", descriptionBytes: 13, schemaBytes: expect.any(Number) }),
      ]),
    )
    expect(first.toolBytes).toBeGreaterThan(0)
    expect(first.contractBytes).toBe(first.systemBytes! + first.instructionsBytes! + first.toolBytes!)
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

  test("rejects a manifest whose fingerprint or tool order was changed", async () => {
    const snapshot = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["system"],
      tools: tools(),
    })

    expect(SessionHarness.Snapshot.safeParse({ ...snapshot, fingerprint: "0".repeat(64) }).success).toBe(false)
    expect(SessionHarness.Snapshot.safeParse({ ...snapshot, tools: snapshot.tools.toReversed() }).success).toBe(false)
  })

  test("replays composition transitions and attributes tool calls", async () => {
    const first = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["system"],
      tools: tools(),
    })
    const second = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-reasoner",
      system: ["system"],
      tools: tools(),
    })
    const report = SessionHarness.analyze({
      records: [
        SessionHarness.Entry.parse({
          ...first,
          messageID: "assistant_1",
          parentMessageID: "user_1",
          attempt: 1,
          createdAt: 1,
        }),
        SessionHarness.Entry.parse({
          ...second,
          messageID: "assistant_2",
          parentMessageID: "user_2",
          attempt: 1,
          createdAt: 2,
        }),
      ],
      inference: [
        {
          messageID: "assistant_1",
          parentMessageID: "user_1",
          provider: "deepseek",
          model: "deepseek-chat",
          attempt: 1,
        },
        {
          messageID: "assistant_2",
          parentMessageID: "user_2",
          provider: "deepseek",
          model: "deepseek-reasoner",
          attempt: 1,
        },
      ],
      tools: [
        {
          id: "tool_1",
          messageID: "assistant_1",
          name: "bash",
          inputHash: "a".repeat(64),
          status: "completed",
        },
      ],
    })

    expect(report.valid).toBe(true)
    expect(report.stable).toBe(false)
    expect(report.transitions).toHaveLength(1)
    expect(report.transitions[0]?.changes).toEqual(["model"])
    expect(report.trajectoryHash).toHaveLength(64)

    const invalid = SessionHarness.analyze({
      records: [
        SessionHarness.Entry.parse({
          ...first,
          messageID: "assistant_1",
          parentMessageID: "user_1",
          attempt: 1,
          createdAt: 1,
        }),
      ],
      inference: [
        {
          messageID: "assistant_1",
          parentMessageID: "user_1",
          provider: "deepseek",
          model: "deepseek-chat",
          attempt: 1,
        },
      ],
      tools: [
        {
          id: "tool_unknown",
          messageID: "assistant_1",
          name: "missing",
          inputHash: "b".repeat(64),
          status: "completed",
        },
      ],
    })
    expect(invalid.valid).toBe(false)
    expect(invalid.checks.find((item) => item.id === "tool_attribution")?.affected).toEqual(["tool_unknown"])
  })

  test("attributes a successful retry only to its exact final composition", async () => {
    const first = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["system"],
      tools: tools(),
    })
    const read = tools().read
    const second = await SessionHarness.snapshot({
      agent: { name: "research", mode: "primary" },
      provider: "deepseek",
      model: "deepseek-chat",
      system: ["system"],
      tools: { read },
    })
    const entry = (snapshot: SessionHarness.Snapshot, attempt: number) =>
      SessionHarness.Entry.parse({
        ...snapshot,
        messageID: "assistant_1",
        parentMessageID: "user_1",
        attempt,
        createdAt: attempt,
      })
    const input = {
      inference: [
        {
          messageID: "assistant_1",
          parentMessageID: "user_1",
          provider: "deepseek",
          model: "deepseek-chat",
          attempt: 2,
        },
      ],
      tools: [
        {
          id: "tool_1",
          messageID: "assistant_1",
          name: "bash",
          inputHash: "a".repeat(64),
          status: "completed",
        },
      ],
    }
    const report = SessionHarness.analyze({ ...input, records: [entry(first, 1), entry(second, 2)] })

    expect(report.valid).toBe(false)
    expect(report.checks.find((item) => item.id === "tool_attribution")?.affected).toEqual(["tool_1"])

    const broken = SessionHarness.analyze({ ...input, records: [entry(second, 2)] })
    expect(broken.checks.find((item) => item.id === "composition_integrity")?.affected).toEqual(["assistant_1"])
  })
})
