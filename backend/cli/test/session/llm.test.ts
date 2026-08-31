import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"
import { jsonSchema, tool, type ModelMessage } from "ai"
import { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import type { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir, trustProject } from "../fixture/fixture"

function testModel(toolcall: boolean): Provider.Model {
  return {
    id: "test-model",
    providerID: "openrouter",
    api: {
      id: "test-model",
      url: "https://example.com",
      npm: "@openrouter/ai-sdk-provider",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 0,
      output: 0,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

const agent = {
  permission: [],
} as unknown as Agent.Info

const user = {
  tools: {},
} as unknown as MessageV2.User

function questionTool() {
  return tool({
    description: "Ask the user a question",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => ({ output: "", title: "", metadata: {} }),
  })
}

describe("session.llm.responseStructure", () => {
  test("default Research carries the same response defaults in standard and Codex instructions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research).toBeDefined()
        const input = { agent: research!, model: testModel(true) }
        const standard = LLM.prompts(input)
        const codex = LLM.prompts(input, true)

        expect(standard.system).toEqual([research!.prompt!])
        expect(standard.instructions).toBeUndefined()
        expect(codex.system).toEqual(standard.system)
        expect(codex.instructions).toBe(research!.prompt)
        const prompt = research!.prompt!.replace(/\s+/g, " ")
        expect(prompt).toContain("collaborative research agent")
        expect(prompt.match(/## Response structure/g)).toHaveLength(1)
        expect(prompt).toContain("These are writing defaults, not length limits.")
        expect(prompt).toContain("Follow the user's requested format and depth")
        expect(prompt).toContain("the active agent's specific output contract")
        expect(prompt).toContain("a complete document overrides the preference for a brief summary")
        expect(prompt).toContain("deeper investigation does not require a longer final answer")
        expect(prompt).toContain("Leave blank lines around headings, lists, tables, and fenced code")
        expect(prompt).toContain("unless the user requests its full text there")
        expect(prompt).toContain("only after a successful tool result confirms it")
        expect(prompt).toContain("never invent a file link or completed action")
        expect(prompt).toContain("Do not create files merely to shorten an answer")
        expect(prompt).toContain("keep requested long-form content complete")
        expect(input.model.options).toEqual({})
      },
    })
  })

  test.each([
    { label: "base", direct: false, inspection: false, required: "local-first Research agent" },
    { label: "direct", direct: true, inspection: false, required: "Answer this short conceptual question directly" },
    { label: "inspection", direct: false, inspection: true, required: "Do not modify files" },
  ])("$label instructions preserve their scope and transport parity", ({ direct, inspection, required }) => {
    const input = {
      agent: { name: "write", mode: "subagent", options: {}, permission: [] } satisfies Agent.Info,
      model: testModel(true),
      direct,
      inspection,
    }
    const standard = LLM.prompts(input)
    const codex = LLM.prompts(input, true)
    const expected = SystemPrompt.instructions(direct, inspection)

    expect(standard.system).toEqual([expected])
    expect(codex.system).toEqual([])
    expect(codex.instructions).toBe(expected)
    expect(expected).toContain(required)
    if (direct || inspection) {
      expect(expected.length).toBeLessThan(350)
      expect(expected).not.toContain("## Response structure")
      return
    }
    expect(expected.match(/## Response structure/g)).toHaveLength(1)
    expect(expected).toContain("These are writing defaults, not length limits.")
  })

  test("explicit custom Research instructions replace the built-in defaults unchanged on both transports", async () => {
    const custom = "Return the complete requested document inline. Keep every supplied section and equation."
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { research: { prompt: custom } } },
    })
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research!.prompt).toBe(custom)
        const input = { agent: research!, model: testModel(true) }
        expect(LLM.prompts(input)).toEqual({ system: [custom], instructions: undefined })
        expect(LLM.prompts(input, true)).toEqual({ system: [custom], instructions: custom })
      },
    })
  })

  test("specialist output contracts remain verbatim and Codex defaults explicitly defer to them", () => {
    const custom = "Return only the requested JSON object, without Markdown or a summary."
    const input = {
      agent: { name: "custom", prompt: custom, mode: "subagent", options: {}, permission: [] } satisfies Agent.Info,
      model: testModel(true),
    }
    expect(LLM.prompts(input)).toEqual({ system: [custom], instructions: undefined })
    const codex = LLM.prompts(input, true)
    expect(codex.system).toEqual([custom])
    expect(codex.instructions).toContain("the active agent's specific output contract")
  })

  test("internal title instructions are not replaced or decorated on the standard transport", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const title = await Agent.get("title")
        const prompt = LLM.prompts({ agent: title!, model: testModel(false) })
        expect(prompt.system).toEqual([title!.prompt!])
        expect(prompt.system.join("\n")).not.toContain("## Response structure")
      },
    })
  })
})

describe("session.llm.modelTools", () => {
  test("drops native tools for models without tool-call support", async () => {
    const tools = { question: questionTool() }
    const resolved = await LLM.modelTools({
      agent,
      model: testModel(false),
      tools,
      user,
    })

    expect(resolved).toStrictEqual({})
    expect(tools.question).toBeDefined()
  })

  test("keeps native tools for models with tool-call support", async () => {
    const tools = { question: questionTool() }
    const resolved = await LLM.modelTools({
      agent,
      model: testModel(true),
      tools,
      user,
    })

    expect(resolved).toBe(tools)
    expect(Object.keys(resolved)).toStrictEqual(["question"])
  })
})

describe("session.llm.isCodexSubscriptionModel", () => {
  test("returns true for the synthesized openai-codex OAuth provider", () => {
    expect(LLM.isCodexSubscriptionModel({ providerID: "openai-codex" }, { type: "oauth" })).toBe(true)
  })

  test("does not treat the plain OpenAI provider as Codex subscription access", () => {
    expect(LLM.isCodexSubscriptionModel({ providerID: "openai" }, { type: "oauth" })).toBe(false)
  })

  test("requires OAuth credentials for the Codex subscription provider", () => {
    expect(LLM.isCodexSubscriptionModel({ providerID: "openai-codex" }, { type: "api" })).toBe(false)
    expect(LLM.isCodexSubscriptionModel({ providerID: "openai-codex" })).toBe(false)
  })
})

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.isCodexSubscriptionModel", () => {
  test("recognizes the synthesized Codex OAuth provider", () => {
    expect(
      LLM.isCodexSubscriptionModel(
        {
          providerID: "openai-codex",
        },
        {
          type: "oauth",
        },
      ),
    ).toBe(true)
  })

  test("does not treat plain OpenAI OAuth as a Codex subscription", () => {
    expect(
      LLM.isCodexSubscriptionModel(
        {
          providerID: "openai",
        },
        {
          type: "oauth",
        },
      ),
    ).toBe(false)
  })

  test("requires OAuth credentials for the Codex provider", () => {
    expect(
      LLM.isCodexSubscriptionModel(
        {
          providerID: "openai-codex",
        },
        {
          type: "api",
        },
      ),
    ).toBe(false)
    expect(
      LLM.isCodexSubscriptionModel({
        providerID: "openai-codex",
      }),
    ).toBe(false)
  })
})
