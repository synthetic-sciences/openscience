import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import {
  assertTaskContinuation,
  childPermissionRules,
  classifyTaskOutcome,
  summarizeTurn,
  taskHandoff,
  taskDispatchBudget,
  taskText,
  TASK_HANDOFF_CHARS,
  TASK_WALL_CLOCK_MS,
  TaskTool,
  taskContinuationID,
  withTaskDeadline,
} from "../../src/tool/task"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"
import type { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"

test("Task advertises generic phases and accepts an explicit domain specialist lens", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = await Agent.get("research")
      const task = await TaskTool.init({ agent: research })

      expect(task.description).toContain("- explore:")
      expect(task.description).toContain("- execute:")
      expect(task.description).not.toContain("- review:")
      expect(task.description).not.toContain("- biology:")
      expect(task.description).not.toContain("- physics:")
      expect(task.description).not.toContain("- literature-review:")

      expect(
        task.parameters.safeParse({
          description: "Inspect biology evidence",
          prompt: "Check the supplied assay results.",
          subagent_type: "execute",
          specialist: "biology",
        }).success,
      ).toBe(true)
      expect(
        task.parameters.safeParse({
          description: "Invalid phase",
          prompt: "Check the supplied assay results.",
          subagent_type: "biology",
        }).success,
      ).toBe(false)
      expect(
        task.parameters.safeParse({
          description: "Invalid continuation",
          prompt: "Continue the earlier inspection.",
          subagent_type: "explore",
          session_id: "current-session",
        }).success,
      ).toBe(false)
      expect(await Agent.get("biology")).toBeDefined()
      expect(await Agent.get("reviewer")).toBeUndefined()
      expect(await Agent.get("plan")).toBeDefined()
    },
  })
})

test("child sessions deny recursive delegation even when a profile allows Task", () => {
  const configuredProfile = [{ permission: "task", pattern: "*", action: "allow" as const }]
  const child = childPermissionRules()

  expect(PermissionNext.evaluate("task", "explore", configuredProfile, child).action).toBe("deny")
  expect(PermissionNext.disabled(["task"], child)).toContain("task")
})

test("Task treats provider placeholder session IDs as a new child", () => {
  const parent = "ses_parent_real"
  expect(taskContinuationID(undefined, parent)).toBeUndefined()
  expect(taskContinuationID(parent, parent)).toBeUndefined()
  expect(taskContinuationID("ses_placeholder", parent)).toBeUndefined()
  expect(taskContinuationID("ses_current", parent)).toBeUndefined()
  expect(taskContinuationID("ses_child_real", parent)).toBe("ses_child_real")
})

test("Task continuation accepts only a direct child of the calling session", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const ownChild = await Session.create({ parentID: parent.id })
      const siblingParent = await Session.create({})
      const siblingChild = await Session.create({ parentID: siblingParent.id })
      const scope = { parentSessionID: parent.id, projectID: parent.projectID }

      expect(assertTaskContinuation({ session: ownChild, ...scope })).toBe(ownChild)
      expect(() => assertTaskContinuation({ session: parent, ...scope })).toThrow("not a direct child")
      expect(() => assertTaskContinuation({ session: siblingChild, ...scope })).toThrow("not a direct child")
    },
  })
})

test("continued Tasks report only the current child turn", () => {
  const message = (input: { id: string; parent: string; tool: string; tokens: number }): MessageV2.WithParts => ({
    info: {
      id: input.id,
      sessionID: "ses_child",
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: input.parent,
      modelID: "model",
      providerID: "provider",
      mode: "execute",
      agent: "execute",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: input.tokens / 100,
      tokens: {
        input: input.tokens,
        output: input.tokens + 1,
        reasoning: 0,
        cache: { read: input.tokens + 2, write: input.tokens + 3 },
      },
    },
    parts: [
      {
        id: `prt_${input.id}`,
        sessionID: "ses_child",
        messageID: input.id,
        type: "tool",
        callID: `call_${input.id}`,
        tool: input.tool,
        state: {
          status: "completed",
          input: {},
          output: `${input.tool} result`,
          title: input.tool,
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  })
  const historical = message({ id: "msg_old_assistant", parent: "msg_old_user", tool: "webfetch", tokens: 100 })
  const current = message({ id: "msg_new_assistant", parent: "msg_new_user", tool: "read", tokens: 10 })
  const result = summarizeTurn([historical, current], new Set([historical.info.id]))

  expect(result.summary.map((part) => part.tool)).toEqual(["read"])
  expect(result.usage).toEqual({
    cost: 0.1,
    tokens: { input: 10, output: 11, cache: { read: 12, write: 13 } },
  })
})

test("Task summaries expose command and runtime failures carried in completed metadata", () => {
  const tool = (input: {
    id: string
    tool: string
    title: string
    metadata: Record<string, unknown>
  }): MessageV2.WithParts => ({
    info: {
      id: input.id,
      sessionID: "ses_child",
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg_user",
      modelID: "model",
      providerID: "provider",
      mode: "execute",
      agent: "execute",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `prt_${input.id}`,
        sessionID: "ses_child",
        messageID: input.id,
        type: "tool",
        callID: `call_${input.id}`,
        tool: input.tool,
        state: {
          status: "completed",
          input: {},
          output: "retained output",
          title: input.title,
          metadata: input.metadata,
          time: { start: 1, end: 2 },
        },
      },
    ],
  })

  const result = summarizeTurn(
    [
      tool({ id: "msg_bash", tool: "bash", title: "Fetch manifest", metadata: { exit: 6 } }),
      tool({ id: "msg_python", tool: "python", title: "Parse data (error)", metadata: { ok: false } }),
    ],
    new Set(),
  )

  expect(result.summary.map((part) => ({ tool: part.tool, status: part.state.status }))).toEqual([
    { tool: "bash", status: "error" },
    { tool: "python", status: "error" },
  ])
})

test("Task handoffs join every nonempty child text part in chronological order", () => {
  const message = (id: string, created: number, parts: Array<{ id: string; text: string }>): MessageV2.WithParts => ({
    info: {
      id,
      sessionID: "ses_child",
      role: "assistant",
      time: { created, completed: created + 1 },
      parentID: "msg_user",
      modelID: "model",
      providerID: "provider",
      mode: "execute",
      agent: "execute",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: parts.map((part) => ({
      ...part,
      sessionID: "ses_child",
      messageID: id,
      type: "text" as const,
    })),
  })
  const messages = [
    message("msg_later", 20, [
      { id: "prt_second", text: "second conclusion" },
      { id: "prt_empty", text: "   " },
    ]),
    message("msg_earlier", 10, [
      { id: "prt_a_opening", text: "opening evidence" },
      { id: "prt_b_detail", text: "supporting detail" },
    ]),
    message("msg_historical", 1, [{ id: "prt_old", text: "old result" }]),
  ]

  expect(taskText(messages, new Set(["msg_historical"]))).toBe(
    "opening evidence\n\nsupporting detail\n\nsecond conclusion",
  )
})

test("Task handoffs stay bounded while preserving findings and the final conclusion", () => {
  const opening = "## Findings\n- exact result: 0.913 at /tmp/result.json\n"
  const middle = "x".repeat(TASK_HANDOFF_CHARS + 2_000)
  const closing = "\n## Next action\n- apply the verified patch"
  const result = taskHandoff(opening + middle + closing + '\n<task_metadata>{"private":true}</task_metadata>')

  expect(result.truncated).toBe(true)
  expect(result.text.length).toBeLessThanOrEqual(TASK_HANDOFF_CHARS)
  expect(result.text).toStartWith("## Findings")
  expect(result.text).toEndWith("- apply the verified patch")
  expect(result.text).toContain("full result remains in the child session")
  expect(result.text).not.toContain("private")
})

test("Task handoffs honor very small defensive limits", () => {
  const result = taskHandoff("a result that exceeds the requested cap", 8)

  expect(result).toEqual({ text: "a result", truncated: true })
})

test("Task dispatch budget counts continuations across one parent user turn", () => {
  const message = (input: {
    id: string
    parent: string
    created: number
    calls: Array<{ id: string; callID: string; sessionID?: string; failed?: boolean }>
  }): MessageV2.WithParts => ({
    info: {
      id: input.id,
      sessionID: "ses_parent",
      role: "assistant",
      time: { created: input.created, completed: input.created + 1 },
      parentID: input.parent,
      modelID: "model",
      providerID: "provider",
      mode: "research",
      agent: "research",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: input.calls.map((call) => ({
      id: call.id,
      sessionID: "ses_parent",
      messageID: input.id,
      type: "tool" as const,
      callID: call.callID,
      tool: "task",
      state: call.failed
        ? {
            status: "error" as const,
            input: call.sessionID ? { session_id: call.sessionID } : {},
            error: "Invalid Task continuation handle",
            time: { start: input.created, end: input.created + 1 },
          }
        : {
            status: "running" as const,
            input: call.sessionID ? { session_id: call.sessionID } : {},
            time: { start: input.created },
          },
    })),
  })
  const user = (input: { id: string; created: number; carrier?: boolean }): MessageV2.WithParts => ({
    info: {
      id: input.id,
      sessionID: "ses_parent",
      role: "user",
      time: { created: input.created },
      agent: "research",
      model: { providerID: "provider", modelID: "model" },
      effort: "normal",
    },
    parts: input.carrier
      ? [
          {
            id: `prt_${input.id}`,
            sessionID: "ses_parent",
            messageID: input.id,
            type: "compaction",
            auto: true,
          },
        ]
      : [
          {
            id: `prt_${input.id}`,
            sessionID: "ses_parent",
            messageID: input.id,
            type: "text",
            text: "real user request",
          },
        ],
  })
  const messages = [
    user({ id: "msg_user", created: 0 }),
    message({
      id: "msg_first",
      parent: "msg_user",
      created: 1,
      calls: [
        { id: "prt_failed_001", callID: "call_failed_1", sessionID: "ses_parent", failed: true },
        { id: "prt_failed_002", callID: "call_failed_2", sessionID: "ses_parent", failed: true },
        { id: "prt_001", callID: "call_1" },
        { id: "prt_002", callID: "call_2", sessionID: "ses_child" },
      ],
    }),
    user({ id: "msg_compaction", created: 2, carrier: true }),
    message({
      id: "msg_second",
      parent: "msg_compaction",
      created: 3,
      calls: [
        { id: "prt_003", callID: "call_3" },
        { id: "prt_004", callID: "call_4" },
        { id: "prt_005", callID: "call_5" },
      ],
    }),
    user({ id: "msg_other_user", created: 4 }),
    message({
      id: "msg_other_turn",
      parent: "msg_other_user",
      created: 5,
      calls: [{ id: "prt_006", callID: "call_other" }],
    }),
  ]

  expect(taskDispatchBudget(messages, "msg_user", "call_1", "normal")).toEqual({ dispatch: 1, limit: 3 })
  expect(taskDispatchBudget(messages, "msg_user", "call_2", "normal")).toEqual({ dispatch: 2, limit: 3 })
  expect(taskDispatchBudget(messages, "msg_compaction", "call_3", "normal")).toEqual({ dispatch: 3, limit: 3 })
  expect(taskDispatchBudget(messages, "msg_compaction", "call_4", "ultra")).toEqual({ dispatch: 4, limit: 8 })
  expect(taskDispatchBudget(messages, "msg_compaction", "call_5", "ultra")).toEqual({ dispatch: 5, limit: 8 })
  expect(taskDispatchBudget(messages, "msg_other_user", "call_other", "normal")).toEqual({ dispatch: 1, limit: 3 })
})

test("Task deadlines preserve work that settles before the cutoff", async () => {
  expect(TASK_WALL_CLOCK_MS).toEqual({ normal: 600_000, ultra: 1_200_000 })
  const result = await withTaskDeadline(
    () => Promise.resolve("completed findings"),
    () => {},
    100,
  )

  expect(result).toEqual({ result: "completed findings", error: undefined, timedOut: false })
})

test("Task deadlines return even when stalled work ignores cancellation", async () => {
  const pending = Promise.withResolvers<string>()
  let cancelled = false
  const started = Date.now()
  const result = await withTaskDeadline(
    () => pending.promise,
    () => {
      cancelled = true
    },
    5,
  )

  expect(result).toEqual({ result: undefined, error: undefined, timedOut: true })
  expect(cancelled).toBe(true)
  expect(Date.now() - started).toBeLessThan(250)
})

test("Task outcomes distinguish bounded partial work from completion and failure", () => {
  expect(classifyTaskOutcome({ timedOut: false, finish: "stop" })).toEqual({
    outcome: "completed",
    stopReason: "completed",
  })
  expect(classifyTaskOutcome({ timedOut: false, finish: "max-steps" })).toEqual({
    outcome: "partial",
    stopReason: "max_steps",
  })
  expect(classifyTaskOutcome({ timedOut: true, finish: "stop" })).toEqual({
    outcome: "timed_out",
    stopReason: "wall_clock",
  })
  expect(classifyTaskOutcome({ timedOut: false, error: { name: "UnknownError" } })).toEqual({
    outcome: "error",
    stopReason: "provider_error",
  })
  expect(classifyTaskOutcome({ timedOut: false, error: { name: "UnknownError" }, hasText: true })).toEqual({
    outcome: "partial",
    stopReason: "provider_error",
  })
  expect(classifyTaskOutcome({ timedOut: false, finish: "stop", toolCalls: 5, failedToolCalls: 5 })).toEqual({
    outcome: "partial",
    stopReason: "tool_failures",
  })
  expect(classifyTaskOutcome({ timedOut: false, finish: "stop", toolCalls: 5, failedToolCalls: 4 })).toEqual({
    outcome: "completed",
    stopReason: "completed",
  })
})
