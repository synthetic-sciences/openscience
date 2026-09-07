import { describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionLoopState } from "../../src/session/loop-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "chatcmpl-epoch",
    object: "chat.completion.chunk",
    created: 0,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  }
}

function respond(events: object[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

/** A synthetic continuation of `epoch`, as the loop writes after an output limit. */
async function continuation(sessionID: string, epoch: string) {
  const id = await MessageV2.nextMessageID(sessionID)
  const text = "Your previous response reached the output limit before the task completed."
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    model,
    effort: "normal",
    internal: SessionLoopState.intent({ kind: "output", text, epoch, transaction: id }),
  })
  await Session.updatePart({
    id: SessionLoopState.partID(id, "continuation"),
    sessionID,
    messageID: id,
    type: "text",
    text,
    synthetic: true,
    metadata: SessionLoopState.continuation("output"),
  })
  return id
}

/** A model that reads one or three distinct notes in a single step, then answers. */
function serve(project: { directory: string }) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: unknown }
      const transcript = JSON.stringify(body.messages ?? [])
      if (transcript.includes('"role":"tool"')) {
        return respond([chunk({ role: "assistant", content: "Notes read." }, null), chunk({}, "stop")])
      }
      const count = transcript.includes("three notes") ? 3 : 1
      const calls = Array.from({ length: count }, (_, index) =>
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index,
                id: `call_note_${index}`,
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ filePath: path.join(project.directory, `note-${index}.txt`) }),
                },
              },
            ],
          },
          null,
        ),
      )
      return respond([...calls, chunk({}, "tool_calls")])
    },
  })
}

/** Older, answered requests: the history a long session accumulates. */
async function seed(sessionID: string, turns: number) {
  const ids: string[] = []
  for (let index = 0; index < turns; index++) {
    const user = await SessionPrompt.prompt({
      sessionID,
      agent: "research",
      model,
      noReply: true,
      parts: [{ type: "text", text: `earlier request ${index}` }],
    })
    const assistant: MessageV2.Assistant = {
      id: await MessageV2.nextMessageID(sessionID),
      sessionID,
      parentID: user.info.id,
      role: "assistant",
      agent: "research",
      mode: "research",
      providerID: model.providerID,
      modelID: model.modelID,
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: index, completed: index },
      finish: "stop",
    }
    await Session.updateMessage(assistant)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID,
      messageID: assistant.id,
      type: "text",
      text: `earlier answer ${index}`,
    })
    ids.push(user.info.id, assistant.id)
  }
  return ids
}

describe("epoch-scoped history for the repeated-call guard", () => {
  test("MessageV2.epoch reads only the current request's records", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Epoch reader" })
        const [u0, a0, u1, a1] = await seed(session.id, 2)
        const resumed = await continuation(session.id, u1!)
        const reads = spyOn(Storage, "read")
        try {
          const messages = await MessageV2.epoch(session.id, resumed)
          expect(messages.map((message) => message.info.id)).toEqual([u1, a1, resumed])
          const records = reads.mock.calls.map(([key]) => key).filter((key) => key[0] === "message")
          expect(records.map((key) => key[2])).not.toContain(u0)
          expect(records.map((key) => key[2])).not.toContain(a0)
        } finally {
          reads.mockRestore()
        }
        // The epoch anchor is the parent's own prompt when it is external.
        const own = await MessageV2.epoch(session.id, u1!)
        expect(own.map((message) => message.info.id)).toEqual([u1, a1, resumed])
        // A fresh external prompt starts its own epoch.
        const next = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "research",
          model,
          noReply: true,
          parts: [{ type: "text", text: "a new request" }],
        })
        expect((await MessageV2.epoch(session.id, next.info.id)).map((message) => message.info.id)).toEqual([
          next.info.id,
        ])
      },
    })
  })

  test("a long session is not re-read once per tool call", async () => {
    const target = { directory: "" }
    using server = serve(target)
    await using project = await tmpdir({ git: true, config: stressProviderConfig(`${server.url.origin}/v1`) })
    target.directory = project.path
    for (const index of [0, 1, 2]) await Bun.write(path.join(project.path, `note-${index}.txt`), `note ${index}`)
    await Instance.provide({
      directory: project.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const timings: Provider.RequestTiming[] = []
        const stop = Provider.onTiming((timing) => timings.push(timing))
        const run = async (request: string, calls: number) => {
          const session = await Session.create({
            title: request,
            permission: [{ permission: "read", pattern: "*", action: "allow" }],
          })
          const [oldest] = await seed(session.id, 24)
          const reads = spyOn(Storage, "read")
          try {
            const result = await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "research",
              model,
              parts: [{ type: "text", text: request }],
            })
            expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
            const history = await Session.messages({ sessionID: session.id })
            const tools = history.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
            expect(tools).toHaveLength(calls)
            expect(tools.every((part) => part.state.status === "completed")).toBe(true)
            return reads.mock.calls.filter(([key]) => key[0] === "message" && key[2] === oldest).length
          } finally {
            reads.mockRestore()
          }
        }
        try {
          const single = await run("Read one note from this project.", 1)
          const triple = await run("Read three notes from this project.", 3)
          expect(single).toBeGreaterThan(0)
          expect(triple).toBe(single)
          // The loopback provider is a local endpoint: no header deadline applies.
          expect(timings.length).toBeGreaterThanOrEqual(4)
          expect(timings.every((timing) => timing.connectTimeoutMs === false)).toBe(true)
        } finally {
          stop()
        }
      },
    })
  })
})
