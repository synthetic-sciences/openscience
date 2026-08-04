import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/ComputeSurface.tsx") as Promise<typeof import("./ComputeSurface")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []
type Mounted = { kernels: number; jobs: number }

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

const child = (name: keyof Mounted, mounted: Mounted) => () => {
  mounted[name]++
  const panel = document.createElement("section")
  panel.dataset.computeChild = name
  panel.textContent = `${name} content`
  return panel
}

describe("compute surface", () => {
  test("defaults to Kernels and does not mount Jobs until selected", async () => {
    const mounted = { kernels: 0, jobs: 0 }
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => document.createElement("section"),
        kernels: child("kernels", mounted),
        jobs: child("jobs", mounted),
      }),
    )
    const kernels = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="kernels"]')
    const jobs = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="jobs"]')

    expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Compute views")
    expect(kernels?.getAttribute("aria-selected")).toBe("true")
    expect(jobs?.getAttribute("aria-selected")).toBe("false")
    expect(host.querySelector('[data-compute-child="kernels"]')).not.toBeNull()
    expect(host.querySelector('[data-compute-child="jobs"]')).toBeNull()
    expect(mounted).toEqual({ kernels: 1, jobs: 0 })
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')
    expect(kernels?.getAttribute("aria-controls")).toBe(panel?.id)
    expect(panel?.getAttribute("aria-labelledby")).toBe(kernels?.id)

    jobs?.click()
    await Promise.resolve()

    expect(kernels?.getAttribute("aria-selected")).toBe("false")
    expect(jobs?.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector('[data-compute-child="kernels"]')).toBeNull()
    expect(host.querySelector('[data-compute-child="jobs"]')).not.toBeNull()
    expect(mounted).toEqual({ kernels: 1, jobs: 1 })
    const next = host.querySelector<HTMLElement>('[role="tabpanel"]')
    expect(jobs?.getAttribute("aria-controls")).toBe(next?.id)
    expect(next?.getAttribute("aria-labelledby")).toBe(jobs?.id)
  })

  test("uses automatic arrow-key activation and focus for its tabs", async () => {
    const mounted = { kernels: 0, jobs: 0 }
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => document.createElement("section"),
        kernels: child("kernels", mounted),
        jobs: child("jobs", mounted),
      }),
    )
    const kernels = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="kernels"]')
    const jobs = host.querySelector<HTMLButtonElement>('[role="tab"][data-compute-tab="jobs"]')

    kernels?.focus()
    kernels?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    await Promise.resolve()

    expect(jobs?.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(jobs)

    jobs?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    await Promise.resolve()

    expect(kernels?.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(kernels)
  })

  test("contains no unavailable or transport-facing product copy", () => {
    const source = readFileSync(fileURLToPath(new URL("./ComputeSurface.tsx", import.meta.url)), "utf8")

    expect(source).not.toContain("Terminal")
    expect(source).not.toContain("Atlas Compute")
    expect(source).not.toContain("OpenRouter")
    expect(source).not.toContain("provider")
  })

  test("uses the compact flat tab geometry", () => {
    const css = readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")

    expect(css).toMatch(/\.compute-surface__tabs\s*\{[^}]*min-height: 40px/s)
    expect(css).toMatch(/\.compute-surface__tab\s*\{[^}]*min-height: 32px/s)
    expect(css).toMatch(/\.compute-surface__tab\s*\{[^}]*border-radius: 8px/s)
    expect(css).toMatch(/\.compute-surface__tab\[data-active="true"\]\s*\{[^}]*box-shadow: none/s)
  })

  test("renders the host strip above the tablist", () => {
    const host = mount(() =>
      subject.ComputeSurface({
        strip: () => {
          const strip = document.createElement("section")
          strip.dataset.computeChild = "strip"
          return strip
        },
        kernels: child("kernels", { kernels: 0, jobs: 0 }),
        jobs: child("jobs", { kernels: 0, jobs: 0 }),
      }),
    )
    const surface = host.querySelector(".compute-surface")
    const children = [...(surface?.children ?? [])]
    const strip = children.findIndex((element) => element.matches('[data-compute-child="strip"]'))
    const tabs = children.findIndex((element) => element.matches('[role="tablist"]'))

    expect(strip).toBe(0)
    expect(tabs).toBeGreaterThan(strip)
  })
})
