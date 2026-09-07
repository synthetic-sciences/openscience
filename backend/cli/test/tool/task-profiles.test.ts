import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import {
  assertLeadDelegationSession,
  assertTaskContinuation,
  childPermissionRules,
  classifyTaskContinuation,
  classifyTaskOutcome,
  normalizeTaskAttemptInput,
  resolveTaskContinuation,
  summarizeTurn,
  taskHandoff,
  taskText,
  TaskContinuationError,
  TaskTool,
  taskContinuationID,
} from "../../src/tool/task"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"
import { MessageV2 } from "../../src/session/message-v2"
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

test("child sessions deny nested delegation and user questions", () => {
  const configuredProfile = [{ permission: "task", pattern: "*", action: "allow" as const }]
  const child = childPermissionRules()

  expect(PermissionNext.evaluate("task", "explore", configuredProfile, child).action).toBe("deny")
  expect(PermissionNext.evaluate("question", "*", child).action).toBe("deny")
  expect(PermissionNext.disabled(["task", "question"], child)).toEqual(new Set(["task", "question"]))
})

test("only a lead session may dispatch Task workers", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const lead = await Session.create({})
      const child = await Session.create({ parentID: lead.id })

      expect(assertLeadDelegationSession(lead)).toBe(lead)
      expect(() => assertLeadDelegationSession(child)).toThrow("Only the lead Research session")
    },
  })
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

type HandoffPart = { id: string; text: string; ignored?: boolean } | { id: string; tool: true }

function handoffMessage(id: string, created: number, parts: HandoffPart[]): MessageV2.WithParts {
  return {
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
    parts: parts.map((part) =>
      "tool" in part
        ? {
            id: part.id,
            sessionID: "ses_child",
            messageID: id,
            type: "tool" as const,
            tool: "read",
            callID: `call_${part.id}`,
            state: {
              status: "completed" as const,
              input: {},
              output: "fixture",
              title: "read",
              metadata: {},
              time: { start: created, end: created + 1 },
            },
          }
        : {
            id: part.id,
            sessionID: "ses_child",
            messageID: id,
            type: "text" as const,
            text: part.text,
            ignored: part.ignored,
          },
    ),
  }
}

test("Task handoffs return the child's final answer, written after its last tool call", () => {
  const messages = [
    handoffMessage("msg_final", 30, [
      { id: "prt_plan", text: "Let me verify the result first." },
      { id: "prt_verify", tool: true },
      { id: "prt_hidden", text: "internal bookkeeping", ignored: true },
      { id: "prt_findings", text: "## Findings\n- verified result 0.913" },
      { id: "prt_empty", text: "   " },
      { id: "prt_next", text: "## Next action\n- apply the patch" },
    ]),
    handoffMessage("msg_earlier", 10, [
      { id: "prt_a_opening", text: "opening evidence" },
      { id: "prt_b_detail", text: "supporting detail" },
    ]),
    handoffMessage("msg_historical", 1, [{ id: "prt_old", text: "old result" }]),
  ]

  expect(taskText(messages, new Set(["msg_historical"]))).toBe(
    "## Findings\n- verified result 0.913\n\n## Next action\n- apply the patch",
  )
})

test("Task handoffs fall back to the last message that said anything", () => {
  const trailing = handoffMessage("msg_tool_only", 30, [{ id: "prt_last_tool", tool: true }])
  const spoke = handoffMessage("msg_spoke", 20, [
    { id: "prt_note", text: "partial note before a final check" },
    { id: "prt_check", tool: true },
  ])
  expect(taskText([trailing, spoke], new Set())).toBe("partial note before a final check")
  expect(taskText([trailing], new Set())).toBe("")
  expect(taskText([spoke, trailing], new Set(["msg_spoke"]))).toBe("")
})

test("Task handoffs preserve the complete child result by default", () => {
  const opening = "## Findings\n- exact result: 0.913 at /tmp/result.json\n"
  const middle = "x".repeat(14_000)
  const closing = "\n## Next action\n- apply the verified patch"
  const result = taskHandoff(opening + middle + closing + '\n<task_metadata>{"private":true}</task_metadata>')

  expect(result.truncated).toBe(false)
  expect(result.text).toStartWith("## Findings")
  expect(result.text).toEndWith("- apply the verified patch")
  expect(result.text).toContain(middle)
  expect(result.text).not.toContain("private")
})

test("Task handoffs honor very small defensive limits", () => {
  const result = taskHandoff("a result that exceeds the requested cap", 8)

  expect(result).toEqual({ text: "a result", truncated: true })
})

test("Task runtime has no per-turn dispatch quota or default deadline", async () => {
  const source = await Bun.file(new URL("../../src/tool/task.ts", import.meta.url)).text()
  expect(source).not.toContain("taskDispatchBudget")
  expect(source).not.toContain("TASK_WALL_CLOCK_MS")
  expect(source).not.toContain("withTaskDeadline")
  expect(source).toContain("delegation: false")
  expect(source).toContain("task: false")
  expect(source).toContain("assertLeadDelegationSession")
  expect(source).toContain('TaskCapacity.acquire("child", MAX_CHILD_AGENTS')
})

test("Task outcomes distinguish bounded partial work from completion and failure", () => {
  expect(classifyTaskOutcome({ finish: "stop", hasText: true })).toEqual({
    outcome: "completed",
    stopReason: "completed",
  })
  expect(classifyTaskOutcome({ finish: "max-steps" })).toEqual({
    outcome: "partial",
    stopReason: "max_steps",
  })
  expect(classifyTaskOutcome({ error: { name: "UnknownError" } })).toEqual({
    outcome: "error",
    stopReason: "provider_error",
  })
  expect(classifyTaskOutcome({ error: { name: "UnknownError" }, hasText: true })).toEqual({
    outcome: "partial",
    stopReason: "provider_error",
  })
  expect(classifyTaskOutcome({ finish: "stop", toolCalls: 5, failedToolCalls: 5 })).toEqual({
    outcome: "partial",
    stopReason: "tool_failures",
  })
  expect(classifyTaskOutcome({ finish: "stop", hasText: true, toolCalls: 5, failedToolCalls: 4 })).toEqual({
    outcome: "completed",
    stopReason: "completed",
  })
  expect(classifyTaskOutcome({ finish: "stop" })).toEqual({
    outcome: "error",
    stopReason: "empty_handoff",
  })
  expect(classifyTaskOutcome({ finish: "stop", toolCalls: 1, partialToolCalls: 1 })).toEqual({
    outcome: "partial",
    stopReason: "tool_partial",
  })
})

test("Task preserves byte-exact long assignments and rejects internal compaction markers", () => {
  const prompt = `Collect these exact identifiers and destinations without guessing:\n${"🧬ßλ".repeat(1_000)}`
  const normalized = normalizeTaskAttemptInput(
    { description: "Collect exact papers", prompt, subagent_type: "explore" },
    "ses_parent",
  )
  expect(normalized.prompt).toBe(prompt)
  expect(() =>
    normalizeTaskAttemptInput(
      {
        description: "Collect exact papers",
        prompt: `${prompt.slice(0, 200)}…[+1712 chars]`,
        subagent_type: "explore",
      },
      "ses_parent",
    ),
  ).toThrow("No child was started")
})

test("Task classifies every placeholder, empty and self-referential session id as a new child", () => {
  const parent = "ses_parent_real"
  for (const value of [
    undefined,
    null,
    "",
    "   ",
    parent,
    "ses_new",
    "ses_NONE",
    "ses_null",
    "ses_undefined",
    "ses_placeholder",
    "ses_current",
    "ses_parent",
  ]) {
    expect(classifyTaskContinuation(value, parent)).toEqual({ kind: "new" })
  }
  expect(classifyTaskContinuation(" ses_child_real ", parent)).toEqual({
    kind: "continue",
    sessionID: "ses_child_real",
  })
  expect(classifyTaskContinuation("ses_", parent)).toEqual({ kind: "continue", sessionID: "ses_" })
  expect(classifyTaskContinuation(`${parent}_code`, parent)).toEqual({ kind: "continue", sessionID: `${parent}_code` })
})

test("Task continuation resolves only a direct child and explains recovery for invented, bare or foreign ids", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const ownChild = await Session.create({ parentID: parent.id, title: "literature sweep" })
      const siblingParent = await Session.create({})
      const foreignChild = await Session.create({ parentID: siblingParent.id })
      const scope = { parentSession: parent, projectID: parent.projectID }

      expect((await resolveTaskContinuation({ requested: ownChild.id, ...scope }))?.id).toBe(ownChild.id)
      expect(await resolveTaskContinuation({ requested: undefined, ...scope })).toBeUndefined()
      expect(await resolveTaskContinuation({ requested: "ses_new", ...scope })).toBeUndefined()
      expect(await resolveTaskContinuation({ requested: parent.id, ...scope })).toBeUndefined()

      for (const requested of [
        "ses_",
        `${parent.id}_code`,
        `${parent.id}_eval`,
        foreignChild.id,
        "ses_stale_never_existed",
      ]) {
        const failure = await resolveTaskContinuation({ requested, ...scope }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(TaskContinuationError)
        const message = (failure as Error).message
        expect(message).toContain(`No child session ${requested} exists for this session`)
        expect(message).toContain("No child was started")
        expect(message).toContain("Omit session_id to start a new task")
        expect(message).toContain(`${ownChild.id} (literature sweep)`)
      }

      const orphan = await Session.create({})
      const none = await resolveTaskContinuation({
        requested: "ses_",
        parentSession: orphan,
        projectID: orphan.projectID,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect((none as Error).message).toContain("has started no child tasks to continue yet")
    },
  })
})

test("a compacted Task summary keeps the reusable child session id", () => {
  const state = {
    status: "completed" as const,
    input: { description: "literature sweep", prompt: "find papers" },
    output: "Task session ses_child_real: reuse this sessionId to continue the same worker.\nfindings",
    title: "literature sweep",
    metadata: { sessionId: "ses_child_real", handoff: "three relevant papers" },
    time: { start: 1, end: 2 },
  }
  const summary = MessageV2.toolSummary("task", state as any)
  expect(summary.startsWith("Task session ses_child_real: reuse this sessionId to continue the same worker.")).toBe(
    true,
  )
  expect(summary).toContain("three relevant papers")
  const cleared = MessageV2.toolSummary("task", { ...state, metadata: { sessionId: "ses_child_real" } } as any)
  expect(cleared.startsWith("Task session ses_child_real:")).toBe(true)
  expect(MessageV2.toolSummary("read", { ...state, metadata: {} } as any).startsWith("Task session")).toBe(false)
})
