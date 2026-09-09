import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-title",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

test("a rename made while the title request is in flight is not overwritten by the generated title", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(400)
      return new Response(
        `${chunk({ role: "assistant", content: "Generated title" })}${chunk({}, "stop")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
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
        const session = await Session.create({})
        expect(Session.isDefaultTitle(session.title)).toBe(true)
        const id = "msg_title000000000000000000"
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          effort: "normal",
        })
        await Session.updatePart({
          id: "prt_title000000000000000000",
          messageID: id,
          sessionID: session.id,
          type: "text",
          text: "Hello",
        })
        const history = await Session.messages({ sessionID: session.id })

        const generating = SessionPrompt.ensureTitle({
          session,
          history,
          providerID: STRESS_PROVIDER_ID,
          modelID: STRESS_PROVIDER_MODEL,
        })
        await Bun.sleep(100)
        await Session.update(session.id, (draft) => {
          draft.title = "User chosen name"
        })
        await generating
        expect((await Session.get(session.id)).title).toBe("User chosen name")

        // A session nobody renamed still receives the generated title.
        const other = await Session.create({})
        await SessionPrompt.ensureTitle({
          session: other,
          history,
          providerID: STRESS_PROVIDER_ID,
          modelID: STRESS_PROVIDER_MODEL,
        })
        expect((await Session.get(other.id)).title).toBe("Generated title")
      },
    })
  } finally {
    server.stop(true)
  }
}, 30_000)
