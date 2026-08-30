import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { StoredArtifactVersion } from "./store"
import type { ArtifactPreviewSource } from "./preview"

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
const subject = (await server.ssrLoadModule("/src/artifacts/preview.ts")) as typeof import("./preview")
afterAll(() => server.close())
const version = (id = "ver_1"): StoredArtifactVersion => ({
  id,
  artifactID: "art_1",
  version: 1,
  filename: "report.md",
  mimeType: "text/markdown",
  size: 8,
  sha256: "abc",
  sessionID: "ses_1",
  sourcePath: "/captured/report.md",
  captureQuality: "exact",
  createdAt: 0,
})
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe("saved artifact preview ownership", () => {
  test("opens a document once without aborting its request after mounting", async () => {
    const signals: AbortSignal[] = []
    const owner = solidjs.createRoot((dispose) => {
      const [preview] = subject.createStoredArtifactPreview(
        async (path, init) => {
          signals.push(init!.signal!)
          return new Response("# Report")
        },
        () => ({ scope: "project_1", artifactID: "art_1", version: version() }),
      )
      return { preview, dispose }
    })
    try {
      await settle()
      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(false)
      expect(owner.preview.error).toBeUndefined()
      expect(owner.preview.latest?.data).toEqual({ kind: "text", data: "# Report" })
    } finally {
      owner.dispose()
    }
    expect(signals[0].aborted).toBe(true)
  })

  test("cancels old bytes while the next record loads and rejects late results", async () => {
    const old = Promise.withResolvers<Response>()
    const signals: AbortSignal[] = []
    const owner = solidjs.createRoot((dispose) => {
      const [source, setSource] = solidjs.createSignal<ArtifactPreviewSource>({
        scope: "project_1",
        artifactID: "art_1",
        version: version(),
      })
      const [preview] = subject.createStoredArtifactPreview(async (path, init) => {
        signals.push(init!.signal!)
        return signals.length === 1 ? old.promise : new Response("new document")
      }, source)
      return { preview, setSource, dispose }
    })
    try {
      await settle()
      owner.setSource({ scope: "project_2", artifactID: "art_2" })
      await settle()
      expect(signals[0].aborted).toBe(true)
      owner.setSource({ scope: "project_2", artifactID: "art_2", version: version("ver_2") })
      await settle()
      old.resolve(new Response("old document"))
      await settle()
      expect(owner.preview.latest).toEqual({
        scope: "project_2",
        artifactID: "art_2",
        versionID: "ver_2",
        data: { kind: "text", data: "new document" },
      })
    } finally {
      owner.dispose()
      old.resolve(new Response("disposed"))
    }
  })

  test("quietly retries a transient transport abort without changing identity", async () => {
    let calls = 0
    const owner = solidjs.createRoot((dispose) => {
      const [preview] = subject.createStoredArtifactPreview(
        async () => {
          calls += 1
          if (calls === 1) throw new DOMException("signal is aborted without reason", "AbortError")
          return new Response("recovered")
        },
        () => ({ scope: "project_1", artifactID: "art_1", version: version() }),
      )
      return { preview, dispose }
    })
    try {
      await settle(220)
      expect(calls).toBe(2)
      expect(owner.preview.error).toBeUndefined()
      expect(owner.preview.latest?.data).toEqual({ kind: "text", data: "recovered" })
    } finally {
      owner.dispose()
    }
  })

  test("leaves access denials visible and supports an explicit retry", async () => {
    let calls = 0
    const owner = solidjs.createRoot((dispose) => {
      const [preview, actions] = subject.createStoredArtifactPreview(
        async () => {
          calls += 1
          return calls === 1 ? new Response("Access denied", { status: 403 }) : new Response("available")
        },
        () => ({ scope: "project_1", artifactID: "art_1", version: version() }),
      )
      return { preview, actions, dispose }
    })
    try {
      await settle()
      expect(calls).toBe(1)
      expect(owner.preview.error?.message).toBe("Access denied")
      await owner.actions.refetch()
      expect(calls).toBe(2)
      expect(owner.preview.latest?.data).toEqual({ kind: "text", data: "available" })
    } finally {
      owner.dispose()
    }
  })
})
