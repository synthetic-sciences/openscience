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
  const node = document.createElement(name === "strip" ? "details" : "section")
  if (name === "strip") node.className = "activity-surface__capacity"
  node.dataset.computeChild = name
  return node
}

describe("compute surface", () => {
  test("renders one project-wide execution inventory with capacity collapsed", () => {
    const calls: string[] = []
    const host = mount(() => subject.ComputeSurface({ strip: child("strip", calls), kernels: child("kernels", calls) }))

    expect(calls).toEqual(["strip", "kernels"])
    expect(host.querySelector('[aria-label="Compute"]')).not.toBeNull()
    expect(host.querySelector('[data-compute-child="strip"]')).not.toBeNull()
    expect(host.querySelector('[data-compute-child="kernels"]')).not.toBeNull()
    expect(host.querySelector<HTMLDetailsElement>(".activity-surface__capacity")?.open).toBe(false)
    expect(host.querySelector('[role="tablist"]')).toBeNull()
  })

  test("keeps the former export as a compatibility alias", () => {
    expect(subject.ActivitySurface).toBe(subject.ComputeSurface)
  })

  test("contains no manual launcher or separate jobs mode", () => {
    const source = readFileSync(fileURLToPath(new URL("./ComputeSurface.tsx", import.meta.url)), "utf8")

    expect(source).not.toContain("ComputeJobs")
    expect(source).not.toContain("New kernel")
    expect(source).not.toContain("onEnsureSession")
    expect(source).not.toContain('role="tab"')
    expect(source).not.toContain("href=")
    expect(source).not.toContain("Coming soon")
    expect(source).not.toContain("Atlas Compute preview")
    expect(source).toContain("Compute reflects what happened and what is live")
    expect(source).toContain("governed remote GPU jobs")
    expect(source).toContain("Completed remote results stay")
  })

  test("uses its own width for narrow layouts", () => {
    const css = readFileSync(fileURLToPath(new URL("./ComputeSurface.css", import.meta.url)), "utf8")
    const host = readFileSync(fileURLToPath(new URL("./HostStrip.css", import.meta.url)), "utf8")

    expect(css).toContain("container: compute / inline-size")
    expect(css).toContain("@container compute (max-width: 470px)")
    expect(css).toContain("@container compute (max-width: 350px)")
    expect(css).toContain(".compute-surface .activity-card")
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto")
    expect(css).not.toContain('.activity-boundary[data-location="research"]')
    expect(host).toContain("@container compute (max-width: 500px)")
    expect(css).not.toContain("--activity-research:")
    expect(css).toContain("height: 32px")
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toContain("min-height: 44px")
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(host).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
})
