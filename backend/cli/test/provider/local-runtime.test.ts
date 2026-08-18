import { describe, expect, test } from "bun:test"
import { jsonSchema, streamText, tool } from "ai"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

describe("local OpenAI-compatible runtime", () => {
  test("streams a response with an object-rooted tool contract", async () => {
    const requests: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
        requests.push((await request.json()) as Record<string, unknown>)
        const chunks = [
          {
            id: "chatcmpl-local",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-local",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
        const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
    })

    try {
      await using tmp = await tmpdir({
        config: {
          provider: {
            ollama: {
              name: "Ollama (local)",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local" },
              models: {
                "fixture-model": {
                  name: "fixture-model",
                  tool_call: true,
                  limit: { context: 32_768, output: 2_048 },
                },
              },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => Provider.invalidate(),
        fn: async () => {
          const model = await Provider.getModel("ollama", "fixture-model")
          const language = await Provider.getLanguage(model)
          const result = streamText({
            model: language,
            prompt: "Reply with OK",
            tools: {
              inspect: tool({
                description: "Inspect one value",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                }),
              }),
            },
          })
          expect(await result.text).toBe("OK")
        },
      })

      const tools = requests[0]?.tools as Array<{ function: { parameters: { type?: string } } }>
      expect(tools[0]?.function.parameters.type).toBe("object")
    } finally {
      server.stop(true)
    }
  })
})
