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

describe("kernel status row", () => {
  test("shows the live runtime in one compact row", () => {
    const host = mount(() => subject.KernelCard({ kernel: kernel(), action: "", onControl: () => {} }))

    expect(host.querySelector(".activity-card__kind")?.textContent).toBe("Python")
    expect(host.querySelector(".kernel-card__copy")?.textContent).toContain("Python analysis")
    expect(host.querySelector(".kernel-card__copy")?.textContent).toContain("Running · 7 runs")
    expect(host.querySelector(".kernel-card__copy > span")?.getAttribute("title")).toBe("Executing now.")
    expect(host.querySelector(".activity-card__status")?.textContent).toBe("Running")
    expect(host.querySelector<HTMLDetailsElement>('.activity-disclosure[data-quiet="true"]')?.open).toBe(false)
    expect(host.textContent).toContain("412 MB")
    expect(host.textContent).toContain("1.8 cores")
  })

  test("keeps queued work visible without filling the row with recovery prose", () => {
    expect(subject.kernelActivity(kernel({ queue_depth: 2 }))).toBe("Running · 7 runs · 2 queued")
    expect(subject.kernelActivity(kernel({ state: "idle", execution_count: 1 }))).toBe("Warm for follow-up · 1 run")

    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({ state: "idle", execution_count: 1 }),
        action: "",
        onControl: () => {},
      }),
    )
    expect(host.querySelector(".activity-card__status")?.textContent).toBe("Ready")
    expect(host.querySelector(".kernel-card__copy > span")?.textContent).toBe("Warm for follow-up · 1 run")
  })

  test("keeps restart and stop available without exposing creation, interrupt, or forget", () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.KernelCard({ kernel: kernel(), action: "", onControl: (action) => calls.push(action) }),
    )
    const restart = host.querySelector<HTMLButtonElement>('button[aria-label="Restart Python analysis"]')
    const stop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop Python analysis"]')

    expect(host.querySelectorAll("button").length).toBe(2)
    expect(restart?.disabled).toBe(false)
    expect(stop?.disabled).toBe(false)
    expect(stop?.title).toContain("clear its in-memory state")
    restart?.click()
    stop?.click()
    expect(calls).toEqual(["restart", "stop"])
  })

  test("never presents an inactive record as startable", () => {
    const host = mount(() =>
      subject.KernelCard({
        kernel: kernel({ active: false, state: "stopped", started_at: null, resources: undefined }),
        action: "",
        onControl: () => {},
      }),
    )

    expect(host.querySelectorAll("button").length).toBe(2)
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).every((button) => button.disabled)).toBe(true)
    expect(host.textContent).toContain("Not running")
    expect(host.textContent).not.toContain("Start")
  })

  test("counts uptime while a process stays mounted", async () => {
    const host = mount(() =>
      subject.KernelCard({ kernel: kernel({ started_at: Date.now() - 2_000 }), action: "", onControl: () => {} }),
    )
    const details = () => host.querySelector(".activity-card__facts > div:first-child dd")?.textContent
    const first = details()
    await Bun.sleep(1_200)
    expect(details()).not.toBe(first)
  })

  test("keeps the latest execution compact and inspectable", () => {
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
        action: "",
        onControl: () => {},
      }),
    )
    const execution = host.querySelector<HTMLDetailsElement>(".kernel-card__cell")

    expect(execution?.open).toBe(false)
    expect(execution?.querySelector("summary")?.textContent).toContain("Run 7")
    expect(execution?.querySelector(".activity-disclosure__caption")?.textContent).toContain(
      "Benchmarking survival classifiers",
    )
    expect(execution?.querySelector(".activity-disclosure__caption")?.textContent).toContain("analysis/titanic.py")
    expect(execution?.querySelector("code")?.textContent).toBe("model.fit(X, y)")
  })
})
