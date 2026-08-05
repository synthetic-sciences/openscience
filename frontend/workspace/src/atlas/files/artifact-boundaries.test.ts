import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

/**
 * The harness the whole-branch review said was missing.
 *
 * Every other suite mounts a component bare. Production mounts the pane inside
 * RightPane's <Suspense> and the workspace's only <ErrorBoundary>, and three
 * defects lived exactly there: a thumbnail's resource suspended the entire right
 * pane, a toolbar click re-read every artifact, and a synchronously-throwing
 * read escaped into the boundary. None of them can fail a bare mount.
 */
const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
// Loaded one at a time on purpose: racing ssrLoadModule calls has produced a
// second solid-js instance in this repo before, which silently weakens whatever
// the test then asserts.
const thumb = (await server.ssrLoadModule("/src/atlas/files/ArtifactThumb.tsx")) as typeof import("./ArtifactThumb")
const grid = (await server.ssrLoadModule("/src/atlas/files/ArtifactGrid.tsx")) as typeof import("./ArtifactGrid")
const fixture = (await server.ssrLoadModule(
  "/src/atlas/files/artifact-boundary-fixture.tsx",
)) as typeof import("./artifact-boundary-fixture")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
  globalThis.localStorage?.clear()
})

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** Mounts inside the same two boundaries RightPane.tsx:351 puts the pane in. */
const mountGuarded = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => fixture.Guarded({ view }), host))
  return host
}

const artifact = (over: { id?: string; filename: string; session?: string; createdAt?: number }) =>
  ({
    schemaVersion: 1,
    id: over.id ?? `art_${over.filename}`,
    projectID: "prj_1",
    title: over.filename,
    kind: "file",
    currentVersionID: "ver_1",
    createdAt: over.createdAt ?? 0,
    updatedAt: 0,
    state: "active",
    versionCount: 1,
    current: {
      id: "ver_1",
      artifactID: over.id ?? `art_${over.filename}`,
      version: 1,
      filename: over.filename,
      mimeType: "application/octet-stream",
      size: 100,
      sha256: "abc",
      sessionID: over.session ?? "ses_1",
      sourcePath: `/tmp/${over.filename}`,
      captureQuality: "exact",
      createdAt: 0,
    },
  }) as never

describe("artifact grid inside the app's boundaries", () => {
  // A pending thumbnail must not suspend anything above it: RightPane's Suspense
  // fallback replaces the whole pane, tabs included.
  test("never replaces the pane with the suspense fallback while bytes load", async () => {
    let release: (value: string) => void = () => {}
    const host = mountGuarded(() =>
      thumb.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        url: () => "",
        read: () => new Promise<string>((resolve) => (release = resolve)),
        highlight: async (code: string) => code,
      }),
    )
    await settle()

    expect(host.textContent).not.toContain("PANE-REPLACED-BY-SPINNER")

    release("import numpy")
    await settle()

    expect(host.textContent).toContain("import numpy")
  })

  // sdk.request is a plain function that throws rather than rejecting when no
  // project is open, and a thrown read reached the boundary.
  test("degrades to the chip when the read throws rather than rejects", async () => {
    const host = mountGuarded(() =>
      thumb.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        url: () => "",
        read: () => {
          throw new Error("no project")
        },
      }),
    )
    await settle()

    expect(host.textContent).not.toContain("BOUNDARY-CAUGHT")
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("py")
  })

  test("degrades to the chip when the read rejects", async () => {
    const host = mountGuarded(() =>
      thumb.ArtifactThumb({
        artifact: artifact({ filename: "notes.md" }),
        url: () => "",
        read: async () => {
          throw new Error("gone")
        },
      }),
    )
    await settle()

    expect(host.textContent).not.toContain("BOUNDARY-CAUGHT")
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("md")
  })

  // Toggling layout or file sizes changes neither the grouping nor the bytes, so
  // it must not re-read a single artifact.
  test("does not re-read artifacts when only the view changes", async () => {
    let reads = 0
    const host = mountGuarded(() =>
      grid.ArtifactGrid({
        artifacts: [
          artifact({ id: "art_a", filename: "a.py", session: "ses_1", createdAt: 20 }),
          artifact({ id: "art_b", filename: "b.py", session: "ses_2", createdAt: 10 }),
        ],
        titles: new Map(),
        currentSession: undefined,
        url: () => "",
        read: async () => {
          reads += 1
          return "import numpy"
        },
        highlight: async (code: string) => code,
        onOpen: () => {},
        onRename: () => {},
        onTrash: () => {},
      } as never),
    )
    await settle(120)
    const afterMount = reads

    host.querySelector<HTMLButtonElement>("[data-artifact-layout='list']")!.click()
    await settle(120)
    host.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()
    host.querySelector<HTMLButtonElement>("[data-pref='sizes']")!.click()
    await settle(120)

    expect(afterMount).toBe(2)
    expect(reads).toBe(afterMount)
    expect(host.textContent).not.toContain("PANE-REPLACED-BY-SPINNER")
    expect(host.textContent).not.toContain("BOUNDARY-CAUGHT")
  })

  // readView runs during render; a storage getter that throws would otherwise
  // take the workspace down with it.
  test("survives a localStorage getter that throws during render", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked")
      },
    })
    try {
      const host = mountGuarded(() =>
        grid.ArtifactGrid({
          artifacts: [],
          titles: new Map(),
          currentSession: undefined,
          url: () => "",
          read: async () => "",
          onOpen: () => {},
          onRename: () => {},
          onTrash: () => {},
        } as never),
      )
      await settle()

      expect(host.textContent).not.toContain("BOUNDARY-CAUGHT")
      expect(host.textContent).toContain("No artifacts saved yet.")
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original)
    }
  })
})
