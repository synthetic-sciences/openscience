import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { TaskAttempt } from "../../src/tool/task-attempt"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

const report =
  "## Outcome\nThe source comparison is complete.\n\n## Limitations\nOne search provider failed; coverage is not exhaustive."

async function retained(input: {
  emptyBaseline?: boolean
  stopReason?: string
  finish?: string
  error?: MessageV2.Assistant["error"]
}) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const userID = Identifier.ascending("message")
      const messageID = Identifier.ascending("message")
      const callID = `call_${crypto.randomUUID()}`
      const params = {
        description: "Review retained sources",
        prompt: "Return the source comparison.",
        subagent_type: "explore" as const,
      }
      const model = { providerID: "offline-fixture", modelID: "no-provider-called" }
      const base = {
        role: "assistant" as const,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "research",
        agent: "research",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      await Session.updateMessage({
        id: userID,
        sessionID: parent.id,
        role: "user",
        agent: "research",
        effort: "normal",
        model,
        time: { created: 1 },
      })
      await Session.updateMessage({
        ...base,
        id: messageID,
        sessionID: parent.id,
        parentID: userID,
        time: { created: 2 },
      })
      const identity = {
        projectID: Instance.project.id,
        parentSessionID: parent.id,
        parentMessageID: messageID,
        parentUserMessageID: userID,
        callID,
      }
      const attempt = await TaskAttempt.reserve({
        ...identity,
        fingerprint: TaskAttempt.fingerprint(params),
        childSessionID: child.id,
      })
      const previous = input.emptyBaseline ? [] : [Identifier.ascending("message")]
      if (previous[0]) {
        await Session.updateMessage({
          id: previous[0],
          sessionID: child.id,
          role: "user",
          agent: "research",
          effort: "normal",
          model,
          time: { created: 1 },
        })
      }
      await TaskAttempt.bind({ ...identity, previousMessageIDs: previous })
      await Session.updateMessage({
        id: attempt.childMessageID,
        sessionID: child.id,
        role: "user",
        agent: "research",
        effort: "normal",
        model,
        time: { created: 3 },
      })
      const toolsID = Identifier.ascending("message")
      const tools: MessageV2.ToolPart[] = [
        {
          id: Identifier.ascending("part"),
          sessionID: child.id,
          messageID: toolsID,
          type: "tool",
          tool: "research_search",
          callID: "call_unavailable",
          state: {
            status: "completed",
            input: { query: "primary sources" },
            title: "Research search unavailable",
            output: "Search provider returned HTTP 500. No results were returned.",
            metadata: { outcome: "partial", stopReason: input.stopReason ?? "search_unavailable" },
            time: { start: 4, end: 5 },
          },
        },
        {
          id: Identifier.ascending("part"),
          sessionID: child.id,
          messageID: toolsID,
          type: "tool",
          tool: "science_fetch",
          callID: "call_alternative",
          state: {
            status: "completed",
            input: { id: "primary-source" },
            title: "Fetched primary source",
            output: "A separate source contains the reported comparison.",
            metadata: {},
            time: { start: 6, end: 7 },
          },
        },
      ]
      await Session.updateMessage({
        ...base,
        id: toolsID,
        sessionID: child.id,
        parentID: attempt.childMessageID,
        finish: "tool-calls",
        time: { created: 4, completed: 7 },
      })
      for (const part of tools) await Session.updatePart(part)
      const finalID = Identifier.ascending("message")
      await Session.updateMessage({
        ...base,
        id: finalID,
        sessionID: child.id,
        parentID: attempt.childMessageID,
        finish: input.finish ?? "stop",
        ...(input.error && { error: input.error }),
        time: { created: 8, completed: 9 },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: child.id,
        messageID: finalID,
        type: "text",
        text: report,
        time: { start: 8, end: 9 },
      })
      await Session.flushPendingParts(child.id)
      const before = await Session.messages({ sessionID: child.id })
      try {
        const task = await TaskTool.init()
        const ctx = {
          sessionID: parent.id,
          messageID,
          callID,
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
          extra: { effort: "normal", bypassAgentCheck: true },
        }
        const result = await task.execute(params, ctx)
        expect(await Session.messages({ sessionID: child.id })).toEqual(before)
        expect((await TaskAttempt.read(identity))?.previousMessageIDs).toEqual(previous)
        const repeated = await task.execute(params, ctx)
        expect(repeated).toEqual(result)
        expect(await Session.messages({ sessionID: child.id })).toEqual(before)
        return { result, tools }
      } finally {
        await Session.remove(child.id)
        await Session.remove(parent.id)
      }
    },
  })
}

test.each(["search_unavailable", "search_output_unavailable"])(
  "a completed handoff retains a closed %s attempt without pretending the operation is still pending",
  async (stopReason) => {
    const { result, tools } = await retained({ stopReason })
    expect(result.metadata).toMatchObject({
      outcome: "completed",
      stopReason: "completed",
      toolCalls: 2,
      failedToolCalls: 1,
      partialToolCalls: 0,
      handoff: report,
      handoffTruncated: false,
    })
    expect(result.output).toContain("1 failed tool attempt")
    expect(result.output).toContain(report)
    expect(result.output).not.toContain("remain partial or unsettled")
    expect(result.metadata.summary).toEqual([
      { id: tools[0].id, tool: "research_search", state: { status: "error", title: "Research search unavailable" } },
      { id: tools[1].id, tool: "science_fetch", state: { status: "completed", title: "Fetched primary source" } },
    ])
  },
)

test("a genuinely pending operation still makes a normal-stop child handoff partial", async () => {
  const { result } = await retained({ stopReason: "operation_pending" })
  expect(result.metadata).toMatchObject({
    outcome: "partial",
    stopReason: "tool_partial",
    partialToolCalls: 1,
    handoff: report,
  })
  expect(result.output).toContain("remain partial or unsettled")
})

test("step limits remain authoritative even when a child emitted usable text", async () => {
  const { result } = await retained({ finish: "max-steps" })
  expect(result.metadata).toMatchObject({ outcome: "partial", stopReason: "max_steps", handoff: report })
})

test("provider failures preserve partial handoff text without claiming normal completion", async () => {
  const { result } = await retained({ error: { name: "UnknownError", data: { message: "Provider disconnected" } } })
  expect(result.metadata).toMatchObject({ outcome: "partial", stopReason: "provider_error", handoff: report })
})

test("recovering a first child turn preserves its empty baseline and final handoff", async () => {
  const { result } = await retained({ emptyBaseline: true })
  expect(result.metadata).toMatchObject({ handoff: report, outcome: "completed", failedToolCalls: 1 })
})
