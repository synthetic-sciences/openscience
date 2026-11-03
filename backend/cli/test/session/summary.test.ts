import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"
import { SubagentBudget } from "../../src/session/subagent-budget"

test.each(["anthropic/claude-opus-5.5", "anthropic/claude-fable-5.1"])(
  "bounded %s summaries keep thinking enabled and settle their own usage",
  async (id) => {
    const requests: { model: string; reasoning?: { enabled?: boolean; effort?: string } }[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body: (typeof requests)[number] = await request.json()
        requests.push(body)
        if (body.reasoning?.enabled === false)
          return Response.json({ error: { message: "This model requires thinking" } }, { status: 422 })
        const chunk = {
          id: "chatcmpl_summary",
          object: "chat.completion.chunk",
          created: 1,
          model: id,
        }
        const events = [
          {
            ...chunk,
            choices: [{ index: 0, delta: { role: "assistant", content: "Bounded review" }, finish_reason: null }],
          },
          {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          },
        ]
        return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "byok" },
        provider: {
          openrouter: {
            options: { apiKey: "fixture", baseURL: `${server.url}v1` },
            models: {
              [id]: { name: id, reasoning: true, temperature: false, limit: { context: 200000, output: 32768 } },
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        const messageID = Identifier.ascending("message")
        try {
          await SubagentBudget.open({
            rootSessionID: root.id,
            parentSessionID: root.id,
            sessionID: child.id,
            assignmentID: "summary",
            objective: "Review the allowance",
            expectedOutput: "Findings",
            model: { providerID: "openrouter", modelID: id },
            route: "local",
            unit: "tokens",
            allocation: 100000,
            settings: { tokens: 200000 },
          })
          await Session.updateMessage({
            id: messageID,
            role: "user",
            sessionID: child.id,
            effort: "normal",
            agent: "general",
            model: { providerID: "openrouter", modelID: id },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: child.id,
            messageID,
            type: "text",
            text: "Review the bounded allowance.",
          })
          await SessionSummary.summarize({ sessionID: child.id, messageID })
          expect(requests).toHaveLength(1)
          expect(requests[0]).toMatchObject({ model: id, reasoning: { effort: "low" } })
          expect((await Session.messages({ sessionID: child.id }))[0].info).toMatchObject({
            summary: { title: "Bounded review" },
          })
          const budget = await SubagentBudget.read(child.id)
          expect(budget?.worker.spent).toBe(15)
          expect(Object.values(budget!.worker.calls)).toMatchObject([{ state: "settled", consumed: 15 }])
        } finally {
          await Session.remove(root.id)
          Provider.invalidate()
        }
      },
    })
  },
)

test("summary ignores messages removed with their session", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageID = Identifier.ascending("message")

      await expect(SessionSummary.summarize({ sessionID: session.id, messageID })).resolves.toBeUndefined()

      await Session.remove(session.id)
      await expect(SessionSummary.summarize({ sessionID: session.id, messageID })).resolves.toBeUndefined()
    },
  })
})

test("a stale summary update cannot recreate a removed user message", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        role: "user",
        sessionID: session.id,
        effort: "normal",
        agent: "default",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })

      const key = ["message", session.id, messageID]
      try {
        await Storage.remove(key)
        const updating = Storage.update<MessageV2.User>(key, (draft) => {
          draft.summary = { diffs: [] }
        })

        await expect(updating).rejects.toBeInstanceOf(Storage.NotFoundError)
        await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})
