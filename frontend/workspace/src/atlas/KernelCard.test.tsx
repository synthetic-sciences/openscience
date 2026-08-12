import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { KernelStatus } from "@/notebook/runtime"

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
  name: "notebook:analysis.ipynb",
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
  last_cell: null,
  resources: { cpu_percent: 180, memory_bytes: 412_000_000 },
  ...value,
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

describe("kernel status row", () => {
  test("shows the live runtime in one compact row", () => {
    const host = mount(() => subject.KernelCard({ kernel: kernel(), action: "", onControl: () => {} }))

    expect(host.querySelector(".kernel-card__language [data-component=icon]")).not.toBeNull()
    expect(host.querySelector(".kernel-card__copy")?.textContent).toContain("analysis.ipynb")
    expect(host.querySelector(".kernel-card__copy")?.textContent).toContain("Running · 7 cells")
    expect(host.querySelector(".kernel-card__copy > span")?.getAttribute("title")).toBe("Executing now.")
    expect(host.querySelector(".kernel-card__uptime strong")?.textContent).toMatch(/^\d+s$/)
    expect(host.querySelector(".kernel-card__uptime small")?.textContent).toBe("Runtime")
    expect(host.querySelectorAll(".kernel-card__metric")[1]?.textContent).toBe("412 MBMemory")
    expect(host.querySelectorAll(".kernel-card__metric")[2]?.textContent).toBe("1.8CPU cores")
  })

  test("keeps queued work visible without filling the row with recovery prose", () => {
    expect(subject.kernelActivity(kernel({ queue_depth: 2 }))).toBe("Running · 7 cells · 2 queued")
    expect(subject.kernelActivity(kernel({ state: "idle", execution_count: 1 }))).toBe("Ready · 1 cell")
  })

  test("only exposes stop, never manual start, restart, interrupt, or forget", () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.KernelCard({ kernel: kernel(), action: "", onControl: (action) => calls.push(action) }),
    )
    const stop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop analysis.ipynb"]')

    expect(host.querySelectorAll("button").length).toBe(1)
    expect(stop?.disabled).toBe(false)
    expect(stop?.title).toContain("clear its in-memory state")
    stop?.click()
    expect(calls).toEqual(["stop"])
  })

  test("never presents an inactive record as startable", () => {
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({ active: false, state: "stopped", started_at: null, resources: undefined }),
        action: "",
        onControl: () => {},
      }),
    )

    expect(host.querySelectorAll("button").length).toBe(1)
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true)
    expect(host.querySelector(".kernel-card__uptime strong")?.textContent).toBe("—")
    expect(host.textContent).not.toContain("Start")
    expect(host.textContent).not.toContain("Restart")
  })

  test("counts uptime while a process stays mounted", async () => {
    const host = mount(() =>
      subject.KernelCard({ kernel: kernel({ started_at: Date.now() - 2_000 }), action: "", onControl: () => {} }),
    )
    const first = host.querySelector(".kernel-card__uptime")?.textContent
    await Bun.sleep(1_200)
    expect(host.querySelector(".kernel-card__uptime")?.textContent).not.toBe(first)
  })

  test("keeps the latest executed cell compact and inspectable", () => {
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({
          last_cell: {
            title: "Benchmarking survival classifiers",
            source: "analysis/titanic.ipynb",
            code: "model.fit(X, y)",
            status: "running",
            execution_count: 7,
            message_id: "msg_1",
            call_id: "call_1",
          },
        }),
        action: "",
        onControl: () => {},
      }),
    )
    const cell = host.querySelector<HTMLDetailsElement>(".kernel-card__cell")

    expect(cell?.open).toBe(false)
    expect(cell?.querySelector("summary")?.textContent).toContain("Cell 7 · Running")
    expect(cell?.querySelector("summary")?.textContent).toContain("Benchmarking survival classifiers")
    expect(cell?.querySelector("summary")?.textContent).toContain("analysis/titanic.ipynb")
    expect(cell?.querySelector("code")?.textContent).toBe("model.fit(X, y)")
  })
})
