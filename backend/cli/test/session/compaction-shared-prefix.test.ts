import { afterEach, expect, test } from "bun:test"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionFilesystem } from "../../src/session/filesystem"
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

function reply(text: string, reasoning?: string) {
  const thought = reasoning ? chunk({ role: "assistant", reasoning_content: reasoning }, null) : ""
  return new Response(
    `${thought}${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
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
      return reply("ANSWER", "THOUGHT")
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
        compaction: { tailTurns: 1 },
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
        // Two typed requests whose replies carried reasoning. The tail keeps
        // the newest turn verbatim (tailTurns 1), so the head the summary
        // renders ends before the conversation's reasoning boundary.
        await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
          parts: [{ type: "text", text: "QUESTION:first" }],
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
          parts: [{ type: "text", text: "QUESTION:second" }],
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
        expect(compacted.info.role === "assistant" && compacted.info.tailStartId).toBeDefined()
        // The record names the agent whose header produced the handoff.
        expect(compacted.info.role === "assistant" && compacted.info.agent).toBe("research")

        const turn = bodies(provider).at(1)!
        const summary = bodies(provider).at(-1)!
        // Byte-identical system block and tool schemas: the provider serves the
        // head of the summary request from the cache the turn wrote.
        expect(system(summary)).toBe(system(turn))
        expect(JSON.stringify(summary.tools)).toBe(JSON.stringify(turn.tools))
        expect(summary.tools?.length).toBeGreaterThan(0)
        expect(summary.tool_choice).toBe("none")
        // The conversation before the newest request is a prefix of the
        // summary request, rendered as the second turn rendered it (the first
        // reply's reasoning stripped as an earlier turn); the handoff
        // instruction is the one new message at the end.
        const turnMessages = JSON.stringify(turn.messages.filter((message) => message.role !== "system"))
        const summaryMessages = JSON.stringify(summary.messages.filter((message) => message.role !== "system"))
        const head = turnMessages.slice(0, turnMessages.lastIndexOf('{"role":"user"'))
        expect(head).toContain("QUESTION:first")
        expect(summaryMessages.startsWith(head)).toBe(true)
        expect(summaryMessages).not.toContain('QUESTION:second"')
        expect(summaryMessages).not.toContain("THOUGHT")
        const last = summary.messages.at(-1)!
        expect(last.role).toBe("user")
        expect(JSON.stringify(last.content)).toContain(SessionCompaction.HANDOFF_PREAMBLE.slice(0, 40))
        expect(JSON.stringify(last.content)).toContain("Output exactly this Markdown structure")
        // The summarizer is told which request the handoff is for, since that
        // request lies in the tail it never sees.
        expect(JSON.stringify(last.content)).toContain("<newest-request>\\nQUESTION:second\\n</newest-request>")
        // No compaction-agent header replaced the research header.
        expect(system(summary)).not.toContain("context summarization agent")
      },
    })
  } finally {
    provider.server.stop(true)
  }
})

test("after a summary, the next request carries the current session details, not the ones first sent", async () => {
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
        compaction: { tailTurns: 1 },
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
    await using source = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Details after a summary" })
        const model = { providerID: PROVIDER, modelID: MODEL }
        const ask = (text: string) =>
          SessionPrompt.prompt({ sessionID: session.id, model, agent: "research", parts: [{ type: "text", text }] })
        await ask("QUESTION:first")
        await SessionFilesystem.grant({ sessionID: session.id, path: source.path, access: "read", scope: "project" })
        await ask("QUESTION:second")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "research",
          model,
          auto: false,
          trigger: "manual",
        })
        await SessionPrompt.loop(session.id)
        await ask("QUESTION:third")
        const firstUser = (body: Body) => JSON.stringify(body.messages.find((message) => message.role === "user"))
        const before = bodies(provider).find((body) => JSON.stringify(body.messages).includes("QUESTION:second"))!
        const after = bodies(provider).at(-1)!
        // Before the summary the first message keeps the details first sent;
        // the change was told separately.
        expect(firstUser(before)).not.toContain(source.path)
        // The summary replaced that head, and possibly the notice: the next
        // request's first message carries the current details.
        expect(JSON.stringify(after.messages)).toContain("QUESTION:third")
        expect(firstUser(after)).toContain(source.path)
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
