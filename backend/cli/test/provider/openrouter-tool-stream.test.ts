import { expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText, tool } from "ai"
import z from "zod"

test("OpenRouter emits and executes one tool call when later deltas keep completed JSON parseable", async () => {
  const chunks = [
    {
      id: "chatcmpl_tool_once",
      object: "chat.completion.chunk",
      created: 1,
      model: "openai/test",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_same_id",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"pwd","description":"Print working directory"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_tool_once",
      object: "chat.completion.chunk",
      created: 1,
      model: "openai/test",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: " " } }] },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_tool_once",
      object: "chat.completion.chunk",
      created: 1,
      model: "openai/test",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    },
  ]
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
  using server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const provider = createOpenRouter({
    apiKey: "test-key",
    baseURL: `${server.url.origin}/api/v1`,
  })
  let executions = 0
  const result = streamText({
    model: provider.chat("openai/test"),
    prompt: "Print the current directory",
    tools: {
      bash: tool({
        description: "Execute a command",
        inputSchema: z.object({ command: z.string(), description: z.string() }),
        async execute() {
          executions++
          return "done"
        },
      }),
    },
  })

  for await (const _part of result.fullStream) {
    // Consuming the real adapter stream drives tool parsing and execution.
  }
  expect(executions).toBe(1)
  expect((await result.toolCalls).map((call) => call.toolCallId)).toEqual(["call_same_id"])
})
