import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { jsonSchema, streamText, tool } from "ai"
import { Agent } from "../../src/agent/agent"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionTraceStore } from "../../src/session/trace-store"
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

  test("starts provider dispatch while preserving durable trace-before-consumption ordering", async () => {
    const seen = Promise.withResolvers<void>()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
        seen.resolve()
        const chunks = [
          {
            id: "chatcmpl-trace",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-trace",
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
    const sessionID = `session_trace_${crypto.randomUUID()}`
    const lock = path.join(Global.Path.data, "trace", `${encodeURIComponent(sessionID)}.json.lock`)

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
          const agent = Agent.Info.parse({ name: "research", mode: "primary", permission: [], options: {} })
          const user = MessageV2.User.parse({
            id: "message_user",
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: model.providerID, modelID: model.id },
          })
          await fs.mkdir(path.dirname(lock), { recursive: true })
          await Bun.write(lock, JSON.stringify({ pid: process.pid, created: Date.now() }))

          const pending = LLM.stream({
            user,
            sessionID,
            model,
            agent,
            system: ["Reply with OK"],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Reply with OK" }],
            tools: {},
            trace: { messageID: "message_assistant", attempt: 1 },
          })
          await Promise.race([
            seen.promise,
            Bun.sleep(2_000).then(() => {
              throw new Error("provider dispatch did not start while trace persistence was locked")
            }),
          ])
          expect(await Promise.race([pending.then(() => "resolved"), Bun.sleep(30).then(() => "pending")])).toBe(
            "pending",
          )

          await fs.unlink(lock)
          const result = await pending
          const trace = await SessionTraceStore.read(sessionID)
          expect(trace.harness).toHaveLength(1)
          expect(trace.harness[0]?.messageID).toBe("message_assistant")
          expect(await result.text).toBe("OK")
        },
      })
    } finally {
      await fs.unlink(lock).catch(() => undefined)
      await SessionTraceStore.remove(sessionID)
      server.stop(true)
    }
  })
})
