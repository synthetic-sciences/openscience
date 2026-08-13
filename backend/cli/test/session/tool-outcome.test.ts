import { expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { observableToolFailure, observableToolStatus } from "../../src/session/tool-outcome"

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
