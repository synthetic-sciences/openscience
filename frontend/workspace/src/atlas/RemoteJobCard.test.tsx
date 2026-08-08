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

test("completed Modal GPU work shows resources, delivered result, and released lifecycle", async () => {
  const host = mount(() =>
    subject.RemoteJobCard({
      job,
      cancelling: false,
      onCancel: async () => undefined,
      onOutput: async () => "accuracy=0.91",
    }),
  )

  expect(host.textContent).toContain("GPU")
  expect(host.textContent).toContain("Modal · A100 · 4 CPU · 16 GB")
  expect(host.textContent).toContain("succeeded")
  expect(host.textContent).toContain("exit 0 · 1 artifact · remote released")
  expect(host.textContent).not.toContain("Cancel")
  host.querySelector<HTMLButtonElement>(".remote-job-card__actions button")!.click()
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
      cancelling: false,
      onCancel: async () => undefined,
      onOutput: async () => "",
    }),
  )

  expect(subject.jobLive(running)).toBe(true)
  expect(host.textContent).toContain("Cancel")
})
