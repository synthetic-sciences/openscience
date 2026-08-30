import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("session-scoped file requests", () => {
  test("threads the active session through listing, explorer, preview, save, and download requests", () => {
    const explorer = read("./FileExplorer.tsx")
    const pane = read("./FilesPane.tsx")
    const preview = read("./FilePreview.tsx")

    expect(explorer).toContain("props.file.sessionID")
    expect(explorer).toContain("sessionID={sessionID()}")
    expect(explorer).toContain("readAccess(sdk.request, current)")
    expect(explorer).toContain("grantAccess(sdk.request, current, {")
    // The Files pane owns the listing now: without this the server lists the
    // project root instead of the session workspace (File.list falls back to
    // Instance.directory when no sessionID is supplied).
    expect(pane).toContain('params.id && params.id !== "new" ? params.id : undefined')
    expect(pane).toContain("const query = fileListQuery(kind, target, session)")
    expect(pane).toContain('transport("/file", { signal: ticket.controller.signal }, query)')
    expect(preview).toContain("const activeSessionID = () =>")
    expect(preview).toContain("const activeSession = fileSessionID()")
    expect(preview).toContain('resolvedScope() === "session"')
    expect(preview).toContain("missingFileFallback({")
    expect(preview).toContain('"/file/resolve"')
    expect(preview).toContain("{ path: reference, sessionID: session }")
    expect(preview).toContain("setResolvedPath(resolved.path)")
    expect(preview).toContain("setResolvedWritable(resolved.writable)")
    expect(preview).toMatch(/sdk\.client\.file\.read\([\s\S]*?\{ path, sessionID: activeSession \}/)
    expect(preview).toContain("{ signal: ticket.controller.signal }")
    expect(preview).toContain("body: JSON.stringify({ path, content, sessionID: session })")
    expect(preview).toContain("sessionID: session,")
    expect(preview).toContain("sessionID={fileSessionID()}")
    expect(preview).toContain("scope={resolvedScope()}")
  })

  test("threads the session through scientific inspection and artifact provenance", () => {
    const binary = read("../science/formats/BinaryScienceView.tsx")
    const inspector = read("../artifacts/ArtifactInspector.tsx")
    const manuscript = read("../manuscript/ManuscriptWorkbench.tsx")

    expect(binary).toContain("sessionID?: string")
    expect(binary).toContain('sdk.request("/file/inspect", undefined, { path, sessionID })')
    expect(inspector).toContain("sdk.request(route, undefined, query(path))")
    expect(inspector).toContain('read("/file/provenance", current.path)')
    expect(manuscript).toContain('sdk.request("/file/artifacts", undefined, query())')
    expect(manuscript).toContain("sessionID: props.sessionID")
    expect(manuscript).toContain("scope: props.scope")
    expect(manuscript).toContain('sdk.request("/file/content", undefined, query(path))')
    expect(manuscript).toContain('sdk.request.url("/file/raw", raw(path))')
    expect(manuscript).toContain('sdk.request.url("/file/raw", raw(figure.path))')
    expect(manuscript).toMatch(/"\/file\/publication",[\s\S]*?\n\s+query\(\),\n\s+\)/)
    expect(manuscript).toContain("scope: props.openScope ?? props.scope")
    expect(manuscript).toContain("uiStore.openFile(props.directory, target.path, target)")
    expect(manuscript).toContain("openFile(result.path)")
  })

  test("keeps project-scoped drafts stable across session navigation and blocks stale artifact saves", () => {
    const preview = read("./FilePreview.tsx")

    expect(preview).not.toContain("untrack(sessionID)")
    expect(preview).toContain("const activeSession = fileSessionID()")
    expect(preview).toContain("recoverFileDraft(")
    expect(preview).toContain("fileReadSession({")
    expect(preview).toContain("openScope={props.scope}")
    expect(preview).toMatch(/recoverFileDraft\(\s*dir,\s*props.path,\s*text,\s*props.scope,/)
    expect(preview).toMatch(/rememberFileDraft\(\s*directory\(\),\s*props.path,/)
    expect(preview).toContain("rememberFileDraft(")
    expect(preview).toContain("reconcileSavedDraft(view.draft, content, next)")
    expect(preview).toMatch(/const artifact = async \(\) => \{[\s\S]*if \(dirty\(\)\)[\s\S]*save file first/)
  })

  test("keeps shared file-cache aborts neutral and rejects stale project/session responses", () => {
    const context = read("../context/file.tsx")
    const cancel = context.indexOf("if (isFileRequestCancellation(e))")
    const visibleError = context.indexOf("draft.error = e.message", cancel)

    expect(context).toContain("fileRequestKey({ projectID: sdk.projectID, directory, sessionID: session, path })")
    expect(context).toContain("requestGeneration !== generation || requestScope() !== owner")
    expect(cancel).toBeGreaterThan(-1)
    expect(visibleError).toBeGreaterThan(cancel)
  })
})
