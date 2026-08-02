import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { StoredArtifact } from "@/artifacts/store"
import type { FilesystemGrant } from "@/atlas/file-sources"

const server = await createServer({
  root: new URL("../..", import.meta.url).pathname,
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
  server.ssrLoadModule("/src/atlas/FileExplorer.tsx") as Promise<typeof import("./FileExplorer")>,
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

const grants: FilesystemGrant[] = [
  {
    id: "fsg_read",
    path: "/Users/aayam/private/inputs",
    access: "read",
    scope: "session",
    source: "api",
    time: { created: 1 },
  },
  {
    id: "fsg_publish",
    path: "/Volumes/lab/publication",
    access: "write",
    scope: "project",
    source: "permission",
    time: { created: 2 },
  },
]

const artifacts: StoredArtifact[] = [
  {
    schemaVersion: 1,
    id: "art_results",
    projectID: "project_test",
    title: "results.csv",
    kind: "dataset",
    currentVersionID: "ver_results",
    createdAt: 2,
    updatedAt: 3,
    state: "active",
    versionCount: 1,
    current: {
      id: "ver_results",
      artifactID: "art_results",
      version: 1,
      filename: "results.csv",
      mimeType: "text/csv",
      size: 1200,
      sha256: "a".repeat(64),
      sessionID: "ses_test",
      sourcePath: "private/results/results.csv",
      captureQuality: "declared",
      createdAt: 3,
    },
  },
]

const setup = (
  options: {
    onRevoke?: (grant: FilesystemGrant) => void
    onConnect?: (input: {
      path: string
      access: "read" | "write"
      scope: "once" | "session" | "project" | "installation"
    }) => void
    trash?: StoredArtifact[]
    onRestoreArtifact?: (artifact: StoredArtifact) => void
    onChoose?: (kind: "folder" | "file") => Promise<string | undefined>
  } = {},
) =>
  mount(() =>
    subject.FilesSourceList({
      artifacts,
      trash: options.trash ?? [],
      grants,
      projectRoot: "/Users/aayam/kras-speedrun",
      sessionReady: true,
      onOpenProject: () => {},
      onOpenSession: () => {},
      onOpenArtifact: () => {},
      onInspectArtifact: () => {},
      onRestoreArtifact: options.onRestoreArtifact ?? (() => {}),
      onOpenGrant: () => {},
      onRevoke: options.onRevoke ?? (() => {}),
      onConnect: options.onConnect ?? (() => {}),
      onChoose: options.onChoose,
    }),
  )

describe("Files sources", () => {
  test("renders accessible source groups without exposing host paths as product identity", () => {
    const host = setup()

    expect(host.querySelector('[aria-label="Files sources"]')).not.toBeNull()
    expect(host.querySelector("#workspace-locations-heading")?.textContent).toContain("Workspace")
    expect(host.textContent).toContain("Local and session files")
    expect(host.querySelector("#artifacts-heading")?.textContent).toBe("Artifacts")
    expect(host.querySelector("#connected-locations-heading")?.textContent).toBe("Connected locations")
    expect(host.querySelectorAll("section")).toHaveLength(3)
    expect(host.textContent).toContain("kras-speedrun")
    expect(host.textContent).toContain("Session workspace")
    expect(host.textContent).toContain("results.csv")
    expect(host.textContent).toContain("inputs")
    expect(host.textContent).toContain("publication")
    expect(host.textContent).not.toContain("/Users/aayam")
    expect(host.textContent).not.toContain("/Volumes/lab")
    expect(host.textContent).not.toContain("private/results/results.csv")
    expect(host.textContent).not.toContain("This computer")
  })

  test("distinguishes read-only and read-write roles, exposes scope, and revokes the selected grant", () => {
    const revoked: string[] = []
    const host = setup({ onRevoke: (grant) => revoked.push(grant.id) })

    expect(host.textContent).toContain("Read only")
    expect(host.textContent).toContain("Read & write")
    expect(host.textContent).toContain("This session")
    expect(host.textContent).toContain("This project")
    expect(host.textContent).toContain("code runtimes do not gain a writable mount")

    const revoke = host.querySelector<HTMLButtonElement>('[aria-label="Revoke read & write access to publication"]')
    revoke?.click()
    expect(revoked).toEqual(["fsg_publish"])
  })

  test("makes file and folder access an explicit role-and-scope request", async () => {
    const requests: Array<{
      path: string
      access: "read" | "write"
      scope: "once" | "session" | "project" | "installation"
    }> = []
    const picks: string[] = []
    const host = setup({
      onConnect: (input) => requests.push(input),
      onChoose: async (kind) => {
        picks.push(kind)
        return kind === "folder" ? "/outside/lab" : "/outside/lab/data.csv"
      },
    })
    host.querySelector<HTMLButtonElement>('[aria-label="Connect another location"]')?.click()

    const form = host.querySelector<HTMLFormElement>('[aria-label="Connect file or folder access"]')
    const path = form?.querySelector<HTMLInputElement>('input[name="path"]')
    expect(form).not.toBeNull()
    expect(form?.querySelector('[aria-label="Location access"]')?.textContent).toContain("Read only")
    expect(form?.querySelector('[aria-label="Location access duration"]')?.textContent).toContain("This session")
    expect(form?.querySelector('[aria-label="Choose folder"]')).not.toBeNull()
    expect(form?.querySelector('[aria-label="Choose file"]')).not.toBeNull()

    form?.querySelector<HTMLButtonElement>('[aria-label="Choose folder"]')?.click()
    await Promise.resolve()
    expect(path?.value).toBe("/outside/lab")
    expect(picks).toEqual(["folder"])
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))

    expect(requests).toEqual([{ path: "/outside/lab", access: "read", scope: "session" }])
  })

  test("shows trashed artifacts as recoverable for 30 days", () => {
    const restored: string[] = []
    const item: StoredArtifact = {
      ...artifacts[0]!,
      id: "art_trash",
      title: "recoverable.csv",
      state: "trash",
      trashedAt: Date.now(),
    }
    const host = setup({ trash: [item], onRestoreArtifact: (artifact) => restored.push(artifact.id) })

    expect(host.querySelector('[aria-label="Artifact trash"]')?.textContent).toContain("retained 30 days")
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Restore artifact recoverable.csv"]')
    button?.click()
    expect(restored).toEqual(["art_trash"])
  })
})
