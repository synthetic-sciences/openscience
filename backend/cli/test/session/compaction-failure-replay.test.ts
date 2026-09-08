import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

const PROVIDER = "carrier"
const MODEL = "carrier-model"

type Request = { kind: "main" | "summary" | "title"; text: string }

function textFrom(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFrom).join("\n")
  if (!value || typeof value !== "object") return ""
  return Object.values(value).map(textFrom).join("\n")
}

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-carrier",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

function reply(text: string) {
  return new Response(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

// A provider whose summaries always fail with a permanent error, while
// ordinary turns answer with a recognisable marker.
function startProvider() {
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: unknown }
      const text = textFrom(body.messages)
      const kind: Request["kind"] = text.includes("Output exactly this Markdown structure")
        ? "summary"
        : text.includes("title generator")
          ? "title"
          : "main"
      requests.push({ kind, text })
      if (kind === "summary") {
        return Response.json(
          { error: { message: "summary_rejected", type: "invalid_request_error", code: "summary_rejected" } },
          { status: 400 },
        )
      }
      if (kind === "title") return reply("Carrier title")
      const question = [...text.matchAll(/QUESTION:([a-z]+)/g)].at(-1)?.[1] ?? "unknown"
      return reply(`ANSWER:${question}`)
    },
  })
  return { server, requests }
}

describe("a failed compaction never hijacks the next prompt", () => {
  test("the next real prompt is answered, not summarised, after the summary request fails", async () => {
    const provider = startProvider()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: `${PROVIDER}/${MODEL}`,
          small_model: `${PROVIDER}/${MODEL}`,
          default_agent: "research",
          enabled_providers: [PROVIDER],
          billing: { llm: "byok" as const },
          provider: {
            [PROVIDER]: {
              name: "Carrier fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "local-only", baseURL: `http://127.0.0.1:${provider.server.port}/v1` },
              models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 128_000, output: 4_096 } } },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "Failed compaction" })
          const model = { providerID: PROVIDER, modelID: MODEL }
          const first = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            parts: [{ type: "text", text: "QUESTION:first" }],
          })
          expect(first.parts.some((part) => part.type === "text" && part.text === "ANSWER:first")).toBe(true)

          await SessionCompaction.create({
            sessionID: session.id,
            agent: "research",
            model,
            auto: false,
            trigger: "manual",
          })
          const compacted = await SessionPrompt.loop(session.id)
          expect(compacted.info.role).toBe("assistant")
          if (compacted.info.role !== "assistant") throw new Error("expected a summary attempt")
          expect(compacted.info.summary).toBe(true)
          expect(compacted.info.error).toBeDefined()
          expect(provider.requests.filter((request) => request.kind === "summary")).toHaveLength(1)

          const second = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            parts: [{ type: "text", text: "QUESTION:second" }],
          })
          expect(second.info.role).toBe("assistant")
          if (second.info.role !== "assistant") throw new Error("expected an answer")
          expect(second.info.summary).toBeUndefined()
          expect(second.info.error).toBeUndefined()
          expect(second.parts.some((part) => part.type === "text" && part.text === "ANSWER:second")).toBe(true)
          // The stale carrier was not replayed under the new prompt.
          expect(provider.requests.filter((request) => request.kind === "summary")).toHaveLength(1)

          const third = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            parts: [{ type: "text", text: "QUESTION:third" }],
          })
          expect(third.parts.some((part) => part.type === "text" && part.text === "ANSWER:third")).toBe(true)
          expect(provider.requests.filter((request) => request.kind === "summary")).toHaveLength(1)
        },
      })
    } finally {
      provider.server.stop(true)
    }
  })
})
