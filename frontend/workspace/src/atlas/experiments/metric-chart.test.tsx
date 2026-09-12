import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../../test/vite"
import solid from "vite-plugin-solid"

const cleanups: Array<() => void> = []
const vite = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await vite.ssrLoadModule("/src/atlas/experiments/MetricChart.tsx")) as typeof import("./MetricChart")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
afterAll(() => vite.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const series = [
  { id: "a", label: "baseline", color: "#111", points: [0, 1, 2, 3, 4].map((step) => ({ step, value: 10 - step })) },
  { id: "b", label: "momentum", color: "#222", points: [0, 1, 2, 3, 4].map((step) => ({ step, value: 5 - step })) },
]

test("draws one line per series and reports every series at the hovered step", async () => {
  if (!("ResizeObserver" in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.MetricChart({ series, height: 120 }), host))
  const lines = host.querySelectorAll(".metric-chart__line")
  expect(lines.length).toBe(2)
  expect(lines[0]!.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ L/)
  expect(host.querySelector(".metric-chart__tooltip")).toBeNull()

  const svg = host.querySelector("svg")!
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 120 }) as DOMRect
  // Past the right margin: the nearest step is the last one for both series.
  svg.dispatchEvent(new MouseEvent("mousemove", { clientX: 470, clientY: 40, bubbles: true }))
  await Bun.sleep(0)
  const tooltip = host.querySelector(".metric-chart__tooltip")!
  expect(tooltip.textContent).toContain("step 4")
  expect(tooltip.textContent).toContain("baseline")
  expect(tooltip.textContent).toContain("momentum")
  expect(tooltip.querySelectorAll("b").length).toBe(2)
  expect(Array.from(tooltip.querySelectorAll("b")).map((node) => node.textContent)).toEqual(["6.000", "1.000"])
  svg.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }))
  await Bun.sleep(0)
  expect(host.querySelector(".metric-chart__tooltip")).toBeNull()
})

test("an empty series set shows the empty state, and log scale drops non-positive points", async () => {
  if (!("ResizeObserver" in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.MetricChart({ series: [], height: 120 }), host))
  expect(host.textContent).toContain("No points yet")
  host.replaceChildren()
  cleanups.push(
    web.render(
      () =>
        subject.MetricChart({
          series: [
            {
              id: "a",
              label: "a",
              color: "#111",
              points: [
                { step: 0, value: 0 },
                { step: 1, value: 1 },
                { step: 2, value: 100 },
              ],
            },
          ],
          log: true,
          height: 120,
        }),
      host,
    ),
  )
  const path = host.querySelector(".metric-chart__line")!.getAttribute("d")!
  // Two positive points: one move, one line.
  expect(path.split("L").length).toBe(2)
  expect(subject.formatValue(0.000123)).toBe("1.23e-4")
  expect(subject.formatValue(1234.5678)).toBe("1234.6")
  expect(subject.formatValue(0.5)).toBe("0.5")
})
