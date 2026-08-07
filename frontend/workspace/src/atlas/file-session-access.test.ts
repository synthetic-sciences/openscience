import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("session-scoped file requests", () => {
  test("threads the active session through listing, explorer, preview, save, and download requests", () => {
    const explorer = read("./FileExplorer.tsx")
    const pane = read("./FilesPane.tsx")
    const preview = read("./FilePreview.tsx")

    expect(explorer).toContain('const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)')
    expect(explorer).toContain("readAccess(sdk.request, current)")
    expect(explorer).toContain("grantAccess(sdk.request, current, {")
    // The Files pane owns the listing now: without this the server lists the
    // project root instead of the session workspace (File.list falls back to
    // Instance.directory when no sessionID is supplied).
    expect(pane).toContain('params.id && params.id !== "new" ? params.id : undefined')
    expect(pane).toContain("if (session) query.sessionID = session")
    expect(pane).toContain('transport("/file", undefined, query)')
    expect(preview).toContain('const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)')
    expect(preview).toContain("sdk.client.file.read({ path, sessionID: sessionID() })")
    expect(preview).toContain("body: JSON.stringify({ path, content, sessionID: session })")
    expect(preview).toContain("sessionID: session,")
  })

  test("threads the session through scientific inspection and artifact provenance", () => {
    const binary = read("../science/formats/BinaryScienceView.tsx")
    const inspector = read("../artifacts/ArtifactInspector.tsx")
    const manuscript = read("../manuscript/ManuscriptWorkbench.tsx")

    expect(binary).toContain("sessionID?: string")
    expect(binary).toContain('sdk.request("/file/inspect", undefined, { path, sessionID })')
    expect(inspector).toContain("sdk.request(route, undefined, query(path))")
    expect(inspector).toContain('read("/file/provenance", current.path)')
    expect(manuscript).toContain('sdk.request("/file/content", undefined, query(path))')
    expect(manuscript).toContain('sdk.request.url("/file/raw", query(path))')
  })
})
