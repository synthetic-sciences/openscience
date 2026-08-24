import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/RemoteJobCard.tsx") as Promise<typeof import("./RemoteJobCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const job = {
  id: "job_gpu",
  name: "Train survival model",
  command: "python train.py",
  target: { kind: "modal" as const },
  target_label: "Modal",
  scheduler: "none" as const,
  status: "succeeded" as const,
  created_at: "2026-08-08T10:00:00.000Z",
  started_at: "2026-08-08T10:00:01.000Z",
  completed_at: "2026-08-08T10:01:01.000Z",
  exit_code: 0,
  resources: { cpus: 4, gpus: 1, memory_gb: 16 },
  lifecycle: { execution: "succeeded", delivery: "complete", resource: "closed" as const, recoverable: false },
  modal: {
    app: "openscience",
    image: "python:3.12",
    gpu: "A100",
    network: "none" as const,
    timeout_minutes: 10,
    uploads: [],
    upload_bytes: 0,
    approval: "b".repeat(64),
    sdk: "1",
  },
}

test("finished jobs leave the live tracker", () => {
  expect(subject.jobLive(job)).toBe(false)
  expect(subject.visibleJobs([job])).toEqual([])
})

test("a live Modal job is passive but keeps billing and requested resources visible", () => {
  const running = {
    ...job,
    status: "running" as const,
    completed_at: undefined,
    lifecycle: { ...job.lifecycle, execution: "running", resource: "active" as const },
  }
  const host = mount(() => subject.RemoteJobCard({ job: running }))

  expect(subject.jobLive(running)).toBe(true)
  expect(subject.jobStatusLabel("interrupted")).toBe("Interrupted")
  expect(host.querySelector('.compute-row__kind [data-icon="cloud"]')).not.toBeNull()
  expect(host.textContent).toContain("Running")
  expect(host.textContent).toContain("Billing can continue")
  expect(host.textContent).toContain("10-minute timeout")
  expect(host.textContent).toContain("A100 · 4 CPU · 16 GB")
  expect(host.querySelector("button, details, summary, pre, code")).toBeNull()
})

test("a terminal Modal resource stays visible until cleanup is known", () => {
  const uncertain = {
    ...job,
    lifecycle: { ...job.lifecycle, resource: "unknown" as const },
  }
  const host = mount(() => subject.RemoteJobCard({ job: uncertain }))

  expect(subject.visibleJobs([job, uncertain]).map((item) => item.id)).toEqual(["job_gpu"])
  expect(host.textContent).toContain("Succeeded · remote cleanup pending")
})

test("terminal Modal output collection stays visible without a closed-resource billing warning", () => {
  const collecting = {
    ...job,
    id: "job_collecting",
    lifecycle: { ...job.lifecycle, delivery: "pending", resource: "closed" as const },
  }
  const host = mount(() => subject.RemoteJobCard({ job: collecting }))

  expect(subject.jobLive(collecting)).toBe(true)
  expect(subject.visibleJobs([collecting])).toEqual([collecting])
  expect(host.textContent).toContain("Succeeded · collecting output")
  expect(host.textContent).not.toContain("Billing can continue")
})

test("terminal SSH work stays visible while output is collecting or recoverable", () => {
  const collecting = {
    ...job,
    id: "job_collecting",
    target: { kind: "ssh" as const, host_id: "cluster" },
    target_label: "Research cluster",
    modal: undefined,
    lifecycle: { ...job.lifecycle, delivery: "pending", resource: "closed" as const },
  }
  const recovering = {
    ...collecting,
    id: "job_recovering",
    status: "failed" as const,
    resources: { ...job.resources, gpus: 2 },
    capture_error: "SSH output recovery failed",
    lifecycle: { execution: "failed", delivery: "failed", resource: "unknown" as const, recoverable: true },
  }
  const cleaning = {
    ...collecting,
    id: "job_cleaning",
    lifecycle: { ...job.lifecycle, resource: "unknown" as const },
  }
  const collectingHost = mount(() => subject.RemoteJobCard({ job: collecting }))
  const recoveringHost = mount(() => subject.RemoteJobCard({ job: recovering }))
  const cleaningHost = mount(() => subject.RemoteJobCard({ job: cleaning }))

  expect(subject.visibleJobs([job, collecting, recovering, cleaning]).map((item) => item.id)).toEqual([
    "job_collecting",
    "job_recovering",
    "job_cleaning",
  ])
  expect(collectingHost.textContent).toContain("Succeeded · collecting output")
  expect(recoveringHost.textContent).toContain("Failed · output recovery pending")
  expect(recoveringHost.textContent).toContain("2 GPUs · 4 CPU · 16 GB")
  expect(cleaningHost.textContent).toContain("Succeeded · remote cleanup pending")
})

test("cleanup warnings take precedence and Modal billing copy tolerates missing legacy details", () => {
  const uncertain = {
    ...job,
    status: "failed" as const,
    error: "The command failed",
    capture_error: "Output capture failed",
    cleanup_error: "Remote cleanup failed; billing may continue",
    lifecycle: { execution: "failed", delivery: "failed", resource: "unknown" as const, recoverable: true },
    modal: undefined,
  }
  const host = mount(() => subject.RemoteJobCard({ job: uncertain }))

  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Remote cleanup failed; billing may continue")
  expect(host.textContent).toContain("Billing can continue until the remote resource exits or is released.")
  expect(host.textContent).not.toContain("undefined-minute")
  expect(host.querySelector("button, details, summary, pre, code")).toBeNull()
})

test("a detached job on this machine is labeled as local", () => {
  const local = {
    ...job,
    id: "job_local",
    status: "running" as const,
    completed_at: undefined,
    target: { kind: "local" as const },
    target_label: "This Mac",
    modal: undefined,
    lifecycle: { ...job.lifecycle, execution: "running", resource: "none" as const },
  }
  const host = mount(() => subject.RemoteJobCard({ job: local }))

  expect(host.querySelector(".compute-row__kind")?.getAttribute("aria-label")).toBe("Local job")
  expect(host.querySelector('.compute-row__kind [data-icon="cpu"]')).not.toBeNull()
})
