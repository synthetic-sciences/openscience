import { describe, expect, test } from "bun:test"
import { createExecutionHistoryAPI, recentExecutions, type Captured, type ExecutionRecord } from "./ExecutionHistoryAPI"

const available = <T>(value: T): Captured<T> => ({ status: "available", value })

const execution = (id: string, sequence: number, completed: string): ExecutionRecord => ({
  id,
  session_id: "ses_current",
  sequence,
  status: "succeeded",
  language: "python",
  code: available("print('done')"),
  environment: {
    name: available("Python 3.12"),
    interpreter: available({ name: "Python", binary: "/usr/bin/python3", version: available("3.12") }),
    kernel_id: available("runtime-1"),
    incarnation: available(1),
    restart_boundary: false,
  },
  timing: {
    created_at: available(completed),
    started_at: available(completed),
    completed_at: available(completed),
    duration_ms: available(200),
  },
  result: { summary: "Analysis complete", stdout: "done", stderr: "", error: "", output_count: 1 },
  resources: available({ memory_bytes: 12_000_000 }),
  files: [],
  artifacts: [],
  provenance_id: `prov-${id}`,
})

describe("execution history API", () => {
  test("requests the session-scoped provenance history without waiting for SDK generation", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const api = createExecutionHistoryAPI(async (path, init) => {
      calls.push({ path, init })
      return Response.json([execution("run-1", 1, "2026-08-12T10:00:00.000Z")])
    })

    const runs = await api.list("ses current/1")

    expect(runs).toHaveLength(1)
    expect(calls[0]?.path).toBe("/provenance/executions?sessionID=ses+current%2F1")
    expect(calls[0]?.init?.cache).toBe("no-store")
  })

  test("treats the pre-history provenance route shadow as an empty optional history", async () => {
    let requests = 0
    const api = createExecutionHistoryAPI(async () => {
      requests += 1
      return Response.json({ error: "Provenance node not found" }, { status: 404 })
    })

    expect(await api.list("ses_legacy")).toEqual([])
    expect(await api.list("ses_legacy")).toEqual([])
    expect(requests).toBe(1)
  })

  test("keeps real history failures visible", async () => {
    const unavailable = createExecutionHistoryAPI(async () =>
      Response.json({ error: "History store unavailable" }, { status: 503 }),
    )
    const unrelatedMiss = createExecutionHistoryAPI(async () =>
      Response.json({ error: "Project not found" }, { status: 404 }),
    )
    const offline = createExecutionHistoryAPI(async () => {
      throw new Error("connection reset")
    })

    expect(unavailable.list("ses_current")).rejects.toThrow('{"error":"History store unavailable"}')
    expect(unrelatedMiss.list("ses_current")).rejects.toThrow('{"error":"Project not found"}')
    expect(offline.list("ses_current")).rejects.toThrow("connection reset")
  })

  test("keeps a bounded newest-first result list", () => {
    const oldest = execution("old", 1, "2026-08-12T09:00:00.000Z")
    const newest = execution("new", 3, "2026-08-12T11:00:00.000Z")
    const middle = execution("middle", 2, "2026-08-12T10:00:00.000Z")

    expect(recentExecutions([oldest, newest, middle], 2).map((run) => run.id)).toEqual(["new", "middle"])
  })
})
