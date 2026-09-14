import { afterEach, expect, test } from "bun:test"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

afterEach(() => HarnessState.reset())

const PROVIDER = "prefix"
const MODEL = "prefix-model"

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; tool_choice?: unknown }

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-prefix",
    object: "chat.completion.chunk",
    created: 1,
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

/** Records every request body; answers turns with a marker and summaries with a handoff. */
function startProvider() {
  const bodies: Body[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Body
      const text = JSON.stringify(body.messages)
      if (text.includes("title generator")) return reply("A title")
      bodies.push(body)
      if (text.includes("Output exactly this Markdown structure")) return reply("## Objective\n- Answer questions")
      return reply("ANSWER")
    },
  })
  return { server, bodies }
}

test("a summary rides the conversation's own prefix: same header, system, tools offered but not callable", async () => {
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
            name: "Prefix fixture",
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
        const session = await Session.create({ title: "Shared prefix" })
        const model = { providerID: PROVIDER, modelID: MODEL }
        await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
          parts: [{ type: "text", text: "QUESTION:first" }],
        })
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "research",
          model,
          auto: false,
          trigger: "manual",
        })
        const compacted = await SessionPrompt.loop(session.id)
        expect(compacted.info.role === "assistant" && compacted.info.summary).toBe(true)

        const turn = bodies(provider).at(0)!
        const summary = bodies(provider).at(-1)!
        // Byte-identical system block and tool schemas: the provider serves the
        // head of the summary request from the cache the turn wrote.
        expect(system(summary)).toBe(system(turn))
        expect(JSON.stringify(summary.tools)).toBe(JSON.stringify(turn.tools))
        expect(summary.tools?.length).toBeGreaterThan(0)
        expect(summary.tool_choice).toBe("none")
        // The conversation so far is a prefix of the summary request; the
        // handoff instruction is the one new message at the end.
        const turnMessages = JSON.stringify(turn.messages.filter((message) => message.role !== "system"))
        const summaryMessages = JSON.stringify(summary.messages.filter((message) => message.role !== "system"))
        const head = turnMessages.slice(0, turnMessages.lastIndexOf('{"role":"user"'))
        expect(summaryMessages.startsWith(head)).toBe(true)
        const last = summary.messages.at(-1)!
        expect(last.role).toBe("user")
        expect(JSON.stringify(last.content)).toContain(SessionCompaction.HANDOFF_PREAMBLE.slice(0, 40))
        expect(JSON.stringify(last.content)).toContain("Output exactly this Markdown structure")
        // No compaction-agent header replaced the research header.
        expect(system(summary)).not.toContain("context summarization agent")
      },
    })
  } finally {
    provider.server.stop(true)
  }
})

function bodies(provider: ReturnType<typeof startProvider>) {
  return provider.bodies
}

function system(body: Body) {
  return body.messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
}
