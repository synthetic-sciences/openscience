import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { PaneFile } from "./FilesPane"

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
  // The pane remembers its last source; without this, whichever test ran first
  // would decide what every later one opens on.
  globalThis.localStorage?.clear()
})

/** Starts the pane on a source other than its artifacts default. */
const startOn = (id: string) => globalThis.localStorage?.setItem("openscience:files-source", id)

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

// GET /file returns a bare array body (backend/cli/src/server/routes/file.ts:158-182),
// never a {data} wrapper — that shape belongs only to the generated client's
// RequestResult, which this pane's transport never touches.
const listing = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

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

// The same record in its active state — what "All artifacts" is supposed to
// list. `size` and `sourcePath` differ from the trashed fixture so a row
// proves it read the artifact, not some other row's fields.
const saved = (id: string, title: string) => ({
  ...trashed(id, title),
  state: "active",
  trashedAt: undefined,
  current: { ...trashed(id, title).current, size: 2048, sourcePath: `/store/${title}` },
})

const DIRECTORY = "/home/keertan/proj"
const SESSION = "ses_1"

// parseFilesystemSnapshot rejects the whole payload if any field is off, so
// this mirrors the server's shape exactly.
const snapshot = (grants: unknown[]) => ({
  version: 1,
  revision: 3,
  sessionID: SESSION,
  projectID: "prj_1",
  directory: DIRECTORY,
  grants,
  enforcement: { broker: "enforced", processWrite: "workspace_only", processRead: "policy_only" },
})

const grant = (id: string, path: string, access: "read" | "write") => ({
  id,
  path,
  access,
  scope: "project",
  source: "api",
  time: { created: 1 },
})

describe("files pane", () => {
  // Artifacts are what a session produces, so the pane opens on them rather than
  // on the project tree.
  test("opens on artifacts when nothing has been picked yet", async () => {
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
          return listing([{ name: "SHOULD_NOT_APPEAR.py", type: "file", size: 1 }])
        },
      }),
    )
    await settle()

    expect(host.querySelector("[data-source-button]")?.textContent).toContain("All artifacts")
    expect(host.querySelector("[data-artifact-grid]")).not.toBeNull()
    expect(host.textContent).not.toContain("SHOULD_NOT_APPEAR.py")
  })

  test("remembers the source it was left on", async () => {
    const request = async (path: string) => {
      if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
      if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
      return listing([{ name: "train_lr.py", type: "file", size: 10 }])
    }
    const first = mount(() => subject.FilesPane({ request }))
    await settle()

    first.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    first.querySelector<HTMLButtonElement>('[data-source-item="project"]')?.click()
    await settle()
    expect(first.querySelector(".files-table")).not.toBeNull()

    cleanups.splice(0).forEach((fn) => fn())
    document.body.replaceChildren()

    const second = mount(() => subject.FilesPane({ request }))
    await settle()

    expect(second.querySelector(".files-table")).not.toBeNull()
    expect(second.querySelector("[data-artifact-grid]")).toBeNull()
  })

  // A remembered grant that was later revoked names a source that no longer
  // exists; falling back beats rendering nothing.
  test("falls back to artifacts when the remembered source is gone", async () => {
    startOn("grant_that_no_longer_exists")
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
          return listing([])
        },
      }),
    )
    await settle()

    expect(host.querySelector("[data-source-button]")?.textContent).toContain("All artifacts")
    // The store is empty in this fixture, so the surface is the empty state
    // rather than a grid container.
    expect(host.querySelector(".artifact-surface")).not.toBeNull()
    expect(host.querySelector('[data-source-item="modal"]')).toBeNull()
  })

  // #253 shipped Modal Volumes as a browsable source inside the screen this pane
  // replaced. The capability moves here rather than being lost with that screen,
  // as ONE Remote entry: an account with forty Volumes would otherwise bury
  // every local source, and AWS and GCP are due to land beside it.
  const modal = (over: { connected?: boolean; enabled?: boolean; files?: unknown[] } = {}) => {
    const calls: string[] = []
    const state = { connected: over.connected ?? true, enabled: over.enabled ?? true }
    const request = async (path: string, _init?: RequestInit, query?: Record<string, string>) => {
      calls.push(query?.path === undefined ? path : `${path}?path=${query.path}`)
      if (path === "/settings/compute")
        return listing({ providers: [{ id: "modal", connected: state.connected, enabled: state.enabled }] })
      if (path === "/settings/compute/modal/volumes") return listing([{ name: "weights" }, { name: "datasets" }])
      if (path.includes("/volumes/") && path.endsWith("/files"))
        return listing(
          over.files ?? [
            { path: "ckpt", type: "directory", size: 0 },
            { path: "notes.md", type: "file", size: 12 },
          ],
        )
      if (path.includes("/volumes/") && path.endsWith("/file")) return new Response("remote bytes", { status: 200 })
      if (path.startsWith("/file/artifact-store")) return listing([])
      return listing([])
    }
    return { calls, request, state }
  }

  const enterModal = async (host: HTMLElement) => {
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await settle()
    host.querySelector<HTMLButtonElement>('[data-source-item="modal"]')?.click()
    await settle()
  }

  test("does not ask Modal for anything until the picker is opened", async () => {
    const { calls, request } = modal()
    const host = mount(() => subject.FilesPane({ request }))
    await settle()

    expect(calls.some((path) => path.includes("compute"))).toBe(false)

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await settle()

    expect(calls).toContain("/settings/compute")
    // Opening the picker asks whether Modal is available, not what is in it.
    expect(calls).not.toContain("/settings/compute/modal/volumes")
  })

  test("offers Modal as a single Remote entry", async () => {
    const { request } = modal()
    const host = mount(() => subject.FilesPane({ request }))
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await settle()

    expect(host.querySelector('[data-source-item="modal"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-source-item^="modal:"]')).toHaveLength(0)
    expect(host.textContent).toContain("Remote")
  })

  test("offers nothing remote when Modal is connected but disabled", async () => {
    const { calls, request } = modal({ enabled: false })
    const host = mount(() => subject.FilesPane({ request }))
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await settle()

    expect(host.querySelector('[data-source-item="modal"]')).toBeNull()
    expect(calls).not.toContain("/settings/compute/modal/volumes")
  })

  // Disabling a provider in Settings has to remove its entry, not leave it
  // there until the pane is remounted.
  test("drops the Modal entry once the provider is disabled", async () => {
    const { request, state } = modal()
    const host = mount(() => subject.FilesPane({ request }))
    await settle()

    const button = () => host.querySelector<HTMLButtonElement>("[data-source-button]")!
    button().click()
    await settle()
    expect(host.querySelector('[data-source-item="modal"]')).not.toBeNull()
    button().click()

    state.enabled = false
    button().click()
    await settle()

    expect(host.querySelector('[data-source-item="modal"]')).toBeNull()
    expect(host.textContent).not.toContain("Remote")
  })

  // The entry can vanish while it is the source being browsed.
  test("falls back when the Modal source disappears from under the picker", async () => {
    const { request, state } = modal()
    const host = mount(() => subject.FilesPane({ request }))
    await settle()
    await enterModal(host)
    expect(host.querySelector("[data-source-button]")?.textContent).toContain("Modal")

    state.connected = false
    host.querySelector<HTMLButtonElement>("[data-source-button]")!.click()
    await settle()

    expect(host.querySelector("[data-source-button]")?.textContent).toContain("All artifacts")
    // The store is empty in this fixture, so the surface is the empty state
    // rather than a grid container.
    expect(host.querySelector(".artifact-surface")).not.toBeNull()
    expect(host.querySelector('[data-source-item="modal"]')).toBeNull()
  })

  test("lists the Volumes as the first level inside Modal", async () => {
    const { calls, request } = modal()
    const host = mount(() => subject.FilesPane({ request }))
    await settle()
    await enterModal(host)

    expect(calls).toContain("/settings/compute/modal/volumes")
    // Sorted by the table, as every other listing is.
    expect([...host.querySelectorAll("[data-file-name]")].map((node) => node.textContent)).toEqual([
      "datasets",
      "weights",
    ])
    // A Volume path is not this machine's path; the local listing must not run.
    expect(calls.filter((path) => path.startsWith("/file?")).length).toBe(0)
  })

  test("browses inside a Volume over the Modal API", async () => {
    const { calls, request } = modal()
    const host = mount(() => subject.FilesPane({ request }))
    await settle()
    await enterModal(host)

    host.querySelector<HTMLButtonElement>('[data-file-row="weights"]')?.click()
    await settle()

    expect(calls).toContain("/settings/compute/modal/volumes/weights/files?path=/")
    expect([...host.querySelectorAll("[data-file-name]")].map((node) => node.textContent)).toEqual(["ckpt", "notes.md"])
  })

  // A Volume file has no path on this machine, so a previewable one opens a tab
  // backed by its bytes rather than by a path.
  // A Volume listing spawns a Modal process and takes seconds. The rows still on
  // screen describe the folder being left, so clicking a second one appended its
  // name to the path the first click had already set -- asking the server for a
  // folder inside a folder that was never opened, which came back as a NOT_FOUND
  // traceback.
  test("refuses clicks on a listing that is being replaced", async () => {
    const asked: string[] = []
    let release: ((value: Response) => void) | undefined
    const request = async (path: string, _init?: RequestInit, query?: Record<string, string>) => {
      if (path === "/settings/compute") return listing({ providers: [{ id: "modal", connected: true, enabled: true }] })
      if (path === "/settings/compute/modal/volumes") return listing([{ name: "weights" }])
      if (path.includes("/volumes/") && path.endsWith("/files")) {
        asked.push(query?.path ?? "")
        // The second listing never resolves, so the pane stays mid-flight.
        if (asked.length > 1) return new Promise<Response>((resolve) => (release = resolve))
        return listing([
          { path: "alpha", type: "directory", size: 0 },
          { path: "beta", type: "directory", size: 0 },
        ])
      }
      if (path.startsWith("/file/artifact-store")) return listing([])
      return listing([])
    }
    const host = mount(() => subject.FilesPane({ request }))
    await settle()
    await enterModal(host)
    host.querySelector<HTMLButtonElement>('[data-file-row="weights"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>('[data-file-row="alpha"]')?.click()
    await settle()

    expect(host.querySelector("[data-files-loading]")).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-file-row="beta"]')?.disabled).toBe(true)

    // The click that used to produce volume/alpha/beta.
    host.querySelector<HTMLButtonElement>('[data-file-row="beta"]')?.click()
    await settle()

    expect(asked).not.toContain("/alpha/beta")
    expect(asked.at(-1)).toBe("/alpha")
    release?.(listing([]))
  })

  test("previews a Volume file of a format worth showing", async () => {
    const { calls, request } = modal({
      files: [
        { path: "notes.md", type: "file", size: 12 },
        { path: "model.safetensors", type: "file", size: 40 },
      ],
    })
    const host = mount(() => subject.FilesPane({ request }))
    await settle()
    await enterModal(host)
    host.querySelector<HTMLButtonElement>('[data-file-row="weights"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>('[data-file-row="notes.md"]')?.click()
    await settle()

    expect(host.querySelector('[data-tab="notes.md"]')).not.toBeNull()
    expect(host.querySelector("[data-remote-text]")?.textContent).toContain("remote bytes")
    expect(calls).toContain("/settings/compute/modal/volumes/weights/file?path=/notes.md")
  })

  test("downloads a Volume file it will not preview instead of opening an empty tab", async () => {
    const got: string[] = []
    const { request } = modal({
      files: [
        { path: "notes.md", type: "file", size: 12 },
        { path: "model.safetensors", type: "file", size: 40 },
      ],
    })
    const host = mount(() => subject.FilesPane({ request, onDownload: (name) => got.push(name) }))
    await settle()
    await enterModal(host)
    host.querySelector<HTMLButtonElement>('[data-file-row="weights"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>('[data-file-row="model.safetensors"]')?.click()
    await settle()

    expect(got).toEqual(["model.safetensors"])
    expect(host.querySelector('[data-tab="model.safetensors"]')).toBeNull()
  })

  test("renders the picker and table directly without a Browse tab", async () => {
    startOn("project")
    const host = mount(() =>
      subject.FilesPane({
        request: async () => listing([{ name: "train_lr.py", type: "file", size: 2534 }]),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(host.querySelector("[data-source-button]")).not.toBeNull()
    expect(host.querySelector(".files-table")).not.toBeNull()
    expect(host.querySelectorAll("[data-file-row]").length).toBe(1)
    expect(host.querySelector("[data-file-name]")?.textContent).toBe("train_lr.py")
  })

  test("clears the search box on the way back up, not only on the way down", async () => {
    startOn("project")
    // Descending cleared the filter but `..` did not, so returning to a folder
    // re-entered it with a stale query still applied and the table announced
    // "This folder is empty." over a folder that was not.
    const host = mount(() =>
      subject.FilesPane({
        request: async (_path, _init, query) =>
          query?.path?.endsWith("/data")
            ? listing([{ name: "nested.txt", type: "file", size: 24 }])
            : listing([
                { name: "data", type: "directory" },
                { name: "train.py", type: "file", size: 104 },
              ]),
        directory: DIRECTORY,
        session: SESSION,
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>('[data-file-row="data"]')?.click()
    await settle()

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = "nest"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(host.querySelectorAll("[data-file-row]").length).toBe(1)

    host.querySelector<HTMLButtonElement>("[data-file-up]")?.click()
    await settle()

    expect(search.value).toBe("")
    expect([...host.querySelectorAll("[data-file-name]")].map((node) => node.textContent)).toEqual(["data", "train.py"])
    expect(host.textContent).not.toContain("This folder is empty.")
  })

  test("a failed listing degrades in place instead of throwing to the boundary", async () => {
    startOn("project")
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

  test("lists saved artifacts under All artifacts rather than reporting an empty folder", async () => {
    // The artifacts source short-circuited to [] and fell through to the file
    // table's "This folder is empty." — so a project with artifacts in it said
    // it had none. The active half of the snapshot was already being loaded
    // for the trash view; only the rendering was missing.
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
          // A real listing would answer here; reaching it for the artifacts
          // source is the bug that mislabels project files as artifacts.
          return listing([{ name: "SHOULD_NOT_APPEAR.py", type: "file", size: 1 }])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="artifacts"]')?.click()
    await settle()

    const names = [...host.querySelectorAll("[data-card-open]")].map((node) => node.getAttribute("aria-label"))
    expect(names).toEqual(["Open peak_fit.ipynb"])
    expect(host.querySelector("[data-artifact-grid]")).not.toBeNull()
    expect(host.textContent).not.toContain("This folder is empty.")
    expect(host.textContent).not.toContain("SHOULD_NOT_APPEAR.py")
  })

  test("renders artifacts as a grid, never as file-table rows", async () => {
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="artifacts"]')?.click()
    await settle()

    expect(host.querySelector(".files-table")).toBeNull()
    expect(host.querySelector("[data-artifact-count]")?.textContent).toBe("1 artifact")
  })

  test("says no artifacts are saved rather than calling the artifact store an empty folder", async () => {
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path.startsWith("/file/artifact-store")) return listing([])
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="artifacts"]')?.click()
    await settle()

    expect(host.textContent).toContain("No artifacts saved yet.")
    expect(host.textContent).not.toContain("This folder is empty.")
  })

  // The pane used to open current.sourcePath -- the working file the bytes were
  // captured from, which keeps changing after capture and can be deleted
  // outright. A card now hands the artifact to the viewer, which reads the
  // immutable stored version instead.
  test("opens the stored artifact, not the path it was captured from", async () => {
    const opened: string[] = []
    const viewed: string[] = []
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
          return listing([])
        },
        onOpenArtifact: (artifact) => opened.push(artifact.id),
        view: (file) => {
          viewed.push(file.path)
          const node = document.createElement("p")
          node.dataset.stubView = file.path
          return node
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="artifacts"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>("[data-card-open]")?.click()
    await settle()

    expect(opened).toEqual(["art_9"])
    expect(viewed).toEqual([])
  })

  test("addresses artifact bytes by version, never by the captured source path", async () => {
    const asked: string[] = []
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          asked.push(path)
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "notes.md")])
          return listing([])
        },
        url: (path, query) => `http://local${path}?versionID=${query.versionID}`,
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="artifacts"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>("[data-card-menu]")?.click()
    const download = host.querySelector("[data-action='download']")?.getAttribute("href")

    expect(download).toContain("/file/artifact-store/art_9/raw")
    expect(download).not.toContain("/store/notes.md")
    expect(asked.some((path) => path.includes("/store/notes.md"))).toBe(false)
  })

  test("moves an artifact to trash and tells every other surface", async () => {
    const calls: Array<{ path: string; method?: string }> = []
    let changed = 0
    const listener = () => (changed += 1)
    window.addEventListener("openscience:artifacts-changed", listener)
    cleanups.push(() => window.removeEventListener("openscience:artifacts-changed", listener))

    const host = mount(() =>
      subject.FilesPane({
        request: async (path, init) => {
          calls.push({ path, method: init?.method })
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([])
          if (path.startsWith("/file/artifact-store")) return listing([saved("art_9", "peak_fit.ipynb")])
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="artifacts"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>("[data-card-menu]")?.click()
    host.querySelector<HTMLButtonElement>("[data-action='trash']")?.click()

    // Wait for the announcement, not for the request: the call is recorded the
    // moment transport is invoked, while the event fires only once the response
    // has resolved.
    for (let attempt = 0; attempt < 50 && changed === 0; attempt += 1) {
      await settle()
    }

    expect(calls).toContainEqual({ path: "/file/artifact-store/art_9", method: "DELETE" })
    expect(changed).toBeGreaterThan(0)
  })

  test("revokes a connected grant from the source menu and drops it from the snapshot", async () => {
    const calls: Array<{ path: string; method?: string }> = []
    const store = { granted: true }
    const host = mount(() =>
      subject.FilesPane({
        session: SESSION,
        directory: DIRECTORY,
        request: async (path, init) => {
          calls.push({ path, method: init?.method })
          if (path.startsWith(`/session/${SESSION}/filesystem/`)) {
            store.granted = false
            return listing([])
          }
          if (path === `/session/${SESSION}/filesystem`)
            return new Response(
              JSON.stringify(snapshot(store.granted ? [grant("fsg_1", "/home/keertan/data/pdebench", "write")] : [])),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    expect(host.querySelector('[data-source-item="fsg_1"]')?.textContent).toContain("pdebench")

    host.querySelector<HTMLElement>('[data-source-revoke="fsg_1"]')?.click()
    await settle()

    expect(calls).toContainEqual({ path: `/session/${SESSION}/filesystem/fsg_1`, method: "DELETE" })

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="fsg_1"]')).toBeNull()
    expect(host.querySelector('[data-source-item="project"]')).not.toBeNull()
  })

  test("connects a folder from the source menu with an explicit write choice", async () => {
    const posted: Array<Record<string, unknown>> = []
    const store = { granted: false }
    const host = mount(() =>
      subject.FilesPane({
        session: SESSION,
        directory: DIRECTORY,
        request: async (path, init) => {
          if (path === `/session/${SESSION}/filesystem` && init?.method === "POST") {
            posted.push(JSON.parse(String(init.body)))
            store.granted = true
            return listing([])
          }
          if (path === `/session/${SESSION}/filesystem`)
            return new Response(
              JSON.stringify(snapshot(store.granted ? [grant("fsg_9", "/home/keertan/data/pdebench", "write")] : [])),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>("[data-source-add]")?.click()

    const form = host.querySelector<HTMLFormElement>(".files-connect")
    const input = host.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!
    const access = host.querySelector<HTMLSelectElement>("[data-connect-access]")!
    expect(form).not.toBeNull()
    // Read is the default, and each choice states what it authorises.
    expect(access.value).toBe("read")
    expect(host.querySelector("[data-connect-note]")?.textContent).toContain("inspected but not changed")

    input.value = "/home/keertan/data/pdebench"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    access.value = "write"
    access.dispatchEvent(new Event("change", { bubbles: true }))

    expect(host.querySelector("[data-connect-note]")?.textContent).toContain(
      "code runtimes do not gain a writable mount",
    )

    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()

    expect(posted).toEqual([{ path: "/home/keertan/data/pdebench", access: "write", scope: "project" }])
    expect(host.querySelector("[data-connect-scope]")).toBeNull()
    expect(host.querySelector(".files-connect")).toBeNull()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="fsg_9"]')?.textContent).toContain("pdebench")
  })

  test("drops the stale listing error when the source changes to one it does not describe", async () => {
    startOn("project")
    // The folder listing fails; the artifact store answers normally. Switching
    // to Trash must not leave "this folder could not be read" over a good list.
    const host = mount(() =>
      subject.FilesPane({
        request: async (path) => {
          if (path === "/file") return new Response("nope", { status: 503 })
          if (path.startsWith("/file/artifact-store?state=trash")) return listing([trashed("art_2", "run.ipynb")])
          return listing([])
        },
      }),
    )
    await settle()

    expect(host.querySelector(".files-notice")?.textContent).toContain("could not be read")

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="trash"]')?.click()
    await settle()

    expect(host.querySelector('[data-trash-row="art_2"]')).not.toBeNull()
    expect(host.querySelector(".files-notice")).toBeNull()
  })

  test("says why a folder cannot be connected before a session exists, instead of doing nothing", async () => {
    // The landing route (/:dir/session) reaches this pane with a project but no
    // session id, and a grant is minted against a session.
    const posted: string[] = []
    const host = mount(() =>
      subject.FilesPane({
        directory: DIRECTORY,
        request: async (path, init) => {
          if (init?.method === "POST") posted.push(path)
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>("[data-source-add]")?.click()

    const input = host.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!
    input.value = "/home/keertan/data/pdebench"
    input.dispatchEvent(new Event("input", { bubbles: true }))

    const submit = host.querySelector<HTMLButtonElement>("[data-connect-submit]")!
    expect(submit.disabled).toBe(true)
    expect(host.querySelector("[data-connect-blocked]")?.textContent).toContain("has not started yet")

    // Enter in the path field submits past the disabled button — the reason
    // must reach the user there too.
    host
      .querySelector<HTMLFormElement>(".files-connect")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()

    expect(posted).toEqual([])
    expect(host.querySelector(".files-notice")?.textContent).toContain("has not started yet")
  })

  test("opening a file swaps the browser for the file itself and closing swaps it back", async () => {
    startOn("project")
    const host = mount(() =>
      subject.FilesPane({
        directory: DIRECTORY,
        request: async () => listing([{ name: "train_lr.py", type: "file", size: 10, path: "src/train_lr.py" }]),
        view: (file) => {
          const node = document.createElement("p")
          node.dataset.stubView = file.path
          return node
        },
      }),
    )
    await settle()

    expect(host.querySelector(".files-table")).not.toBeNull()

    host.querySelector<HTMLButtonElement>('[data-file-row="train_lr.py"]')?.click()

    // The tab is not just added — it becomes the pane's content.
    expect(host.querySelector('[data-tab="train_lr.py"]')?.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector("[data-stub-view]")?.getAttribute("data-stub-view")).toBe("src/train_lr.py")
    expect(host.querySelector(".files-table")).toBeNull()
    expect(host.querySelector("[data-source-button]")).toBeNull()

    host.querySelector<HTMLElement>('[data-tab-close="train_lr.py"]')?.click()

    expect(host.querySelector("[data-stub-view]")).toBeNull()
    expect(host.querySelector('[data-tab="train_lr.py"]')).toBeNull()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(host.querySelector(".files-table")).not.toBeNull()
  })

  test("a tab keeps the source it was opened from, not whichever one is selected later", async () => {
    // writable/subtitle used to read the picker's *current* source, so a file
    // opened from a read-only grant became editable the moment the picker moved
    // on — the read/write boundary followed the menu instead of the file.
    const seen: PaneFile[] = []
    const host = mount(() =>
      subject.FilesPane({
        session: SESSION,
        directory: DIRECTORY,
        request: async (path) => {
          if (path === `/session/${SESSION}/filesystem`)
            return new Response(JSON.stringify(snapshot([grant("fsg_1", "/home/keertan/data/pdebench", "read")])), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          return listing([
            { name: "inputs.csv", type: "file", size: 4, path: "/home/keertan/data/pdebench/inputs.csv" },
          ])
        },
        view: (file) => {
          seen.push(file as PaneFile)
          return document.createElement("p")
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="fsg_1"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>('[data-file-row="inputs.csv"]')?.click()
    await settle()

    expect(seen.at(-1)).toMatchObject({ name: "inputs.csv", source: "pdebench", readonly: true })

    // Back to the browser, move the picker to the project, then return to the tab.
    host.querySelector<HTMLButtonElement>('[data-tab="files"]')?.click()
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="project"]')?.click()
    await settle()
    host.querySelector<HTMLButtonElement>('[data-tab="inputs.csv"]')?.click()
    await settle()

    expect(seen.at(-1)).toMatchObject({ source: "pdebench", readonly: true })
  })

  test("keeps the picked source marked after the grant snapshot rebuilds the list", async () => {
    // `sources()` is a memo: every snapshot refetch hands back fresh objects, so
    // a selection remembered as an object stopped matching the rows the menu
    // renders — the ✓ and aria-checked vanished from the source being browsed.
    const store = { granted: false }
    const host = mount(() =>
      subject.FilesPane({
        session: SESSION,
        directory: DIRECTORY,
        request: async (path, init) => {
          if (path === `/session/${SESSION}/filesystem` && init?.method === "POST") {
            store.granted = true
            return listing([])
          }
          if (path === `/session/${SESSION}/filesystem`)
            return new Response(
              JSON.stringify(snapshot(store.granted ? [grant("fsg_2", "/home/keertan/data/pdebench", "read")] : [])),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          return listing([])
        },
      }),
    )
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="trash"]')?.click()
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    expect(host.querySelector('[data-source-item="trash"]')?.getAttribute("aria-checked")).toBe("true")
    host.querySelector<HTMLButtonElement>("[data-source-add]")?.click()

    const input = host.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!
    input.value = "/home/keertan/data/pdebench"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    host
      .querySelector<HTMLFormElement>(".files-connect")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="fsg_2"]')).not.toBeNull()
    expect(host.querySelector('[data-source-item="trash"]')?.getAttribute("aria-checked")).toBe("true")
    expect(host.querySelector("[data-trash-list]")).not.toBeNull()
  })

  test("wires Browse… through the dialog host to the FolderPicker and back into the path field", () => {
    // A source-text guard, and a weaker one than a mount: it pins that the wire
    // is written, not that clicking Browse… produces a picker. A mount cannot
    // reach this path at all, verified by probe rather than assumed:
    //   - the standalone seam leaves `dialog` undefined, so <Show when={dialog}>
    //     never renders the Browse… button (the connect form does render);
    //   - dropping the seam to get a real dialog throws "SDK context must be
    //     used within a context provider" before the pane mounts;
    //   - mounting FolderPicker directly throws "GlobalSDK context must be used
    //     within a context provider".
    // Rendering it for real needs SDK, sync, router, dialog, global-SDK and
    // global-sync providers plus a server to walk. A refactor that severs any
    // link below would pass every behavioural test in this file, which is
    // exactly why this exists.
    const source = readFileSync(fileURLToPath(new URL("./FilesPane.tsx", import.meta.url)), "utf8")

    expect(source).toContain('import { FolderPicker } from "@/atlas/FolderPicker"')
    expect(source).toContain("dialog?.show(")
    expect(source).toContain("<FolderPicker")
    expect(source).toContain('kind="folder"')
    // The picker answers with one path or several; either way one lands in the
    // same store field the path input renders.
    expect(source).toContain("const picked = Array.isArray(result) ? result[0] : result")
    expect(source).toContain('if (picked) setConnect("path", picked)')
    expect(source).toContain("onClick={browse}")
    expect(source).toContain("value={connect.path}")
  })

  test("mounts the real FileView for the active tab when nothing overrides it", () => {
    // The `view` seam above can only prove the switch, not what production
    // renders through it. This guards the default the seam falls back to.
    const source = readFileSync(fileURLToPath(new URL("./FilesPane.tsx", import.meta.url)), "utf8")

    expect(source).toContain('import { FileView } from "@/atlas/FilePreview"')
    expect(source).toContain("props.view?.(file) ?? (")
    expect(source).toContain("<FileView")
    expect(source).toContain("path={file.path}")
    expect(source).toContain("onClose={() => closeTab(file.name)}")
  })
})
