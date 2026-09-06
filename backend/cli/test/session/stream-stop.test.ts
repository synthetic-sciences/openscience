import { expect, test } from "bun:test"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { SessionRoutes } from "../../src/server/routes/session"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const marker = "STOP_DEFAULT_STREAM_FIXTURE"
const encoder = new TextEncoder()

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: "chatcmpl-stop", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("The isolated Stop fixture did not settle")
    await Bun.sleep(5)
  }
}

test.each(["quiet-response", "active-tool"])(
  "the actual Stop route cancels a %s with default response deadlines",
  async (mode) => {
    let requests = 0
    let cancelled = false
    let toolStarted = false
    let toolStopped = false
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (!JSON.stringify(await request.json()).includes(marker)) {
          return new Response(`${chunk({ content: "Fixture title" })}${chunk({}, "stop")}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        requests++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "Keep this partial answer." })))
              if (mode === "quiet-response") return
              controller.enqueue(
                encoder.encode(
                  chunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: "stop_tool",
                        type: "function",
                        function: { name: "stop_fixture", arguments: "{}" },
                      },
                    ],
                  }) + chunk({}, "tool_calls"),
                ),
              )
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${server.url.origin}/v1`) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("stop_fixture", {
            description: "Wait for explicit cancellation",
            parameters: z.object({}),
            async execute(_args, context) {
              try {
                await new Promise<never>((_resolve, reject) => {
                  context.abort.throwIfAborted()
                  context.abort.addEventListener("abort", () => reject(context.abort.reason), { once: true })
                  toolStarted = true
                })
                throw new Error("The cancellation fixture must not succeed")
              } finally {
                toolStopped = true
              }
            },
          }),
        )
        const session = await Session.create({
          title: "Stop fixture",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const running = SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          system: marker,
          tools: mode === "active-tool" ? { stop_fixture: true } : {},
          parts: [{ type: "text", text: "Run the local fixture once." }],
        })
        let settled = false
        void running.then(
          () => (settled = true),
          () => (settled = true),
        )
        try {
          // The SDK can start execute() before the processor consumes earlier
          // text events. Stop only after the transcript owns the partial text.
          await until(async () => {
            if (mode === "active-tool" && !toolStarted) return false
            const messages = await Session.messages({ sessionID: session.id })
            return messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "Keep this partial answer."),
            )
          })
          const response = await SessionRoutes().request(`/${session.id}/abort`, { method: "POST" })
          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          await until(() => settled && cancelled && (mode !== "active-tool" || toolStopped))
          const result = await running
          expect(result.info).toMatchObject({ role: "assistant", error: { name: "MessageAbortedError" } })
          expect(result.parts.find((part) => part.type === "text")).toMatchObject({
            text: "Keep this partial answer.",
            time: { end: expect.any(Number) },
          })
          expect(requests).toBe(1)
          expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })
          expect(SessionPrompt.activeController(session.id)).toBeUndefined()
          if (mode === "active-tool") {
            const messages = await Session.messages({ sessionID: session.id })
            expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toEqual([
              expect.objectContaining({ callID: "stop_tool", state: expect.objectContaining({ status: "error" }) }),
            ])
          }
        } finally {
          SessionPrompt.cancel(session.id)
          await running.catch(() => {})
        }
      },
    })
  },
  15_000,
)
