import { describe, expect, test } from "bun:test"
import {
  artifactControl,
  createFileRequestOwner,
  describeFile,
  fileRequestKey,
  fileReadRetryDelay,
  fileErrorMessage,
  initialFileScope,
  fileReadSession,
  linkedFileTarget,
  isMissingFileError,
  missingFileFallback,
  PDF_PREVIEW_LIMIT,
  pdfPreviewMode,
  readFile,
  reconcileSavedDraft,
  sourceViews,
  toolbarControls,
} from "./file-viewer"

describe("file viewer capabilities", () => {
  test("describes rendered documents and data with plain file types", () => {
    expect(describeFile({ kind: "markdown", format: "md" })).toEqual({
      label: "Markdown",
      source: true,
      copy: true,
      download: true,
    })
    expect(describeFile({ kind: "pdf", format: "pdf", binary: true })).toEqual({
      label: "PDF document",
      source: false,
      copy: false,
      download: true,
    })
    expect(describeFile({ kind: "image", format: "png", binary: true })).toEqual({
      label: "PNG image",
      source: false,
      copy: false,
      download: true,
    })
    expect(describeFile({ kind: "code", format: "ipynb" }).label).toBe("IPYNB source")
    expect(describeFile({ kind: "table", format: "csv" }).label).toBe("CSV data")
    expect(describeFile({ kind: "scientific-data", format: "fastq" }).label).toBe("FASTQ data")
  })

  test("keeps unsupported and partial files honest about available actions", () => {
    expect(describeFile({ kind: "binary", format: "bin", binary: true })).toEqual({
      label: "Binary file",
      source: false,
      copy: false,
      download: true,
    })
    expect(describeFile({ kind: "markdown", format: "md", truncated: true })).toEqual({
      label: "Markdown",
      source: false,
      copy: false,
      download: true,
    })
  })

  test("exposes Preview and Source as an explicit two-state control", () => {
    expect(sourceViews(false)).toEqual([
      { id: "preview", label: "Preview", active: true },
      { id: "source", label: "Source", active: false },
    ])
    expect(sourceViews(true)).toEqual([
      { id: "preview", label: "Preview", active: false },
      { id: "source", label: "Source", active: true },
    ])
  })

  test("builds explicit toolbar controls from backed capabilities", () => {
    const description = describeFile({ kind: "markdown", format: "md" })

    expect(toolbarControls({ description, source: false, dirty: false, saving: false })).toEqual([
      { id: "preview", label: "Preview", active: true, disabled: false },
      { id: "source", label: "Source", active: false, disabled: false },
      { id: "copy", label: "Copy", disabled: false },
      { id: "download", label: "Download", disabled: false },
    ])
    expect(toolbarControls({ description, source: true, dirty: true, saving: true })).toEqual([
      { id: "preview", label: "Preview", active: false, disabled: false },
      { id: "source", label: "Source", active: true, disabled: false },
      { id: "discard", label: "Discard", disabled: true },
      { id: "save", label: "Saving…", disabled: true },
      { id: "copy", label: "Copy", disabled: false },
      { id: "download", label: "Download", disabled: false },
    ])
  })

  test("labels the plain write 'Save file' so it cannot be read as the artifact save", () => {
    const description = describeFile({ kind: "markdown", format: "md" })
    const controls = toolbarControls({ description, source: true, dirty: true, saving: false })

    expect(controls.find((control) => control.id === "save")).toEqual({
      id: "save",
      label: "Save file",
      disabled: false,
    })
  })

  test("offers Save as Result only when a session is in scope", () => {
    expect(artifactControl({ session: false, busy: false, dirty: false })).toBeUndefined()
    expect(artifactControl({ session: true, busy: false, dirty: false })).toEqual({
      id: "artifact",
      label: "Save as Result",
      disabled: false,
    })
    expect(artifactControl({ session: true, busy: true, dirty: false })).toEqual({
      id: "artifact",
      label: "Saving result…",
      disabled: true,
    })
    expect(artifactControl({ session: true, busy: false, dirty: true })).toEqual({
      id: "artifact",
      label: "Save file first",
      disabled: true,
    })
  })

  test("preserves edits typed while an earlier save is in flight", () => {
    expect(reconcileSavedDraft("second edit", "first edit", "first edit")).toEqual({
      draft: "second edit",
      saved: "first edit",
    })
    expect(reconcileSavedDraft("first edit", "first edit", "normalized first edit")).toEqual({
      draft: "normalized first edit",
      saved: "normalized first edit",
    })
  })

  test("does not build source or copy controls for unsupported binaries", () => {
    const description = describeFile({ kind: "binary", format: "bin", binary: true })

    expect(toolbarControls({ description, source: false, dirty: false, saving: false })).toEqual([
      { id: "download", label: "Download", disabled: false },
    ])
  })
})

describe("file viewer reads", () => {
  test("resolves ambiguous chat links from session scratch before durable project files", () => {
    expect(initialFileScope("auto")).toBe("session")
    expect(
      missingFileFallback({ requested: "auto", resolved: "session", error: new Error("File not found: result.csv") }),
    ).toBe("project")
    expect(
      missingFileFallback({ requested: "auto", resolved: "session", error: new Error("Project file access denied") }),
    ).toBeUndefined()
    expect(
      missingFileFallback({ requested: "session", resolved: "session", error: new Error("File not found") }),
    ).toBeUndefined()
    expect(isMissingFileError(new Error("ENOENT: no such file or directory"))).toBe(true)
    expect(isMissingFileError(new Error("Project file access denied"))).toBe(false)
  })

  test("uses explicit project locations directly while keeping scratch and external links session-authorized", () => {
    const location = { directory: "/projects/one", sessionID: "ses_one" }
    expect(initialFileScope("auto", { ...location, path: "/projects/one/report.md" })).toBe("project")
    expect(initialFileScope("auto", { ...location, path: "report.md" })).toBe("session")
    expect(initialFileScope("auto", { ...location, path: "/projects/one-old/report.md" })).toBe("session")
    expect(initialFileScope("auto", { ...location, path: "/private/tmp/report.md" })).toBe("session")
    expect(initialFileScope("auto", { ...location, path: "/projects/one/../secret.md" })).toBe("session")
    expect(initialFileScope("session", { ...location, path: "/projects/one/report.md" })).toBe("session")
    expect(initialFileScope("auto", { directory: location.directory, path: "report.md" })).toBe("project")
  })

  test("retains origin authority for auto reads inside even a broad project root and nested links", () => {
    const input = {
      directory: "/home/user",
      path: "/home/user/.openscience/sessions/sibling/result.md",
      scope: "auto" as const,
      resolved: "project" as const,
      sessionID: "ses_origin",
    }
    expect(fileReadSession(input)).toBe("ses_origin")
    const nested = linkedFileTarget({ ...input, path: "reports/figure.svg" })
    expect(nested).toEqual({ path: "/home/user/reports/figure.svg", scope: "auto", sessionID: "ses_origin" })
    expect(fileReadSession({ ...input, ...nested })).toBe("ses_origin")
    expect(fileReadSession({ ...input, scope: "project" })).toBeUndefined()
    expect(fileReadSession({ ...input, scope: "session", resolved: "session" })).toBe("ses_origin")
    expect(
      missingFileFallback({ requested: "auto", resolved: "session", error: new Error("Access denied") }),
    ).toBeUndefined()
  })

  test("extracts useful messages from structured SDK failures", async () => {
    expect(fileErrorMessage({ data: { message: "Session scratch does not grant access to this project file" } })).toBe(
      "Session scratch does not grant access to this project file",
    )
    expect(fileErrorMessage({ error: { message: "File not found" } })).toBe("File not found")
    expect(fileErrorMessage({ code: 403 })).toBe('{"code":403}')
    expect(
      fileErrorMessage({
        data: { sessionID: "ses_1", path: "/private/tmp/scan_external.py", access: "read" },
      }),
    ).toBe(
      "This file is outside the active workspace. Move it into Session scratch or Project files before opening it.",
    )

    const result = await readFile(async () => {
      throw { data: { message: "Project file access denied" } }
    })
    expect(result.error?.message).toBe("Project file access denied")
  })

  test("uses bounded backoff for an active interrupted file read", () => {
    expect(fileReadRetryDelay(0)).toBe(150)
    expect(fileReadRetryDelay(1)).toBe(500)
    expect(fileReadRetryDelay(2)).toBeUndefined()
  })

  test("invalidates an in-flight read when project or session identity changes", () => {
    const owner = createFileRequestOwner()
    const first = owner.begin(
      fileRequestKey({ projectID: "prj_one", directory: "/projects/one", sessionID: "ses_one", path: "a.py" }),
    )
    const second = owner.begin(
      fileRequestKey({ projectID: "prj_two", directory: "/projects/two", sessionID: "ses_two", path: "a.py" }),
    )

    expect(first.controller.signal.aborted).toBe(true)
    expect(owner.owns(first)).toBe(false)
    expect(owner.owns(second)).toBe(true)
    owner.dispose()
  })
})

describe("PDF preview limits", () => {
  test("uses embedded JSON bytes for small PDFs and bounded raw bytes for larger previews", () => {
    expect(pdfPreviewMode({ truncated: false, size: 4 * 1024 * 1024 })).toBe("inline")
    expect(pdfPreviewMode({ truncated: true, size: 16 * 1024 * 1024 + 1 })).toBe("raw")
    expect(pdfPreviewMode({ truncated: true, size: PDF_PREVIEW_LIMIT })).toBe("raw")
  })

  test("falls back to an explicit download when the PDF cannot be safely buffered", () => {
    expect(pdfPreviewMode({ truncated: true })).toBe("download")
    expect(pdfPreviewMode({ truncated: true, size: PDF_PREVIEW_LIMIT + 1 })).toBe("download")
  })
})
