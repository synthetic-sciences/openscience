import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"
import { jsonSchema, tool, type ModelMessage } from "ai"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import type { MessageV2 } from "../../src/session/message-v2"

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
