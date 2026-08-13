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
  artifacts: [{ path: "model.pkl", size: 10, sha256: "a".repeat(64), modified_at: "2026-08-08" }],
  lifecycle: { execution: "succeeded", delivery: "delivered", resource: "closed" as const, recoverable: false },
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

test("completed Modal GPU work leads with the result and keeps logs, files, and resources inspectable", async () => {
  const host = mount(() =>
    subject.RemoteJobCard({
      job,
      action: "",
      onCancel: async () => undefined,
      onRetry: async () => undefined,
      onRelease: async () => undefined,
      onOutput: async () => "accuracy=0.91",
    }),
  )

  expect(host.querySelector(".activity-card__kind")?.textContent).toBe("Remote GPU")
  expect(host.querySelector(".kernel-card__copy")?.textContent).toContain("Exit 0 · 1 file")
  expect(host.querySelector(".activity-card__status")).toBeNull()
  expect(host.textContent).toContain("A100 · 4 CPU · 16 GB memory")
  expect(host.textContent).not.toContain("Cancel")
  const logs = Array.from(host.querySelectorAll<HTMLDetailsElement>("details")).find(
    (item) => item.querySelector("summary")?.textContent === "Logs",
  )
  expect(logs?.open).toBe(false)
  logs?.querySelector<HTMLElement>("summary")?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain("accuracy=0.91")
})

test("a live Modal job remains cancellable and counts as live", () => {
  const running = {
    ...job,
    status: "running" as const,
    completed_at: undefined,
    lifecycle: { ...job.lifecycle, execution: "running", resource: "active" as const },
  }
  const host = mount(() =>
    subject.RemoteJobCard({
      job: running,
      action: "",
      onCancel: async () => undefined,
      onRetry: async () => undefined,
      onRelease: async () => undefined,
      onOutput: async () => "",
    }),
  )

  expect(subject.jobLive(running)).toBe(true)
  expect(subject.jobStatusLabel("interrupted")).toBe("Interrupted")
  expect(host.textContent).toContain("Cancel")
  expect(host.textContent).toContain("Modal billing may continue")
  expect(host.textContent).toContain("10-minute timeout")
})

test("keeps live work and a bounded newest-first set of completed results", () => {
  const running = {
    ...job,
    id: "job_running",
    status: "running" as const,
    completed_at: undefined,
    lifecycle: { ...job.lifecycle, execution: "running", resource: "active" as const },
  }
  const older = {
    ...job,
    id: "job_older",
    completed_at: "2026-08-08T09:01:01.000Z",
  }
  const newer = {
    ...job,
    id: "job_newer",
    completed_at: "2026-08-08T11:01:01.000Z",
  }

  expect(subject.visibleJobs([older, running, newer], 1).map((item) => item.id)).toEqual(["job_running", "job_newer"])
})

test("never hides an older failed job behind newer successful history", () => {
  const failed = {
    ...job,
    id: "job_failed",
    status: "failed" as const,
    completed_at: "2026-08-08T08:01:01.000Z",
  }
  const successes = Array.from({ length: 8 }, (_, index) => ({
    ...job,
    id: `job_success_${index}`,
    completed_at: `2026-08-08T${String(10 + index).padStart(2, "0")}:01:01.000Z`,
  }))

  expect(subject.visibleJobs([failed, ...successes], 2).map((item) => item.id)).toContain("job_failed")
  expect(subject.visibleJobs([failed, ...successes], 2)).toHaveLength(3)
})
