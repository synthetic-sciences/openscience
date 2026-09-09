import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-retry",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

const sse = (body: string) =>
  new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })

test("text streamed by an attempt that failed mid-stream is withdrawn before the retry answers", async () => {
  let turns = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { tools?: unknown[] }
      // Only the research turn offers tools; title and summary requests get text.
      if (!body.tools?.length) return sse(`${chunk({ role: "assistant", content: "Title" })}${chunk({}, "stop")}`)
      turns++
      if (turns === 1) {
        // Half an answer, then the provider gives up on this stream.
        return sse(
          `${chunk({ role: "assistant", content: "PARTIAL_ANSWER_START " })}data: ${JSON.stringify({
            error: { message: "Provider is overloaded, please retry", type: "overloaded_error", code: "overloaded" },
          })}\n\n`,
        )
      }
      return sse(`${chunk({ role: "assistant", content: "FULL_ANSWER." })}${chunk({}, "stop")}`)
    },
  })
  try {
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`http://127.0.0.1:${server.port}/v1`) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "retry" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          parts: [{ type: "text", text: "Answer me." }],
        })
        expect(turns).toBe(2)
        const messages = await Session.messages({ sessionID: session.id })
        const assistant = messages.find((message) => message.info.role === "assistant")
        const texts = (assistant?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
        expect(texts).toEqual(["FULL_ANSWER."])
        expect((assistant?.parts ?? []).filter((part) => part.type === "step-start")).toHaveLength(1)
      },
    })
  } finally {
    server.stop(true)
  }
}, 60_000)
