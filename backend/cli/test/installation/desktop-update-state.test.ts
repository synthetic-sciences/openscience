import { expect, test } from "bun:test"
import { startupUpdateState } from "../../../../frontend/desktop/src/update-state.mjs"

const previous = { status: "succeeded", version: "2.0.75", completed_at: "2026-09-06T10:00:00Z" }

test("a supervised launch supersedes an earlier success until its own health is proved", () => {
  expect(startupUpdateState(previous, "2.0.76", "2.0.76")).toEqual({ phase: "restarting", version: "2.0.76" })
  expect(startupUpdateState(undefined, "2.0.76", "2.0.76")).toEqual({ phase: "restarting", version: "2.0.76" })
})

test("does not claim a different installed version succeeded after a manual upgrade or rollback", () => {
  expect(startupUpdateState(previous, "2.0.76")).toBeUndefined()
  expect(startupUpdateState(previous, "2.0.74")).toBeUndefined()
  expect(startupUpdateState(previous, "2.0.75")).toEqual({
    phase: "succeeded",
    version: "2.0.75",
    completed_at: previous.completed_at,
    error: undefined,
  })
})

test("preserves a failed update result while the previous healthy version is running", () => {
  expect(startupUpdateState({ ...previous, status: "failed", error: "Health check failed" }, "2.0.74")).toEqual({
    phase: "failed",
    version: "2.0.75",
    completed_at: previous.completed_at,
    error: "Health check failed",
  })
})

test("ignores malformed persisted results", () => {
  for (const value of [undefined, {}, { ...previous, version: "latest" }, { ...previous, completed_at: "invalid" }]) {
    expect(startupUpdateState(value, "2.0.75")).toBeUndefined()
  }
})
