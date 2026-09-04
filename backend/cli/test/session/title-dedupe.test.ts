import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { Log } from "../../src/util/log"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

type Kind = "session" | "message" | "research"

const SESSION_PROMPT = "Generate a title for this conversation"
const MESSAGE_PROMPT = "The following is the text to summarize"
const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }

function reply(text: string) {
  const chunk = {
    id: "chatcmpl-title-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
  }
  const events = [
    { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    },
  ]
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

// A loopback OpenAI-compatible peer. Title requests can be held open (to
// overlap callers) or failed outright; research requests always answer.
function fixture() {
  const requests: { kind: Kind; headers: Headers; body: string }[] = []
  const state = { fail: false, hold: undefined as Promise<void> | undefined }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 })
      const body = await request.text()
      const kind: Kind = body.includes(SESSION_PROMPT)
        ? "session"
        : body.includes(MESSAGE_PROMPT)
          ? "message"
          : "research"
      requests.push({ kind, headers: request.headers, body })
      if (kind === "research") return reply("RESEARCH_ANSWER")
      if (state.hold) await state.hold
      if (state.fail)
        return Response.json(
          { error: { message: "title fixture failure", type: "server_error", code: "title_fixture_failure" } },
          { status: 500 },
        )
      return reply(kind === "session" ? "Fixture session title" : "Fixture message title")
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}/v1`,
    requests,
    state,
    count(kind: Kind) {
      return requests.filter((request) => request.kind === kind).length
    },
    async received(kind: Kind, count: number) {
      const started = Date.now()
      while (this.count(kind) < count) {
        if (Date.now() - started > 5_000) throw new Error(`fixture never received ${count} ${kind} request(s)`)
        await Bun.sleep(10)
      }
    },
    stop() {
      server.stop(true)
    },
  }
}

async function seed(sessionID: string, text: string) {
  const message: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "research",
    effort: "normal",
    model,
    time: { created: Date.now() },
  }
  await Session.updateMessage(message)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
  })
  return message
}

async function timings() {
  await Log.flush()
  const content = await Bun.file(Log.file()).text()
  return content.split("\n").filter((line) => line.includes("request timing"))
}

async function until(check: () => Promise<boolean>) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > 5_000) throw new Error("condition never became true")
    await Bun.sleep(20)
  }
}

async function provide(base: string, fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(base) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn,
  })
}

describe("session title generation", () => {
  test("overlapping ensureTitle calls issue exactly one upstream request", async () => {
    const local = fixture()
    try {
      await provide(local.base, async () => {
        const session = await Session.create({})
        expect(Session.isDefaultTitle(session.title)).toBe(true)
        await seed(session.id, "Compare two sequencing pipelines on the same cohort.")
        const history = await Session.messages({ sessionID: session.id })
        const input = { session, history, providerID: model.providerID, modelID: model.modelID }

        const gate = Promise.withResolvers<void>()
        local.state.hold = gate.promise
        const first = SessionPrompt.ensureTitle(input)
        const second = SessionPrompt.ensureTitle(input)
        await local.received("session", 1)
        gate.resolve()
        await Promise.all([first, second])

        expect(local.count("session")).toBe(1)
        expect((await Session.get(session.id)).title).toBe("Fixture session title")

        // The loop keeps a stale session snapshot whose title is still the
        // default; a later step-1 call must not spend another request.
        await SessionPrompt.ensureTitle(input)
        expect(local.count("session")).toBe(1)
      })
    } finally {
      local.stop()
    }
  })

  test("a failed attempt is not retried by a later loop step inside the cooldown", async () => {
    const local = fixture()
    try {
      await provide(local.base, async () => {
        local.state.fail = true
        const session = await Session.create({})
        await seed(session.id, "Why does the alignment step dominate the runtime?")
        const history = await Session.messages({ sessionID: session.id })
        const input = { session, history, providerID: model.providerID, modelID: model.modelID }

        await SessionPrompt.ensureTitle(input)
        // retries: 0 means the failure cost exactly one upstream request.
        expect(local.count("session")).toBe(1)
        expect(Session.isDefaultTitle((await Session.get(session.id)).title)).toBe(true)

        await SessionPrompt.ensureTitle(input)
        await SessionPrompt.ensureTitle(input)
        expect(local.count("session")).toBe(1)
      })
    } finally {
      local.stop()
    }
  })

  test("the title request carries its own request context, distinct from the research step", async () => {
    const local = fixture()
    try {
      await provide(local.base, async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
          tools: { "*": false },
          parts: [{ type: "text", text: "Which sequencing pipeline finishes first on this cohort?" }],
        })
        expect(result.info.role).toBe("assistant")
        await until(async () => (await Session.get(session.id)).title === "Fixture session title")
        expect(local.count("session")).toBe(1)

        const messages = await Session.messages({ sessionID: session.id })
        const user = messages.find((message) => message.info.role === "user")
        if (!user) throw new Error("expected a user message")
        await until(async () => (await timings()).some((line) => line.includes(`messageID=summary:${user.info.id}`)))

        const lines = await timings()
        const title = lines.filter((line) => line.includes(`messageID=title:${user.info.id} `))
        expect(title).toHaveLength(1)
        expect(title[0]).toContain(`sessionID=${session.id}`)
        expect(title[0]).toContain("attempt=0")
        expect(title[0]).toContain("outcome=completed")

        const research = lines.filter((line) => line.includes(`messageID=${result.info.id} `))
        expect(research.length).toBeGreaterThanOrEqual(1)
        expect(research[0]).toContain(`sessionID=${session.id}`)
        expect(title[0]).not.toContain(`messageID=${result.info.id} `)

        const summary = lines.filter((line) => line.includes(`messageID=summary:${user.info.id} `))
        expect(summary).toHaveLength(1)
        expect(lines.filter((line) => line.includes(`sessionID=${session.id}`))).toHaveLength(3)
      })
    } finally {
      local.stop()
    }
  })

  test("overlapping message summaries issue one title request and honour the cooldown after a failure", async () => {
    const local = fixture()
    try {
      await provide(local.base, async () => {
        const session = await Session.create({ title: "Already titled" })
        const message = await seed(session.id, "Summarize the benchmark results.")

        const gate = Promise.withResolvers<void>()
        local.state.hold = gate.promise
        const first = SessionSummary.summarize({ sessionID: session.id, messageID: message.id })
        const second = SessionSummary.summarize({ sessionID: session.id, messageID: message.id })
        await local.received("message", 1)
        gate.resolve()
        await Promise.all([first, second])
        expect(local.count("message")).toBe(1)
        expect(local.count("session")).toBe(0)
        const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === message.id)
        expect(stored?.info.role === "user" && stored.info.summary?.title).toBe("Fixture message title")

        local.state.hold = undefined
        local.state.fail = true
        const other = await seed(session.id, "A second question about the same benchmark.")
        await expect(SessionSummary.summarize({ sessionID: session.id, messageID: other.id })).rejects.toThrow()
        expect(local.count("message")).toBe(2)
        await SessionSummary.summarize({ sessionID: session.id, messageID: other.id })
        expect(local.count("message")).toBe(2)
      })
    } finally {
      local.stop()
    }
  })
})
