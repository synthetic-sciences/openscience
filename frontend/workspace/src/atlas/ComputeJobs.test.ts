import { describe, expect, test } from "bun:test"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { createComputeJobsAPI } from "./ComputeJobsAPI"

const source = await Bun.file(new URL("./ComputeJobs.tsx", import.meta.url)).text()
const apiSource = await Bun.file(new URL("./ComputeJobsAPI.ts", import.meta.url)).text()

describe("compute jobs surface", () => {
  test("binds every job operation to the active opaque project capability", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const bodies = [[], { id: "job_1" }, { log: "ok\n" }, { id: "job_1" }, { cleared: 1 }]
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
    await api.cancel("job_1")
    await api.clear()

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url.pathname}`)).toEqual([
      "GET /settings/compute/jobs",
      "POST /settings/compute/jobs",
      "GET /settings/compute/jobs/job_1/log",
      "POST /settings/compute/jobs/job_1/cancel",
      "DELETE /settings/compute/jobs/completed",
    ])
    for (const call of calls) {
      expect(call.url.searchParams.get("directory")).toBeNull()
      const headers = new Headers(call.init?.headers)
      expect(headers.get("x-openscience-project")).toBe("prj_alpha")
      expect(headers.get("x-openscience-directory")).toBe("/work/alpha")
    }
  })

  test("uses compact headers, rows, and cards", () => {
    expect(source).toContain('class="compute-jobs"')
    expect(source).toContain('"font-size": "15px"')
    expect(source).toContain('"min-height": "44px"')
    expect(source).toContain('width: "32px"')
    expect(source).toContain('"border-radius": "12px"')
    expect(source).toContain('"box-shadow": "none"')
    expect(source).not.toContain('"min-height": "68px"')
    expect(source).not.toMatch(/"border-radius": "(?:18|20)px"/)
  })

  test("keeps header and empty-state copy user-facing and transport-neutral", () => {
    expect(source).toContain(">Research jobs</span>")
    expect(source).toContain("Runs stay with this project")
    expect(source).toContain("No jobs in this project")
    expect(source).toContain("Run a command and keep its output, captured files, and reproducibility record together.")
    expect(source).not.toContain("local · SSH · schedulers")
    expect(source).not.toContain("Run a script locally or send it to an SSH, Slurm, or PBS machine.")
  })

  test("gives the creation form exclusive ownership of the jobs content area", () => {
    const form = source.indexOf("<Show when={creating()}>")
    const guard = source.indexOf("<Show when={!creating()}>")
    const empty = source.indexOf("No jobs in this project")

    expect(form).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(form)
    expect(empty).toBeGreaterThan(guard)
  })

  test("preserves the real job, output, capture, and provenance API paths", () => {
    expect(source).toContain("createComputeJobsAPI(sdk.request)")
    expect(source).not.toContain("directory=${encodeURIComponent(sdk.directory)}")
    expect(apiSource).toContain('call<Job[]>("")')
    expect(apiSource).toContain('call<Job>("", { method: "POST"')
    expect(apiSource).toContain("call<Job>(`/${id}/cancel`")
    expect(apiSource).toContain("`/${id}/log`")
    expect(source).toContain("job().artifacts")
    expect(source).toContain("job().checkpoint")
    expect(source).toContain("job().reproducibility")
    expect(source).toContain("job().capture_error")
  })

  test("uses backend authority for local dispatch and leaves remote history read-only", () => {
    expect(source).toContain('useExecutionAuthority("local_job")')
    expect(source).not.toContain('"remote_job"')
    expect(source).toContain('target: { kind: "local" }')
    expect(source).toContain("!authority.allowed()")
    expect(source).toContain('title="Cancel job"')
    expect(source).toContain("api.cancel(job.id)")
    expect(source).toContain('job().target.kind === "local"')
    expect(source).toContain("Remote dispatch is unavailable")
  })

  test("materializes a new session before opening or dispatching a job and polls only while active", () => {
    expect(source).toContain("props.onEnsureSession?.()")
    expect(source).toContain("const sessionID = await ensureSession()")
    expect(source).toContain("if (active() === 0) return")
    expect(source).toContain("setInterval")
    expect(source).not.toContain("Save the session before starting")
  })
})
