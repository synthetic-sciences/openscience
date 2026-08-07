import { describe, expect, test } from "bun:test"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { createComputeJobsAPI, serial, stableJobs, type Job } from "./ComputeJobsAPI"

const source = await Bun.file(new URL("./ComputeJobs.tsx", import.meta.url)).text()
const apiSource = await Bun.file(new URL("./ComputeJobsAPI.ts", import.meta.url)).text()

describe("compute jobs surface", () => {
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

  test("nests collapsible details beneath each run", () => {
    const runs = source.indexOf("<For each={jobs()}>")
    const details = source.indexOf("id={`compute-run-${item.id}`}")

    expect(runs).toBeGreaterThan(-1)
    expect(details).toBeGreaterThan(runs)
    expect(source).toContain("aria-expanded={selected() === item.id}")
    expect(source).toContain("value === item.id ? undefined : item.id")
    expect(source).toContain("<IconChevronDown")
    expect(source).toContain("<IconChevronRight")
    expect(source).not.toContain('"max-height": "216px"')
    expect(source.slice(details, source.indexOf("style={commandBox}", details))).not.toContain("{job().name}")
  })

  test("keeps header and empty-state copy user-facing and transport-neutral", () => {
    expect(source).toContain(">Research jobs</span>")
    expect(source).toContain("Runs stay with this project")
    expect(source).toContain("No jobs in this project")
    expect(source).toContain("Ask an OpenScience agent to run an experiment.")
    expect(source).not.toContain("local · SSH · schedulers")
    expect(source).not.toContain("Run a script locally or send it to an SSH, Slurm, or PBS machine.")
  })

  test("gives the creation form exclusive ownership of the jobs content area", () => {
    const form = source.indexOf("<Show when={props.manual && creating()}>")
    const guard = source.indexOf("<Show when={!creating() || !props.manual}>")
    const empty = source.indexOf("No jobs in this project")

    expect(form).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(form)
    expect(empty).toBeGreaterThan(guard)
  })

  test("keeps manual job authoring behind an explicit opt-in", () => {
    expect(source).toContain("manual?: boolean")
    expect(source).toContain("<Show when={props.manual}>")
  })

  test("preserves the real job, output, capture, and provenance API paths", () => {
    expect(source).toContain("createComputeJobsAPI(sdk.request)")
    expect(source).not.toContain("directory=${encodeURIComponent(sdk.directory)}")
    expect(apiSource).toContain('call<Job[]>("", { cache: "no-store" })')
    expect(apiSource).toContain('call<Job>("", { method: "POST"')
    expect(apiSource).toContain("call<Job>(`/${id}/retry`")
    expect(apiSource).toContain("call<Job>(`/${id}/cancel`")
    expect(apiSource).toContain("`/${id}/log`")
    expect(apiSource).toContain("`/${id}/events`")
    expect(source).toContain("job().artifacts")
    expect(source).toContain("job().checkpoint")
    expect(source).toContain("job().reproducibility")
    expect(source).toContain("job().capture_error")
    expect(source).toContain("job().cleanup_error")
  })

  test("shows Modal lifecycle logs above command output", () => {
    const logs = source.indexOf('data-testid="modal-logs"')
    const output = source.indexOf("<span>Output</span>")

    expect(logs).toBeGreaterThan(-1)
    expect(output).toBeGreaterThan(logs)
    expect(source).toContain("No Modal lifecycle logs were captured.")
    expect(source).toContain("Waiting for Modal…")
    expect(source).toContain('job().status === "cancelled"')
    expect(source).toContain('"Run cancelled."')
    expect(source).not.toContain('events.loading ? "Syncing…"')
    expect(source).not.toContain('output.loading ? "Syncing…"')
  })

  test("does not drop the final streams when a job becomes terminal", () => {
    expect(source).toContain("const streams = serial(")
    expect(source).toContain("const status = current()?.status")
    expect(source).toContain("terminal.has(status)")
  })

  test("uses backend authority and an exact approval plan for Modal dispatch", () => {
    expect(source).toContain('target() === "modal" ? "remote_job" : "local_job"')
    expect(source).toContain('target: { kind: "modal" }')
    expect(source).toContain('approval: target() === "modal" ? plan()?.digest')
    expect(source).toContain(".plan({")
    expect(source).toContain('data-testid="modal-plan"')
    expect(source).toContain("!authority.allowed()")
    expect(source).toContain('title="Cancel job"')
    expect(source).toContain("api.cancel(job.id)")
    expect(source).toContain("api.retry(job.id)")
    expect(source).toContain("Retry delivery")
    expect(source).toContain('job().target.kind !== "ssh"')
    expect(source).toContain("Remote dispatch is unavailable")
    expect(source).toContain("none (CPU only), T4, L4, A10G, A100, H100")
  })

  test("reveals dispatch only after the current command is reviewed", () => {
    const review = source.indexOf("<Show when={!approved()}>")
    const gate = source.indexOf("<Show when={approved()}>", review)
    const dispatch = source.indexOf('{busy() ? "Dispatching…" : "Dispatch"}', gate)

    expect(review).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(review)
    expect(dispatch).toBeGreaterThan(gate)
  })

  test("discovers external jobs without resource-driven background flicker", () => {
    const interval = source.slice(source.indexOf("setInterval"), source.indexOf("onCleanup(() => clearInterval"))

    expect(source).toContain("props.onEnsureSession?.()")
    expect(source).toContain("const sessionID = await ensureSession()")
    expect(source).toContain("setInterval")
    expect(source).not.toContain("if (active() === 0) return")
    expect(source).not.toContain("createResource(selected")
    expect(interval).not.toContain("jobsApi.refetch")
    expect(interval).not.toContain("outputApi.refetch")
    expect(interval).not.toContain("eventsApi.refetch")
    expect(interval).toContain("void refresh()")
    expect(interval).toContain("void streams")
    expect(apiSource).toContain("if (state.active)")
    expect(source).toContain(".finally(() =>")
    expect(source).not.toContain("Save the session before starting")
  })
})
