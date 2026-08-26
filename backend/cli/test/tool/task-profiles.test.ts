import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import {
  assertTaskContinuation,
  childPermissionRules,
  classifyTaskOutcome,
  summarizeTurn,
  taskHandoff,
  taskText,
  TaskTool,
  taskContinuationID,
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

test("child sessions preserve the active Task permission for nested independent work", () => {
  const configuredProfile = [{ permission: "task", pattern: "*", action: "allow" as const }]
  const child = childPermissionRules()

  expect(PermissionNext.evaluate("task", "explore", configuredProfile, child).action).toBe("allow")
  expect(PermissionNext.disabled(["task"], child)).not.toContain("task")
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
  expect(source).not.toContain("delegation: false")
  expect(source).toContain("task: true")
  expect(source).toContain('TaskCapacity.acquire("child", MAX_CHILD_AGENTS')
})

test("Task outcomes distinguish bounded partial work from completion and failure", () => {
  expect(classifyTaskOutcome({ finish: "stop" })).toEqual({
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
  expect(classifyTaskOutcome({ finish: "stop", toolCalls: 5, failedToolCalls: 4 })).toEqual({
    outcome: "completed",
    stopReason: "completed",
  })
})
