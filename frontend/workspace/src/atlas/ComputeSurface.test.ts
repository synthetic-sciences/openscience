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
})
