import { expect, test } from "bun:test"
import z from "zod"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { SessionTelemetry } from "../../src/session/telemetry"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const encoder = new TextEncoder()
const marker = "STALL_RECOVERY_MAIN_REQUEST"

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: "chatcmpl-stall", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}) })}\n\n`
}

test.each(["silence", "keepalive", "private-reasoning"])(
  "stops %s, keeps partial work, and sends only one model request",
  async (mode) => {
    let requests = 0
    let cancelled = false
    const timers = new Set<ReturnType<typeof setInterval>>()
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        if (!JSON.stringify(body).includes(marker)) {
          return new Response(`${chunk({ content: "Helper title" })}${chunk({}, "stop")}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        requests++
        let timer: ReturnType<typeof setInterval> | undefined
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(chunk({ role: "assistant", reasoning_content: "Saved partial reasoning." })),
              )
              controller.enqueue(encoder.encode(chunk({ content: "Saved partial answer." })))
              if (mode === "silence") return
              timer = setInterval(
                () =>
                  controller.enqueue(
                    encoder.encode(
                      mode === "keepalive" ? ": PROCESSING\n\n" : chunk({ reasoning_content: "[REDACTED]" }),
                    ),
                  ),
                20,
              )
              timers.add(timer)
            },
            cancel() {
              cancelled = true
              clearInterval(timer)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const base = stressProviderConfig(`http://127.0.0.1:${server.port}/v1`)
    const config = {
      ...base,
      provider: {
        ...base.provider,
        [STRESS_PROVIDER_ID]: {
          ...base.provider[STRESS_PROVIDER_ID],
          options: {
            ...base.provider[STRESS_PROVIDER_ID].options,
            connectTimeout: 2_000,
            idleTimeout: mode === "silence" ? 160 : 2_000,
            outputIdleTimeout: 240,
          },
        },
      },
    }
    await using tmp = await tmpdir({ git: true, config })
    try {
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "Stall recovery" })
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegation: false,
            system: marker,
            parts: [{ type: "text", text: "Answer once." }],
          })
          expect(requests).toBe(1)
          expect(result.info).toMatchObject({
            role: "assistant",
            time: { completed: expect.any(Number) },
            error: {
              name: "APIError",
              data: {
                isRetryable: false,
                metadata: {
                  code: "provider_request_timeout",
                  action: "resubmit",
                  phase: mode === "silence" ? "stream" : "output",
                },
              },
            },
          })
          expect(
            result.parts.find((part) => part.type === "text" && part.text.includes("Saved partial answer.")),
          ).toMatchObject({ time: { end: expect.any(Number) } })
          expect(
            result.parts.find((part) => part.type === "reasoning" && part.text.includes("Saved partial reasoning.")),
          ).toMatchObject({ time: { end: expect.any(Number) } })
          expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })
          expect(SessionTelemetry.progress(session.id)?.phase).toBe("error")
          const durable = await Session.messages({ sessionID: session.id })
          expect(durable.find((message) => message.info.id === result.info.id)?.info).toEqual(result.info)
          for (let index = 0; index < 40 && !cancelled; index++) await Bun.sleep(10)
          expect(cancelled).toBe(true)
        },
      })
    } finally {
      for (const timer of timers) clearInterval(timer)
    }
  },
  20_000,
)

test.each(["finished-stream", "stalled-stream"])(
  "preserves an actual long-running tool after %s",
  async (mode) => {
    let requests = 0
    let executions = 0
    let cancelled = false
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        if (!JSON.stringify(body).includes(marker)) {
          return new Response(`${chunk({ content: "Helper title" })}${chunk({}, "stop")}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        requests++
        if (
          Array.isArray(body.messages) &&
          body.messages.some((message: { role?: string }) => message.role === "tool")
        ) {
          return new Response(
            `${chunk({ content: "The local tool completed." })}${chunk({}, "stop")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        const call = chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_long_tool",
              type: "function",
              function: {
                name: "stall_fixture",
                arguments: "{}",
              },
            },
          ],
        })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`${call}${chunk({}, "tool_calls")}`))
              if (mode === "stalled-stream") return
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const base = stressProviderConfig(`http://127.0.0.1:${server.port}/v1`)
    const config = {
      ...base,
      provider: {
        ...base.provider,
        [STRESS_PROVIDER_ID]: {
          ...base.provider[STRESS_PROVIDER_ID],
          options: {
            ...base.provider[STRESS_PROVIDER_ID].options,
            connectTimeout: 2_000,
            idleTimeout: mode === "stalled-stream" ? 450 : 2_000,
            outputIdleTimeout: 250,
          },
        },
      },
    }
    await using tmp = await tmpdir({ git: true, config })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("stall_fixture", {
            description: "Wait locally and return a completion marker",
            parameters: z.object({}),
            async execute(_args, context) {
              executions++
              await Bun.sleep(1100)
              context.abort.throwIfAborted()
              return { title: "Local wait completed", output: "LONG_TOOL_COMPLETED", metadata: {} }
            },
          }),
        )
        const session = await Session.create({
          title: "Long tool stall recovery",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          system: marker,
          tools: { stall_fixture: true },
          parts: [{ type: "text", text: "Run the local fixture once, then report the result." }],
        })
        const messages = await Session.messages({ sessionID: session.id })
        const tools = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.callID === "call_long_tool")
        expect(tools).toHaveLength(1)
        const tool = tools[0]
        expect(tool).toMatchObject({
          tool: "stall_fixture",
          state: { status: "completed", output: expect.stringContaining("LONG_TOOL_COMPLETED") },
        })
        expect(executions).toBe(1)
        if (tool.type !== "tool" || tool.state.status !== "completed")
          throw new Error("Expected a completed local tool")
        expect(tool.state.time.end - tool.state.time.start).toBeGreaterThan(900)
        expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })
        if (result.info.role !== "assistant") throw new Error("Expected an assistant result")
        if (mode === "finished-stream") {
          expect(result.info.error).toBeUndefined()
          expect(requests).toBe(2)
          expect(
            result.parts.some((part) => part.type === "text" && part.text.includes("The local tool completed.")),
          ).toBe(true)
          return
        }
        expect(requests).toBe(1)
        expect(result.info.error).toMatchObject({
          name: "APIError",
          data: { isRetryable: false, metadata: { code: "provider_request_timeout", phase: "stream" } },
        })
        for (let index = 0; index < 40 && !cancelled; index++) await Bun.sleep(10)
        expect(cancelled).toBe(true)
      },
    })
  },
  20_000,
)
