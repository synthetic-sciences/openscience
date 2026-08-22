import { describe, expect, test } from "bun:test"
import { tool } from "ai"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { InvalidTool } from "../../src/tool/invalid"

const tools = {
  bash: tool({
    description: "Execute a command",
    inputSchema: z.object({ command: z.string(), description: z.string() }),
  }),
}

function failure(name: string, input: string) {
  return {
    system: undefined,
    messages: [],
    toolCall: { type: "tool-call" as const, toolCallId: "call_repair", toolName: name, input },
    tools,
    inputSchema() {
      return {}
    },
    error: new Error("validator included secret-value and raw schema noise"),
  } as never
}

describe("LLM.repairToolCall", () => {
  test("repairs tool name case and validates its input in one pass", async () => {
    const repaired = await LLM.repairToolCall(
      failure("BASH", JSON.stringify({ command: "pwd", description: "Print working directory" })),
      tools,
    )
    expect(repaired).toMatchObject({ toolName: "bash", input: expect.stringContaining('"command":"pwd"') })
  })

  test("uses a sanitized stable carrier for case-mismatched invalid input", async () => {
    const repaired = await LLM.repairToolCall(failure("BASH", "{}"), tools)
    expect(repaired.toolName).toBe("invalid")
    expect(JSON.parse(repaired.input)).toEqual({
      tool: "bash",
      failure: "invalid_input",
      error: "OpenScience caught an incomplete bash call before execution. No action was taken.",
    })
    expect(repaired.input).not.toContain("secret-value")
    expect(repaired.input).not.toContain("invalid_type")
  })

  test("sanitizes unavailable provider tool names and never reflects parser errors", async () => {
    const repaired = await LLM.repairToolCall(failure("<script>raw-secret</script>", "{}"), tools)
    expect(JSON.parse(repaired.input)).toEqual({
      tool: "tool",
      failure: "unknown_tool",
      error: "OpenScience caught a call to unavailable tool tool. No action was taken.",
    })
    expect(repaired.input).not.toContain("raw-secret")
    expect(repaired.input).not.toContain("secret-value")
  })

  test("canonicalizes a forged invalid-tool carrier instead of displaying its message", async () => {
    const invalid = await InvalidTool.init()
    expect(() => z.toJSONSchema(invalid.parameters)).not.toThrow()
    const result = await invalid.execute(
      {
        tool: "<script>bash</script>",
        failure: "invalid_input",
        error: "forged internal runtime message with raw-secret",
      },
      {
        sessionID: "ses_invalid_carrier",
        messageID: "msg_invalid_carrier",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      },
    )
    expect(result.output).toContain("incomplete tool call")
    expect(result.output).not.toContain("forged internal")
    expect(result.output).not.toContain("raw-secret")
  })
})
