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
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/ComputeSurface.tsx") as Promise<typeof import("./ComputeSurface")>,
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

const child = (name: string, calls: string[]) => () => {
  calls.push(name)
  const node = document.createElement("section")
  node.dataset.computeChild = name
  return node
}

describe("compute surface", () => {
  test("renders one static telemetry strip and one live inventory", () => {
    const calls: string[] = []
    const host = mount(() => subject.ComputeSurface({ strip: child("strip", calls), kernels: child("kernels", calls) }))

    expect(calls).toEqual(["strip", "kernels"])
    expect(host.querySelector('[aria-label="Compute"]')).not.toBeNull()
    expect(host.querySelector('[data-compute-child="strip"]')).not.toBeNull()
    expect(host.querySelector('[data-compute-child="kernels"]')).not.toBeNull()
    expect(host.querySelector("button, details, summary, [role=tablist]")).toBeNull()
  })

  test("keeps the former export as a compatibility alias", () => {
    expect(subject.ActivitySurface).toBe(subject.ComputeSurface)
  })

  test("documents the tracking-only boundary", () => {
    const source = readFileSync(fileURLToPath(new URL("./ComputeSurface.tsx", import.meta.url)), "utf8")

    expect(source).toContain("read-only instrument panel")
    expect(source).toContain("Compute only tracks what")
    expect(source).toContain("still needs operational attention")
    expect(source).toContain("owns no")
    expect(source).toContain("lifecycle controls")
    expect(source).toContain("completed-history workflow")
    expect(source).not.toContain("ComputeJobs")
    expect(source).not.toContain("New kernel")
  })

  test("uses its own width for narrow layouts", () => {
    const css = readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")
    const strip = readFileSync(fileURLToPath(new URL("./HostStrip.css", import.meta.url)), "utf8")

    expect(css).toContain("container: compute / inline-size")
    expect(css).toContain("@container compute (max-width: 470px)")
    expect(css).toContain("@container compute (max-width: 350px)")
    expect(css).toContain(".compute-row")
    expect(css).not.toContain(".activity-card")
    expect(css).not.toContain(".activity-disclosure")
    expect(strip).toContain("@container compute (max-width: 470px)")
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(strip).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
})
