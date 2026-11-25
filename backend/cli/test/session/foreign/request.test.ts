import { describe, expect, test } from "bun:test"
import { generateText, tool, type ModelMessage } from "ai"
import z from "zod"
import { Instance } from "../../../src/project/instance"
import { Provider } from "../../../src/provider/provider"
import { ProviderTransform } from "../../../src/provider/transform"
import { Session } from "../../../src/session"
import { ForeignConvert } from "../../../src/session/foreign/convert"
import type { ForeignConversation } from "../../../src/session/foreign/types"
import { MessageV2 } from "../../../src/session/message-v2"
import { Log } from "../../../src/util/log"
import { tmpdir } from "../../fixture/fixture"

Log.init({ print: false })

// An imported Claude Code conversation, continued one turn on each wire format.
// The request must carry the history's tool calls with their results, and none
// of the source's thinking or provider metadata.
const conversation: ForeignConversation = {
  info: { source: "claude", id: "conv", path: "/x/conv.jsonl", cwd: "/work", created: 1, modified: 2 },
  branchIDs: [],
  entries: [
    { sourceID: "u1", role: "user", time: 1, parts: [{ type: "text", text: "Find the failing test." }] },
    {
      sourceID: "a1",
      role: "assistant",
      time: 2,
      model: "claude-sonnet-5",
      parts: [
        { type: "reasoning", text: "SOURCE-THINKING-MUST-NOT-TRAVEL" },
        { type: "tool", callID: "toolu_bash", name: "Bash", input: { command: "bun test" }, output: "1 fail: parser" },
        { type: "tool", callID: "toolu_read", name: "Read", input: { file_path: "/work/parser.ts" } },
      ],
    },
    { sourceID: "u2", role: "user", time: 3, parts: [{ type: "text", text: "Ask a subagent." }] },
    {
      sourceID: "a2",
      role: "assistant",
      time: 4,
      model: "claude-sonnet-5",
      parts: [
        {
          type: "tool",
          callID: "toolu_task",
          name: "Task",
          input: { description: "inspect", prompt: "inspect parser" },
          output: "WORKER: off-by-one in parser.ts",
          subagentResult: "WORKER: off-by-one in parser.ts",
        },
        { type: "text", text: "The parser has an off-by-one error." },
      ],
    },
  ],
}

const tools = {
  bash: tool({ inputSchema: z.object({ command: z.string() }) }),
  read: tool({ inputSchema: z.object({ filePath: z.string() }) }),
  task: tool({ inputSchema: z.object({ description: z.string(), prompt: z.string() }) }),
}

type Captured = { path: string; body: Record<string, any> }

async function capture(providerID: string, modelID: string, config: (url: string) => Record<string, any>) {
  const requests: Captured[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({ error: { message: "offline wire capture" } }, { status: 400 })
    },
  })
  await using tmp = await tmpdir({ config: { provider: config(server.url.toString()) } })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        const model = await Provider.getModel(providerID, modelID)
        const session = await Session.create({})
        await ForeignConvert.write({
          sessionID: session.id,
          conversation,
          cwd: tmp.path,
          root: tmp.path,
          agent: "research",
        })
        await Session.flushPendingParts(session.id)
        const history = await Session.messages({ sessionID: session.id })
        const messages: ModelMessage[] = ProviderTransform.message(
          [...MessageV2.toModelMessages(history, model), { role: "user", content: "What should I change?" }],
          model,
          {},
        )
        await generateText({
          model: await Provider.getLanguage(model),
          messages,
          tools,
          maxRetries: 0,
        }).catch(() => undefined)
        await Session.remove(session.id)
      },
    })
  } finally {
    server.stop(true)
  }
  expect(requests).toHaveLength(1)
  return requests[0]
}

function clean(request: Captured) {
  const wire = JSON.stringify(request.body)
  expect(wire).not.toContain("SOURCE-THINKING-MUST-NOT-TRAVEL")
  expect(wire).not.toContain("claude-code")
  expect(wire).not.toContain("signature")
  expect(wire).toContain("WORKER: off-by-one in parser.ts")
  expect(wire).toContain("(no result recorded)")
}

describe("an imported conversation continued on each wire format", () => {
  test("Anthropic Messages", async () => {
    const request = await capture("anthropic", "claude-fable-5-1", (url) => ({
      anthropic: { options: { apiKey: "fixture", baseURL: `${url}v1` } },
    }))
    expect(request.path).toBe("/v1/messages")
    clean(request)
    const blocks = (request.body.messages as Array<{ role: string; content: any }>).flatMap((message) =>
      Array.isArray(message.content) ? message.content.map((block: any) => ({ role: message.role, ...block })) : [],
    )
    expect(blocks.some((block) => block.type === "thinking" || block.type === "redacted_thinking")).toBe(false)
    const uses = blocks.filter((block) => block.type === "tool_use").map((block) => block.id)
    const results = blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id)
    expect(uses.toSorted()).toEqual(["toolu_bash", "toolu_read", "toolu_task"])
    expect(results.toSorted()).toEqual(uses.toSorted())
  })

  test("OpenAI Responses", async () => {
    const request = await capture("openai", "gpt-6.1-sol", (url) => ({
      openai: { options: { apiKey: "fixture", baseURL: `${url}v1` } },
    }))
    expect(request.path).toBe("/v1/responses")
    clean(request)
    const input = request.body.input as Array<Record<string, any>>
    expect(input.some((item) => item.type === "reasoning")).toBe(false)
    const calls = input.filter((item) => item.type === "function_call").map((item) => item.call_id)
    const outputs = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
    expect(calls.toSorted()).toEqual(["toolu_bash", "toolu_read", "toolu_task"])
    expect(outputs.toSorted()).toEqual(calls.toSorted())
  })

  test("OpenAI-compatible Chat Completions", async () => {
    const request = await capture("compat", "compat-model", (url) => ({
      compat: {
        npm: "@ai-sdk/openai-compatible",
        name: "Compat",
        options: { apiKey: "fixture", baseURL: `${url}v1` },
        models: { "compat-model": { name: "Compat model", tool_call: true, limit: { context: 128000, output: 8000 } } },
      },
    }))
    expect(request.path).toBe("/v1/chat/completions")
    clean(request)
    const messages = request.body.messages as Array<Record<string, any>>
    expect(messages.some((message) => "reasoning_content" in message || "reasoning" in message)).toBe(false)
    const calls = messages.flatMap((message) => (message.tool_calls ?? []).map((call: any) => call.id))
    const results = messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)
    expect(calls.toSorted()).toEqual(["toolu_bash", "toolu_read", "toolu_task"])
    expect(results.toSorted()).toEqual(calls.toSorted())
  })
})
