import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

// Loaded through vite rather than imported directly: bun resolves bare
// "solid-js" to the server build, whose createResource throws outside a
// hydration context. The browser condition is what this module runs under.
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
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const subject = (await server.ssrLoadModule("/src/artifacts/resource.ts")) as typeof import("./resource")
const { createArtifactsResource, loadStoredArtifacts, restoreStoredArtifact } = subject

afterAll(() => server.close())

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const artifact = (id: string, state: "active" | "trash") => ({
  schemaVersion: 1,
  id,
  projectID: "prj_1",
  title: `${id}.ipynb`,
  kind: "notebook",
  currentVersionID: `av_${id}`,
  createdAt: 1,
  updatedAt: 2,
  state,
  versionCount: 1,
  current: {
    id: `av_${id}`,
    artifactID: id,
    version: 1,
    filename: `${id}.ipynb`,
    mimeType: "text/plain",
    size: 4,
    sha256: "abc",
    sessionID: "ses_1",
    sourcePath: `/p/${id}.ipynb`,
    captureQuality: "exact",
    createdAt: 2,
  },
})

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

// This module is the artifact store's only live reader. It replaced an
// exported component that returned null and that nothing imported — so its
// createResource never instantiated and its openscience:artifacts-changed
// listener never registered. These tests exist so that cannot happen again
// unnoticed: delete or unwire any of it and one of them goes red.
describe("stored artifacts resource", () => {
  test("reads both halves, and one broken half does not empty the other", async () => {
    const snapshot = await loadStoredArtifacts(async (path) => {
      if (path.includes("state=trash")) return ok([artifact("art_2", "trash")])
      return new Response("boom", { status: 500 })
    })

    expect(snapshot.active).toEqual([])
    expect(snapshot.trash.map((item) => item.id)).toEqual(["art_2"])
    expect(snapshot.errors.active).toContain("Artifact store unavailable")
    expect(snapshot.errors.trash).toBeUndefined()
  })

  test("drops records the normalizer cannot vouch for instead of passing them through", async () => {
    const snapshot = await loadStoredArtifacts(async (path) => {
      if (path.includes("state=active")) return ok([artifact("art_1", "active"), { id: "art_bad", title: "no schema" }])
      return ok([])
    })

    expect(snapshot.active.map((item) => item.id)).toEqual(["art_1"])
  })

  test("refetches on openscience:artifacts-changed and stops once its owner is disposed", async () => {
    const calls: string[] = []
    const dispose = solidjs.createRoot((disposer) => {
      createArtifactsResource(async (path) => {
        calls.push(path)
        return ok([])
      })
      return disposer
    })
    await settle()
    const initial = calls.length

    expect(initial).toBe(2)

    window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
    await settle()

    expect(calls.length).toBe(initial + 2)

    dispose()
    window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
    await settle()

    expect(calls.length).toBe(initial + 2)
  })

  test("restores through the route the delete dialog's 30-day promise depends on", async () => {
    const calls: Array<{ path: string; method?: string }> = []
    await restoreStoredArtifact(async (path, init) => {
      calls.push({ path, method: init?.method })
      return ok({ id: "art_1" })
    }, "art_1")

    expect(calls).toEqual([{ path: "/file/artifact-store/art_1/restore", method: "POST" }])
  })

  test("surfaces the server's own reason when a restore fails", async () => {
    const failed = restoreStoredArtifact(async () => new Response("artifact expired", { status: 404 }), "art_1")

    expect(failed).rejects.toThrow("artifact expired")
  })
})
