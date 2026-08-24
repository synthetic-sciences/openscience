import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { KernelStatus } from "@/atlas/kernel-runtime"

// KernelPanel itself is not mountable under this harness: unlike HostStrip it
// has no injectable transport prop, and its useSDK()/useParams() dependencies
// pull in a live SSE event stream (useGlobalSDK) and a second
// execution-authority resource with no established fake seam in this test
// suite. What IS directly testable, and is the actual mechanism the flicker
// fix depends on, is useKernelList: the store + reconcile(key: "id") that
// KernelPanel.tsx now composes with <For> and the real KernelCard. Mounting
// that combination here exercises the exact code path production uses.
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
// Loaded sequentially, not via Promise.all: concurrent first-time
// ssrLoadModule calls for "solid-js" (loaded directly here, and again
// transitively by use-kernel-list.ts via solid-js/store, and by KernelCard.tsx)
// can race Vite's dep resolution and yield two separate module instances —
// solid-js then warns "multiple instances" and <For>'s $TRACK-keyed reconcile
// silently no-ops, so the list never mounts. Awaiting solid-js and solid-js/web
// first lets Vite settle on one instance before the components that import
// them are loaded.
const core = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("/src/atlas/use-kernel-list.ts")) as typeof import("./use-kernel-list")
const card = (await vite.ssrLoadModule("/src/atlas/KernelCard.tsx")) as typeof import("./KernelCard")

afterAll(() => vite.close())

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

// Freshness assertions read one stable field instead of the whole card.
const executions = (element: Element | null) =>
  element?.querySelector('[data-slot="kernel-card-executions"]')?.textContent?.match(/· (\d+) runs?/)?.[1]

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const kernel = (value: Partial<KernelStatus> & { id: string }): KernelStatus => ({
  active: true,
  state: "running",
  projectID: "project-1",
  sessionID: "ses_current",
  name: "agent",
  language: "python",
  target: { kind: "local" },
  incarnation: 1,
  execution_count: 0,
  queue_depth: 0,
  environment: null,
  process_id: 1234,
  process_started_at: Date.now() - 10_000,
  process_identity_verified: true,
  started_at: Date.now() - 10_000,
  last_activity_at: Date.now() - 5_000,
  last_execution: null,
  ...value,
})

// Mirrors what KernelPanel.tsx does with useKernelList's output: feed the
// reconciled store straight into <For>, one KernelCard per kernel.
const list = (source: () => KernelStatus[] | undefined) => {
  const kernels = subject.useKernelList(source)
  return core.createComponent(core.For, {
    get each() {
      return kernels
    },
    children: (kernel: KernelStatus) =>
      core.createComponent(card.KernelCard, {
        get kernel() {
          return kernel
        },
      }),
  })
}

describe("kernel list reconciliation", () => {
  test("keeps an unchanged kernel's card mounted while its fields update in place", async () => {
    const [source, setSource] = core.createSignal<KernelStatus[] | undefined>([
      kernel({ id: "kernel-a", execution_count: 1 }),
      kernel({ id: "kernel-b", execution_count: 5 }),
    ])
    const host = mount(() => list(source))
    await Promise.resolve()

    const cardA = host.querySelector('[data-kernel-id="kernel-a"]')
    const cardB = host.querySelector('[data-kernel-id="kernel-b"]')
    expect(cardA).not.toBeNull()
    expect(cardB).not.toBeNull()
    expect(host.querySelectorAll(".kernel-card").length).toBe(2)
    expect(executions(cardB)).toBe("5")

    // A poll: brand new response objects, kernel-b's execution_count moved and
    // the two entries swapped position (the server re-sorts by
    // last_activity_at). Neither should recreate a card.
    setSource([kernel({ id: "kernel-b", execution_count: 9 }), kernel({ id: "kernel-a", execution_count: 1 })])
    await Promise.resolve()

    // Identity: the very same card elements are still the ones mounted, even
    // though their position in the list changed.
    expect(host.querySelector('[data-kernel-id="kernel-a"]')).toBe(cardA)
    expect(host.querySelector('[data-kernel-id="kernel-b"]')).toBe(cardB)
    expect(host.contains(cardA)).toBe(true)
    expect(host.contains(cardB)).toBe(true)
    // Freshness: kernel-b's changed field actually reached the same node.
    expect(executions(cardB)).toBe("9")
  })

  test("moves the row's own figures when a poll changes them", async () => {
    // These are the two numbers a passive row is reduced to, and they sit
    // on a nested object (`resources`) rather than on the kernel itself — so
    // this pins that reconcile's patch reaches them and the head re-renders,
    // rather than the card holding the first reading it was given.
    const metric = (element: Element | null, name: "memory" | "cpu") =>
      element?.querySelector(`[data-metric="${name}"] > span`)?.textContent
    const [source, setSource] = core.createSignal<KernelStatus[] | undefined>([
      kernel({ id: "kernel-a", resources: { cpu_percent: 0, memory_bytes: 16_000_000 } }),
    ])
    const host = mount(() => list(source))
    await Promise.resolve()

    const card = host.querySelector('[data-kernel-id="kernel-a"]')
    expect(metric(card, "memory")).toBe("16 MB RSS")
    expect(metric(card, "cpu")).toBe("0.0 cores")

    setSource([kernel({ id: "kernel-a", resources: { cpu_percent: 187.5, memory_bytes: 2_400_000_000 } })])
    await Promise.resolve()

    expect(host.querySelector('[data-kernel-id="kernel-a"]')).toBe(card)
    expect(metric(card, "memory")).toBe("2.4 GB RSS")
    expect(metric(card, "cpu")).toBe("1.9 cores")
  })

  test("mounts a newly appeared kernel and unmounts one that disappeared", async () => {
    const [source, setSource] = core.createSignal<KernelStatus[] | undefined>([
      kernel({ id: "kernel-a" }),
      kernel({ id: "kernel-d" }),
    ])
    const host = mount(() => list(source))
    await Promise.resolve()
    expect(host.querySelectorAll(".kernel-card").length).toBe(2)

    setSource([kernel({ id: "kernel-a" }), kernel({ id: "kernel-c" })])
    await Promise.resolve()

    expect(host.querySelector('[data-kernel-id="kernel-d"]')).toBeNull()
    expect(host.querySelector('[data-kernel-id="kernel-c"]')).not.toBeNull()
    expect(host.querySelectorAll(".kernel-card").length).toBe(2)
  })
})
