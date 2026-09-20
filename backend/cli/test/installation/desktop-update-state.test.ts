import { expect, test } from "bun:test"
import { acknowledgedStartupResult, startupUpdateState } from "../../../../frontend/desktop/src/update-state.mjs"

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

test("shows a succeeded result once and ignores it on every later launch", () => {
  const served = startupUpdateState(previous, "2.0.75")
  expect(served).toEqual({
    phase: "succeeded",
    version: "2.0.75",
    completed_at: previous.completed_at,
    error: undefined,
  })

  const acknowledged = acknowledgedStartupResult(previous, served)
  expect(acknowledged?.status).toBe("succeeded")
  expect(acknowledged?.version).toBe("2.0.75")
  expect(acknowledged?.completed_at).toBe(previous.completed_at)
  expect(Number.isFinite(Date.parse(acknowledged?.acknowledged_at ?? ""))).toBe(true)

  expect(startupUpdateState(acknowledged, "2.0.75")).toBeUndefined()
  expect(acknowledgedStartupResult(acknowledged, served)).toBeUndefined()
})

test("never replays a success the installer already saw a live launch report", () => {
  // The installer only writes `health` once the updated app reported itself
  // healthy from a running window, which is the launch that showed the notice.
  // Both the stamp and that older evidence must suppress the replay.
  expect(startupUpdateState({ ...previous, acknowledged_at: "2026-09-06T10:00:01Z" }, "2.0.75")).toBeUndefined()
  expect(startupUpdateState({ ...previous, health: { process_identity: { pid: 42 } } }, "2.0.75")).toBeUndefined()
  // A result recovered from an interrupted transaction was never shown live,
  // so it keeps its one showing.
  expect(startupUpdateState({ ...previous, recovered: true }, "2.0.75")?.phase).toBe("succeeded")
})

test("acknowledges nothing the launch did not serve as an installed update", () => {
  const failure = { ...previous, status: "failed", error: "Health check failed" }
  expect(acknowledgedStartupResult(failure, startupUpdateState(failure, "2.0.74"))).toBeUndefined()
  expect(startupUpdateState({ ...failure, acknowledged_at: "2026-09-06T11:00:00Z" }, "2.0.74")?.phase).toBe("failed")
  // A supervised launch reports its own restart, so the stored result stays untouched.
  expect(acknowledgedStartupResult(previous, startupUpdateState(previous, "2.0.75", "2.0.76"))).toBeUndefined()
  expect(acknowledgedStartupResult(undefined, { phase: "succeeded", version: "2.0.75" })).toBeUndefined()
})

test("ignores malformed persisted results", () => {
  for (const value of [undefined, {}, { ...previous, version: "latest" }, { ...previous, completed_at: "invalid" }]) {
    expect(startupUpdateState(value, "2.0.75")).toBeUndefined()
  }
})
