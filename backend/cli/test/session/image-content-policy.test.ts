import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Log } from "../../src/util/log"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

Log.init({ print: false })

// A 1×1 PNG: enough for the read tool to attach it as an image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "chatcmpl-policy",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } : {}),
  }
}

function sse(events: ReturnType<typeof chunk>[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function textReply(reply: string) {
  return sse([chunk({ role: "assistant", content: reply }, null), chunk({}, "stop")])
}

function toolCall(name: string, args: Record<string, unknown>) {
  return sse([
    chunk(
      {
        role: "assistant",
        tool_calls: [
          { index: 0, id: `call_${name}_1`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      null,
    ),
    chunk({}, "tool_calls"),
  ])
}

/** The provider: asks to read the image, refuses every request that carries
 * an image with the content-policy error Azure OpenAI returns, and answers
 * once the image is gone. */
function fixture(image: { path: string }) {
  const requests: { image: boolean; toolResult: boolean }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = await request.text()
      if (body.includes("The following is the text to summarize:")) return textReply("Fixture title")
      const hasImage = body.includes("data:image/png;base64")
      const toolResult = body.includes('"role":"tool"')
      requests.push({ image: hasImage, toolResult })
      if (hasImage) {
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "content_policy_violation",
              message: "Image processing blocked due to content policy violation.",
              param: "input",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      }
      if (!toolResult) return toolCall("read", { filePath: image.path })
      return textReply("ANSWERED_WITHOUT_THE_IMAGE")
    },
  })
  return { server, requests }
}

describe("an image the provider's content filter refuses", () => {
  test("is withheld from the transcript and the step runs again without it", async () => {
    const image = { path: "" }
    const local = fixture(image)
    try {
      const config = stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`)
      // The fixture model must be able to look at images for one to be sent.
      const model = config.provider[STRESS_PROVIDER_ID].models[STRESS_PROVIDER_MODEL] as Record<string, unknown>
      model.attachment = true
      model.modalities = { input: ["text", "image"], output: ["text"] }
      await using tmp = await tmpdir({
        git: true,
        config,
        init: (directory) => Bun.write(path.join(directory, "census.png"), PNG),
      })
      image.path = path.join(tmp.path, "census.png")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "content policy" })
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            parts: [{ type: "text", text: "Look at census.png and describe it." }],
          })
          // Three requests: the tool call, the refusal with the image attached,
          // the answer once it is withheld. The refused request is never resent.
          expect(local.requests.map((request) => request.image)).toEqual([false, true, false])
          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.error).toBeUndefined()
          expect(result.parts.some((part) => part.type === "text" && part.text === "ANSWERED_WITHOUT_THE_IMAGE")).toBe(
            true,
          )
          // The read result keeps its text and says why the image is gone.
          const messages = await Session.messages({ sessionID: session.id })
          const read = messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool" && part.tool === "read")
          expect(read?.type === "tool" && read.state.status === "completed" && read.state.attachments).toEqual([])
          expect(read?.type === "tool" && read.state.status === "completed" && read.state.output).toContain(
            SessionProcessor.WITHHELD_NOTE,
          )
        },
      })
    } finally {
      local.server.stop(true)
    }
  }, 30_000)
})
