import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solidPlugin from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solidPlugin({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})

const harness = (await server.ssrLoadModule(
  "/src/atlas/project-workspace-lifecycle.fixture.tsx",
)) as typeof import("./project-workspace-lifecycle.fixture")

const cleanups: Array<() => void> = []

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

describe("project workspace lifecycle", () => {
  test("switches session A to B without remounting open Terminal and File surfaces", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const mounted = harness.mountProjectWorkspaceLifecycle(host)
    cleanups.push(mounted.dispose)

    await Promise.resolve()
    const terminal = host.querySelector('[data-surface="terminal"]')
    const file = host.querySelector('[data-surface="file"]')
    expect(host.textContent).toContain("Chat session-a")
    expect(mounted.lifecycle()).toEqual({ mounts: 2, cleanups: 0 })

    mounted.setSession("session-b")
    await Promise.resolve()

    expect(host.textContent).toContain("Chat session-b")
    expect(host.querySelector('[data-surface="terminal"]')).toBe(terminal)
    expect(host.querySelector('[data-surface="file"]')).toBe(file)
    expect(mounted.lifecycle()).toEqual({ mounts: 2, cleanups: 0 })
  })
})
