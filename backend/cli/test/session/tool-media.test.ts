import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

afterEach(() => HarnessState.reset())

// A 1x1 PNG; small, but every byte of it would be billed as prompt text if it
// were stringified into a tool message.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

/** A model that reads the figure on its first step and answers afterwards. */
function server() {
  const bodies: Array<Array<Record<string, unknown>>> = []
  let step = 0
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-media",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}),
    })}\n\n`
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: Array<Record<string, unknown>> }
      const research = JSON.stringify(body.messages).includes("Methods and deliverables")
      if (!research) {
        return new Response(
          chunk({ role: "assistant", content: "title" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      bodies.push(body.messages)
      step += 1
      if (step === 1) {
        return new Response(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_figure",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ filePath: "figure.png" }) },
                },
              ],
            },
            null,
          ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(
        chunk({ role: "assistant", content: "The figure shows one pixel." }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { instance, bodies }
}

test("a figure a tool returns reaches a string-only transport as an image, not as base64 text", async () => {
  const fixture = server()
  try {
    const config = stressProviderConfig(`${fixture.instance.url.origin}/v1`)
    const models = config.provider[STRESS_PROVIDER_ID].models as Record<string, Record<string, unknown>>
    models[STRESS_PROVIDER_MODEL] = {
      ...models[STRESS_PROVIDER_MODEL],
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    }
    await using tmp = await tmpdir({
      git: true,
      config,
      init: async (dir) => {
        await Bun.write(path.join(dir, "figure.png"), PNG)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          parts: [{ type: "text", text: "Look at figure.png and describe it." }],
        })
        const replay = fixture.bodies[1]!
        const toolIndex = replay.findIndex((message) => message.role === "tool")
        expect(toolIndex).toBeGreaterThan(0)
        const tool = replay[toolIndex]!
        // The tool message stays text: no base64 payload billed as prompt tokens.
        expect(typeof tool.content).toBe("string")
        expect(String(tool.content)).not.toContain(PNG.toString("base64"))
        expect(String(tool.content)).toContain("follows in the next message")
        // The image itself follows as a user message the model reads at image prices.
        const next = replay[toolIndex + 1]!
        expect(next.role).toBe("user")
        const parts = next.content as Array<Record<string, unknown>>
        expect(parts[0]).toMatchObject({ type: "text", text: MessageV2.TOOL_MEDIA_PROMPT })
        const image = parts.find((part) => part.type === "image_url") as { image_url?: { url?: string } } | undefined
        expect(image?.image_url?.url).toContain(PNG.toString("base64"))
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})
