import { expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { CredentialRevocation } from "../../src/credentials/revocation"
import {
  abortedToolPart,
  interruptionReceipt,
  observableToolFailure,
  observableToolStatus,
} from "../../src/session/tool-outcome"

function completed(tool: string, metadata: Record<string, unknown>, title = `${tool} execution`): MessageV2.ToolPart {
  return {
    id: `part_${tool}`,
    sessionID: "ses_outcome",
    messageID: "msg_outcome",
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output: "retained transport output",
      title,
      metadata,
      time: { start: 1, end: 2 },
    },
  }
}

test("normalizes execution failures without mutating completed transport results", () => {
  const cases = [
    {
      part: completed("bash", { exit: 6 }, "Fetch manifest"),
      message: "Fetch manifest exited with code 6",
    },
    {
      part: completed("bash", { exit: null }, "Run interrupted command"),
      message: "Run interrupted command did not return a successful exit code",
    },
    {
      part: completed("python", { ok: false }, "Parse data (error)"),
      message: "Parse data reported failure",
    },
    {
      part: completed("notebook", { ok: false }, "Analyze cohort (error)"),
      message: "Analyze cohort reported failure",
    },
    {
      part: completed("r", { ok: false }, "Fit model (error)"),
      message: "Fit model reported failure",
    },
    {
      part: completed("rkernel", { ok: false }, "Summarize model (error)"),
      message: "Summarize model reported failure",
    },
  ]

  for (const item of cases) {
    const before = structuredClone(item.part)
    expect(observableToolStatus(item.part)).toBe("error")
    expect(observableToolFailure(item.part)).toBe(item.message)
    expect(item.part).toEqual(before)
    expect(item.part.state.status).toBe("completed")
    if (item.part.state.status !== "completed") throw new Error("Expected retained completed result")
    expect(item.part.state.output).toBe("retained transport output")
  }
})

test("leaves successful completed results and thrown tool errors truthful", () => {
  const success = completed("bash", { exit: 0 }, "List files")
  expect(observableToolStatus(success)).toBe("completed")
  expect(observableToolFailure(success)).toBeUndefined()

  const error: MessageV2.ToolPart = {
    id: "part_error",
    sessionID: "ses_outcome",
    messageID: "msg_outcome",
    type: "tool",
    callID: "call_error",
    tool: "webfetch",
    state: {
      status: "error",
      input: {},
      error: "404 Not Found",
      time: { start: 1, end: 2 },
    },
  }
  expect(observableToolStatus(error)).toBe("error")
  expect(observableToolFailure(error)).toBe("404 Not Found")
})

test("exposes bounded Task checkpoints as partial without mutating retained output", () => {
  const task = completed(
    "task",
    { outcome: "partial", stopReason: "max_steps", toolCalls: 16 },
    "Analyze one evidence branch",
  )
  const before = structuredClone(task)

  expect(observableToolStatus(task)).toBe("partial")
  expect(observableToolFailure(task)).toBeUndefined()
  expect(task).toEqual(before)
})

test("exposes unsettled managed search as partial instead of transport-completed", () => {
  const search = completed(
    "research_search",
    {
      outcome: "partial",
      stopReason: "operation_pending",
      operationId: "call_search",
      creditState: "pending",
    },
    "Managed search pending",
  )

  expect(observableToolStatus(search)).toBe("partial")
  expect(observableToolFailure(search)).toBeUndefined()
})

test("counts terminal Task failures while keeping partial checkpoints non-failing", () => {
  const timedOut = completed("task", { outcome: "timed_out" }, "Collect literature")
  const failed = completed("task", { outcome: "error" }, "Analyze cohort")
  const partial = completed("task", { outcome: "partial", stopReason: "max_steps" }, "Inspect evidence")

  expect(observableToolStatus(timedOut)).toBe("error")
  expect(observableToolFailure(timedOut)).toBe("Collect literature timed out")
  expect(observableToolStatus(failed)).toBe("error")
  expect(observableToolFailure(failed)).toBe("Analyze cohort failed")
  expect(observableToolStatus(partial)).toBe("partial")
  expect(observableToolFailure(partial)).toBeUndefined()
})

test("a call cancelled by a credential revocation records the cause, not a fake failure", () => {
  const pending: MessageV2.ToolPart = {
    id: "part_pending",
    sessionID: "ses_outcome",
    messageID: "msg_outcome",
    type: "tool",
    callID: "call_pending",
    tool: "bash",
    state: { status: "pending", input: {}, raw: "" },
  }
  const closed = abortedToolPart(pending, CredentialRevocation.EXPIRED, { now: 50 })
  if (closed.state.status !== "error") throw new Error("Expected the pending call to be closed")
  expect(closed.state.error).toBe(
    "Interrupted: synchronized workspace credentials expired before they could be renewed. The bash call had not started; no action was taken.",
  )
  expect(closed.state.metadata).toEqual({ cancelled: true, started: false })
  expect(closed.state.time).toEqual({ start: 50, end: 50 })
  expect(closed.state.input).toEqual({})
  expect(observableToolFailure(closed)).toStartWith(CredentialRevocation.EXPIRED)
  expect(observableToolFailure(closed)).not.toContain("failed")

  const running: MessageV2.ToolPart = {
    ...pending,
    id: "part_running",
    callID: "call_running",
    state: { status: "running", input: { command: "sleep 30" }, metadata: { output: "" }, time: { start: 10 } },
  }
  const stopped = abortedToolPart(running, CredentialRevocation.EXPIRED, { now: 40 })
  if (stopped.state.status !== "error") throw new Error("Expected the running call to be closed")
  expect(stopped.state.error).toBe(CredentialRevocation.EXPIRED)
  expect(stopped.state.metadata).toEqual({ output: "", cancelled: true, started: true })
  expect(stopped.state.time).toEqual({ start: 10, end: 40 })
  expect(stopped.state.input).toEqual({ command: "sleep 30" })

  const truncated = abortedToolPart(pending, "Model output was truncated; no action was taken.", { explain: false })
  if (truncated.state.status !== "error") throw new Error("Expected the truncated call to be closed")
  expect(truncated.state.error).toBe("Model output was truncated; no action was taken.")
})

test("an interrupted question says what happened to the decision instead of warning about side effects", () => {
  const question: MessageV2.ToolPart = {
    id: "part_question",
    sessionID: "ses_q",
    messageID: "msg_q",
    type: "tool",
    tool: "question",
    callID: "call_question",
    state: { status: "running", input: { questions: [] }, metadata: {}, time: { start: 10 } },
  }
  const shown = abortedToolPart(question, "Tool execution aborted", { now: 40 })
  if (shown.state.status !== "error") throw new Error("Expected the question to be closed")
  expect(shown.state.error).toBe(
    "Tool execution aborted. The question was shown but no answer arrived before the interruption: no option was chosen and nothing was recorded. Ask again if the decision is still open.",
  )
  expect(interruptionReceipt("question", false)).toBe("The question had not been shown; nothing was asked or recorded.")
  // A read that was cut off changed nothing; a command may have.
  expect(interruptionReceipt("read", true)).toBe("The read call only reads; nothing changed.")
  expect(interruptionReceipt("bash", true)).toBe(
    "Its side effects may have completed; inspect the current state before retrying.",
  )
  const read: MessageV2.ToolPart = { ...question, tool: "read", state: { ...question.state, input: { filePath: "a" } } }
  const cut = abortedToolPart(read, "Tool execution aborted", { now: 40 })
  if (cut.state.status !== "error") throw new Error("Expected the read to be closed")
  expect(cut.state.error).toBe("Tool execution aborted. The read call only reads; nothing changed.")
})
