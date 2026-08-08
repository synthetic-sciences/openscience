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

// The plate collapses by default, so everything below the head — the ledger,
// the environment block, the controls, the identity list — is not in the DOM
// until it is opened. Mounting opens it, because that is the state these
// assertions are about; the collapsed head has its own tests below.
const mount = (view: () => JSX.Element, options: { collapsed?: boolean } = {}) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  if (!options.collapsed) host.querySelector<HTMLButtonElement>(".kernel-card__plate")?.click()
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

    expect(host.querySelector(".kernel-card__state")?.textContent).toBe("Ready")
    expect(host.textContent).toContain("r4")
    expect(host.textContent).toContain("8234")
    expect(host.textContent).toContain("PID and process start verified")
    expect(button(host, "Interrupt analysis.ipynb")?.disabled).toBe(true)
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
    // The standing note under the controls is gone with the 3a plate. The
    // warning has to survive somewhere the user meets it before acting, so it
    // rides on the button that causes the loss.
    expect(host.querySelector(".kernel-card__control-note")).toBeNull()
    expect(button(host, "Stop analysis.ipynb")?.title).toContain("clear its in-memory state")
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

    expect(host.textContent).toContain("R environment")
    expect(button(host, "Restart analysis.ipynb")?.disabled).toBe(false)
    expect(button(host, "Stop analysis.ipynb")?.disabled).toBe(true)
    expect(button(host, "Forget analysis.ipynb")?.disabled).toBe(false)
    button(host, "Forget analysis.ipynb")?.click()
    expect(calls).toEqual(["delete"])
  })

  test("shows the local target with sampled usage and an unavailable fallback, never zero", () => {
    // CPU is stated as a share of the machine, so this row needs the host
    // reading the surface passes down: 12.34% of one core on an 8-core box is
    // 1.5% of the machine.
    const capacity = { memory: { total: 16_400_000_000, available: 12_000_000_000 }, cpu: { cores: 8 } }
    const sampled = mount(() =>
      subject.KernelCard({
        kernel: kernel({ resources: { cpu_percent: 12.34, memory_bytes: 412_000_000 } }),
        routeID: "ses_current",
        action: "",
        capacity,
        onControl: () => {},
      }),
    )
    const usage = sampled.querySelector(".kernel-card__metrics--usage")
    expect(usage?.textContent).toContain("Target")
    expect(usage?.textContent).toContain("Local")
    expect(usage?.textContent).toContain("1.5%")
    expect(usage?.textContent).toContain("412 MB")
    expect(usage?.textContent).toContain("Uptime")
    expect(usage?.textContent).toContain("GPU")
    expect(usage?.textContent).toContain("VRAM")

    const partial = mount(() =>
      subject.KernelCard({
        kernel: kernel({ resources: { cpu_percent: 24 } }),
        routeID: "ses_current",
        action: "",
        capacity,
        onControl: () => {},
      }),
    )
    const half = partial.querySelector(".kernel-card__metrics--usage")
    expect(half?.textContent).toContain("3.0%")
    expect(half?.textContent?.match(/Unavailable/g)?.length).toBe(3)
    expect(half?.textContent).not.toContain("0 B")

    const bare = mount(() =>
      subject.KernelCard({
        kernel: kernel(),
        routeID: "ses_current",
        action: "",
        onControl: () => {},
      }),
    )
    const empty = bare.querySelector(".kernel-card__metrics--usage")
    expect(empty?.textContent).toContain("Local")
    expect(empty?.textContent).not.toContain("%")
    expect(empty?.textContent?.match(/Unavailable/g)?.length).toBe(4)
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
    expect(button(host, "Restart Python analysis")?.disabled).toBe(false)
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
  test("collapses to a head that still answers whether the runtime is in the way", () => {
    const host = mount(
      () =>
        subject.KernelCard({
          kernel: kernel({ state: "running", resources: { cpu_percent: 180, memory_bytes: 2_400_000_000 } }),
          routeID: "ses_current",
          action: "",
          index: 0,
          capacity: { memory: { total: 16_400_000_000, available: 12_000_000_000 }, cpu: { cores: 8 } },
          onControl: () => {},
        }),
      { collapsed: true },
    )

    const plate = host.querySelector<HTMLButtonElement>(".kernel-card__plate")
    expect(plate?.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector(".kernel-card__language")?.textContent).toBe("Kernel 01 · Python")
    expect(host.querySelector(".kernel-card__state")?.textContent).toBe("Running")
    // The two figures that survive the collapse.
    expect(host.querySelector(".kernel-card__usage")?.textContent).toContain("2.4")
    expect(host.querySelector(".kernel-card__usage")?.textContent).toContain("/ 16.4 GB")
    expect(host.querySelectorAll(".kernel-card__usage-cores > div").length).toBe(8)
    expect(host.querySelectorAll('.kernel-card__usage-cores > div[data-lit="true"]').length).toBe(2)

    // Nothing below the head is in the DOM until it is opened, so a list of
    // several runtimes stays a list rather than a stack of full records.
    expect(host.querySelector(".kernel-card__controls")).toBeNull()
    expect(host.querySelector(".kernel-card__metrics")).toBeNull()
    expect(host.querySelector(".kernel-card__identity")).toBeNull()
    expect(host.textContent).not.toContain("Runtime identity")
  })

  test("opens and closes from the head, which is the whole hit target", () => {
    const host = mount(
      () =>
        subject.KernelCard({
          kernel: kernel(),
          routeID: "ses_current",
          action: "",
          onControl: () => {},
        }),
      { collapsed: true },
    )
    const plate = host.querySelector<HTMLButtonElement>(".kernel-card__plate")

    plate?.click()
    expect(plate?.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector(".kernel-card__controls")).not.toBeNull()
    expect(host.querySelector(".kernel-card")?.getAttribute("data-open")).toBe("true")

    plate?.click()
    expect(plate?.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector(".kernel-card__controls")).toBeNull()
  })

  test("numbers each plate by its position so two collapsed heads read apart", () => {
    const host = mount(
      () =>
        subject.KernelCard({
          kernel: kernel({ language: "r" }),
          routeID: "ses_current",
          action: "",
          index: 2,
          onControl: () => {},
        }),
      { collapsed: true },
    )

    expect(host.querySelector(".kernel-card__language")?.textContent).toBe("Kernel 03 · R")
  })
  test("counts uptime like a stopwatch rather than freezing at its first reading", async () => {
    // The kernel object is reconciled in place, so it does not change while a
    // runtime simply keeps running. Uptime therefore has to be driven by a
    // clock inside the card; before it was, the head sat at "2s" for as long
    // as the runtime lived.
    const host = mount(
      () =>
        subject.KernelCard({
          kernel: kernel({ active: true, state: "running", started_at: Date.now() - 2_000 }),
          routeID: "ses_current",
          action: "",
          onControl: () => {},
        }),
      { collapsed: true },
    )

    const first = host.querySelector(".kernel-card__uptime")?.textContent
    expect(first).toMatch(/^\d+s$/)
    await Bun.sleep(1_200)
    const second = host.querySelector(".kernel-card__uptime")?.textContent
    expect(second).not.toBe(first)
  })

  test("stops the clock when there is nothing running to count", () => {
    const host = mount(
      () =>
        subject.KernelCard({
          kernel: kernel({ active: false, state: "stopped", started_at: null }),
          routeID: "ses_current",
          action: "",
          onControl: () => {},
        }),
      { collapsed: true },
    )

    // "Unavailable" is three times the width of the figure it replaces and
    // says nothing the lifecycle pill beside it does not.
    expect(host.querySelector(".kernel-card__uptime")).toBeNull()
  })
})
