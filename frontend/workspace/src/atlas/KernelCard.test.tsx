import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { KernelStatus } from "@/notebook/runtime"

const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/KernelCard.tsx") as Promise<typeof import("./KernelCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const kernel = (value: Partial<KernelStatus> = {}): KernelStatus => ({
  id: "kernel-live",
  active: true,
  state: "idle",
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
  ...value,
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe("KernelCard lifecycle controls", () => {
  test("renders a reloaded live process as active with its exact incarnation and identity", () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel(),
        routeID: "ses_current",
        action: "",
        onControl: (action) => calls.push(action),
      }),
    )

    expect(host.querySelector(".kernel-card__state")?.textContent).toContain("ready")
    expect(host.textContent).toContain("r4")
    expect(host.textContent).toContain("8234")
    expect(host.textContent).toContain("PID and process start verified")
    expect(button(host, "Interrupt analysis.ipynb")).toBeNull()
    expect(button(host, "Restart analysis.ipynb")?.disabled).toBe(false)
    expect(button(host, "Stop analysis.ipynb")?.disabled).toBe(false)

    button(host, "Restart analysis.ipynb")?.click()
    button(host, "Stop analysis.ipynb")?.click()
    expect(calls).toEqual(["restart", "stop"])
  })

  test("interrupts only running work and states restart data loss before the action", () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({ state: "running", queue_depth: 2 }),
        routeID: "ses_current",
        action: "",
        onControl: (action) => calls.push(action),
      }),
    )

    expect(button(host, "Interrupt analysis.ipynb")?.disabled).toBe(false)
    expect(button(host, "Restart analysis.ipynb")?.title).toContain(
      "All in-memory variables and queued cells will be lost",
    )
    expect(host.querySelector(".kernel-card__control-note")).toBeNull()
    button(host, "Interrupt analysis.ipynb")?.click()
    expect(calls).toEqual(["interrupt"])
  })

  test("offers restart and forget for an inactive named R record but cannot stop it twice", () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({
          active: false,
          state: "stopped",
          language: "r",
          incarnation: 2,
          execution_count: 0,
          process_id: null,
          process_started_at: null,
          process_identity_verified: null,
          started_at: null,
        }),
        routeID: "ses_current",
        action: "",
        onControl: (action) => calls.push(action),
      }),
    )

    expect(host.textContent).toContain("R · Local")
    expect(button(host, "Start runtime analysis.ipynb")?.disabled).toBe(false)
    expect(button(host, "Stop analysis.ipynb")).toBeNull()
    expect(button(host, "Forget analysis.ipynb")?.disabled).toBe(false)
    button(host, "Forget analysis.ipynb")?.click()
    expect(calls).toEqual(["delete"])
  })

  test("shows only metrics the host actually reports", () => {
    const sampled = mount(() =>
      subject.KernelCard({
        kernel: kernel({ resources: { cpu_percent: 12.34, memory_bytes: 412_000_000 } }),
        routeID: "ses_current",
        action: "",
        onControl: () => {},
      }),
    )
    const usage = sampled.querySelector(".kernel-card__metrics")
    expect(usage?.textContent).toContain("Target")
    expect(usage?.textContent).toContain("Local")
    expect(usage?.textContent).toContain("12.3%")
    expect(usage?.textContent).toContain("412 MB")
    expect(usage?.textContent).toContain("Uptime")
    expect(usage?.textContent).not.toContain("GPU")
    expect(usage?.textContent).not.toContain("VRAM")
    expect(usage?.textContent).not.toContain("Unavailable")

    const partial = mount(() =>
      subject.KernelCard({
        kernel: kernel({ resources: { cpu_percent: 3 } }),
        routeID: "ses_current",
        action: "",
        onControl: () => {},
      }),
    )
    const half = partial.querySelector(".kernel-card__metrics")
    expect(half?.textContent).toContain("3.0%")
    expect(half?.textContent).not.toContain("Unavailable")
    expect(half?.textContent).not.toContain("0 B")

    const bare = mount(() =>
      subject.KernelCard({
        kernel: kernel(),
        routeID: "ses_current",
        action: "",
        onControl: () => {},
      }),
    )
    const empty = bare.querySelector(".kernel-card__metrics")
    expect(empty?.textContent).toContain("Local")
    expect(empty?.textContent).not.toContain("%")
    expect(empty?.textContent).not.toContain("Unavailable")
  })

  test("keeps the lazy named session kernel restartable but not deletable", () => {
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({
          active: false,
          state: "lazy",
          name: "agent",
          incarnation: null,
          execution_count: 0,
          process_id: null,
          process_started_at: null,
          process_identity_verified: null,
          started_at: null,
        }),
        routeID: "ses_current",
        action: "",
        onControl: () => {},
      }),
    )

    expect(host.textContent).toContain("No process is running")
    expect(button(host, "Start runtime Python analysis")?.disabled).toBe(false)
    expect(button(host, "Forget Python analysis")).toBeNull()
  })

  test("blocks restart when execution authority is denied but leaves safe cleanup available", () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel(),
        routeID: "ses_current",
        action: "",
        restartDisabled: true,
        restartTitle: "Trust this project to start or restart a kernel in this session.",
        onControl: (action) => calls.push(action),
      }),
    )

    expect(button(host, "Restart analysis.ipynb")?.disabled).toBe(true)
    expect(button(host, "Restart analysis.ipynb")?.title).toContain("Trust this project")
    expect(button(host, "Stop analysis.ipynb")?.disabled).toBe(false)
    button(host, "Restart analysis.ipynb")?.click()
    button(host, "Stop analysis.ipynb")?.click()
    expect(calls).toEqual(["stop"])
  })
})
