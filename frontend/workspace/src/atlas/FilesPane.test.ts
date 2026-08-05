import { afterAll, afterEach, describe, expect, test } from "bun:test"
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
// Sequential, not Promise.all: concurrent ssrLoadModule entries can each race
// into evaluating solid-js, and a second instance gives ErrorBoundary below a
// null Owner ("computations created outside a createRoot"), which quietly
// neuters the boundary assertion.
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await server.ssrLoadModule("/src/atlas/FilesPane.tsx")) as typeof import("./FilesPane")
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

// GET /file returns a bare array body (backend/cli/src/server/routes/file.ts:158-182),
// never a {data} wrapper — that shape belongs only to the generated client's
// RequestResult, which this pane's transport never touches.
const listing = (rows: unknown[]) =>
  new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } })

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

// A record shaped exactly as normalizeStoredArtifact demands — anything looser
// is dropped on the floor and the trash view would look empty for the wrong
// reason.
const trashed = (id: string, title: string) => ({
  schemaVersion: 1,
  id,
  projectID: "prj_1",
  title,
  kind: "notebook",
  currentVersionID: `av_${id}`,
  createdAt: 1,
  updatedAt: 2,
  state: "trash",
  trashedAt: 3,
  versionCount: 2,
  current: {
    id: `av_${id}`,
    artifactID: id,
    version: 2,
    filename: title,
    mimeType: "text/plain",
    size: 12,
    sha256: "abc",
    sessionID: "ses_1",
    sourcePath: `/p/${title}`,
    captureQuality: "exact",
    createdAt: 2,
  },
})

describe("files pane", () => {
  test("renders the tab strip, the picker and a table", async () => {
    const host = mount(() =>
      subject.FilesPane({
        request: async () => listing([{ name: "train_lr.py", type: "file", size: 2534 }]),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.querySelector('[data-tab="files"]')).not.toBeNull()
    expect(host.querySelector("[data-source-button]")).not.toBeNull()
    expect(host.querySelector(".files-table")).not.toBeNull()
    expect(host.querySelectorAll("[data-file-row]").length).toBe(1)
    expect(host.querySelector("[data-file-name]")?.textContent).toBe("train_lr.py")
  })

  test("a failed listing degrades in place instead of throwing to the boundary", async () => {
    // The pane must not reach the app-wide ErrorBoundary. Mount it inside a real
    // one and assert the fallback never renders — reading an errored resource
    // during render is what would trip it.
    const host = mount(() =>
      web.createComponent(solidjs.ErrorBoundary, {
        fallback: () => {
          const marker = document.createElement("p")
          marker.dataset.boundary = "caught"
          return marker
        },
        get children() {
          return subject.FilesPane({ request: async () => new Response("nope", { status: 503 }) })
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(host.textContent).toContain("could not be read")
    expect(host.querySelector(".files-table")).not.toBeNull()
  })

  test("reaches trashed artifacts from the source menu and restores one", async () => {
    const calls: Array<{ path: string; method?: string }> = []
    const store = { trashed: true }
    const host = mount(() =>
      subject.FilesPane({
        request: async (path, init) => {
          calls.push({ path, method: init?.method })
          if (path.includes("/restore")) {
            store.trashed = false
            return listing([])
          }
          if (path.startsWith("/file/artifact-store?state=trash"))
            return listing(store.trashed ? [trashed("art_1", "peak_fit.ipynb")] : [])
          if (path.startsWith("/file/artifact-store")) return listing([])
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="trash"]')?.click()
    await settle()

    expect(host.querySelector("[data-trash-list]")).not.toBeNull()
    expect(host.querySelector('[data-trash-row="art_1"] [data-trash-name]')?.textContent).toBe("peak_fit.ipynb")
    expect(host.textContent).toContain("recoverable for 30 days")

    host.querySelector<HTMLButtonElement>('[data-trash-restore="art_1"]')?.click()
    await settle()

    expect(calls).toContainEqual({ path: "/file/artifact-store/art_1/restore", method: "POST" })
    expect(host.querySelector('[data-trash-row="art_1"]')).toBeNull()
  })
})
