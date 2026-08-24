import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { KernelStatus } from "@/atlas/kernel-runtime"

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
  server.ssrLoadModule("/src/atlas/KernelCard.tsx") as Promise<typeof import("./KernelCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const kernel = (value: Partial<KernelStatus> = {}): KernelStatus => ({
  id: "kernel-live",
  active: true,
  state: "running",
  projectID: "project-1",
  sessionID: "ses_current",
  name: "agent",
  language: "python",
  target: { kind: "local" },
  incarnation: 4,
  execution_count: 7,
  queue_depth: 0,
  environment: null,
  process_id: 8234,
  process_started_at: Date.now() - 4_000,
  process_identity_verified: true,
  started_at: Date.now() - 4_000,
  last_activity_at: Date.now() - 1_000,
  last_execution: null,
  resources: { cpu_percent: 180, memory_bytes: 412_000_000 },
  ...value,
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

describe("kernel tracker row", () => {
  test("shows live state and point-in-time resources without controls", () => {
    const host = mount(() => subject.KernelCard({ kernel: kernel() }))

    expect(host.querySelector('.compute-row__kind [data-component="file-icon"]')).not.toBeNull()
    expect(host.querySelector(".compute-row__copy")?.textContent).toContain("Python analysis")
    expect(host.querySelector('[data-slot="kernel-card-executions"]')?.textContent).toContain(
      "Running · 7 runs completed",
    )
    expect(host.querySelector('[data-metric="memory"]')?.textContent).toContain("412 MB RSS")
    expect(host.querySelector('[data-metric="cpu"]')?.textContent).toContain("1.8 cores")
    expect(host.querySelectorAll("svg")).toHaveLength(3)
    expect(host.querySelector("button, details, summary, pre, code")).toBeNull()
  })

  test("keeps queue depth, idle age, and a named environment concise", () => {
    expect(subject.kernelActivity(kernel({ queue_depth: 2 }))).toBe("Running · 7 runs completed · 2 queued")
    expect(subject.kernelActivity(kernel({ execution_count: 0 }))).toBe("Running")
    expect(subject.kernelActivity(kernel({ state: "idle", execution_count: 1, last_activity_at: 1_000 }), 7_000)).toBe(
      "Idle 6s · 1 run",
    )

    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({
          state: "idle",
          execution_count: 1,
          last_activity_at: Date.now() - 6_000,
          environment_name: "structural-biology",
        }),
      }),
    )
    expect(host.querySelector('[data-slot="kernel-card-executions"]')?.textContent).toContain(
      "Idle 6s · 1 run · structural-biology",
    )
  })

  test("uses the active execution title without disclosing source or code", () => {
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({
          last_execution: {
            title: "Benchmarking survival classifiers",
            source: "analysis/titanic.py",
            code: "model.fit(X, y)",
            status: "running",
            execution_count: 7,
            message_id: "msg_1",
            call_id: "call_1",
          },
        }),
      }),
    )

    expect(host.querySelector(".compute-row__copy strong")?.textContent).toBe("Benchmarking survival classifiers")
    expect(host.textContent).not.toContain("analysis/titanic.py")
    expect(host.textContent).not.toContain("model.fit")
  })
})
