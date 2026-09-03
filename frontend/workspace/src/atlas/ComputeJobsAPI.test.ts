import { describe, expect, test } from "bun:test"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { createComputeJobsAPI, serial, stableJobs, type Job } from "./ComputeJobsAPI"

const apiSource = await Bun.file(new URL("./ComputeJobsAPI.ts", import.meta.url)).text()

describe("compute jobs API", () => {
  test("preserves unchanged job identities during stream polling", () => {
    const job: Job = {
      id: "job_1",
      name: "analysis",
      command: "python analysis.py",
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "running",
      created_at: "2026-08-05T09:00:00.000Z",
    }
    const previous = [job]
    const unchanged = stableJobs(previous, [structuredClone(job)])
    const finished = stableJobs(previous, [{ ...job, status: "succeeded" }])

    expect(unchanged).toBe(previous)
    expect(unchanged[0]).toBe(job)
    expect(finished).not.toBe(previous)
    expect(finished[0]).not.toBe(job)
  })

  test("coalesces a busy stream read into one final read", async () => {
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    const streams = serial(async (id: string) => {
      calls.push(id)
      if (calls.length === 1) await gate.promise
    })

    const first = streams("running")
    await Promise.resolve()
    await streams("terminal")
    await streams("terminal")
    gate.resolve()
    await first

    expect(calls).toEqual(["running", "terminal"])
  })

  test("binds every job operation to the active opaque project capability", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const bodies = [
      [],
      { id: "job_1" },
      { log: "ok\n" },
      { events: "sandbox ready\n" },
      { id: "job_1" },
      { id: "job_1" },
      { cleared: 1 },
    ]
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init })
      return Response.json(bodies[calls.length - 1])
    }) as typeof fetch
    const request = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "/work/alpha",
      fetch: () => fetcher,
    })
    const api = createComputeJobsAPI(request)

    await api.list()
    await api.start({
      sessionID: "ses_alpha",
      name: "analysis",
      command: "bun run analysis.ts",
      target: { kind: "local" },
    })
    await api.log("job_1")
    await api.events("job_1")
    await api.retry("job_1")
    await api.cancel("job_1")
    await api.clear()

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url.pathname}`)).toEqual([
      "GET /settings/compute/jobs",
      "POST /settings/compute/jobs",
      "GET /settings/compute/jobs/job_1/log",
      "GET /settings/compute/jobs/job_1/events",
      "POST /settings/compute/jobs/job_1/retry",
      "POST /settings/compute/jobs/job_1/cancel",
      "DELETE /settings/compute/jobs/completed",
    ])
    for (const call of [calls[0], calls[2], calls[3]]) expect(call?.init?.cache).toBe("no-store")
    for (const call of calls) {
      expect(call.url.searchParams.get("directory")).toBeNull()
      const headers = new Headers(call.init?.headers)
      expect(headers.get("x-openscience-project")).toBe("prj_alpha")
      expect(headers.get("x-openscience-directory")).toBe("/work/alpha")
    }
  })

  test("preserves the real job, output, and lifecycle API paths", () => {
    expect(apiSource).toContain('call<Job[]>("", { cache: "no-store" })')
    expect(apiSource).toContain('call<Job>("", { method: "POST"')
    expect(apiSource).toContain("call<Job>(`/${id}/retry`")
    expect(apiSource).toContain("call<Job>(`/${id}/cancel`")
    expect(apiSource).toContain("call<Job>(`/${id}/release`")
    expect(apiSource).toContain("`/${id}/log`")
    expect(apiSource).toContain("`/${id}/events`")
    expect(apiSource).toContain("if (state.active)")
  })
})
