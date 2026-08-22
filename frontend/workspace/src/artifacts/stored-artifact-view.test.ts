import { expect, test } from "bun:test"

const source = await Bun.file(new URL("./StoredArtifactView.tsx", import.meta.url)).text()

test("keeps text preview loading state reactive", () => {
  expect(source).toContain("<Match when={props.loading}>")
  expect(source).toContain("Loading preview…")
  expect(source).not.toContain("if (props.loading)")
})

test("refreshes an open artifact record after a new immutable version is saved", () => {
  expect(source).toContain('window.addEventListener("openscience:artifacts-changed", refresh)')
  expect(source).toContain("void detailActions.refetch()")
  expect(source).toContain("const selected = createMemo(() =>")
  expect(source).toContain("current.id !== props.artifact.id")
})

test("keeps the saved artifact surface focused on preview while provenance UI is deferred", () => {
  expect(source).toContain("<Preview")
  expect(source).toContain("loadStoredArtifactPreview(sdk.request, artifactID, version, controller.signal)")
  expect(source).toContain("requestStoredArtifact(sdk.request, props.artifact.id, version.id, true)")
  expect(source).not.toContain("Versions")
  expect(source).not.toContain("How made")
  expect(source).not.toContain("Review")
  expect(source).not.toContain('aria-label="Result record"')
  expect(source).not.toContain('aria-label="Immutable versions"')
  expect(source).not.toContain('aria-label="Artifact provenance"')
  expect(source).not.toContain('aria-label="Result review"')
  expect(source).not.toContain('sdk.request("/provenance/reviews")')
  expect(source).not.toContain("/review/artifact")
})

test("renders saved PDFs with the same first-party viewer used by project files", () => {
  expect(source).toContain('import { PdfViewer } from "@/science/renderers/documents/PdfViewer"')
  expect(source).toContain('<PdfViewer kind="pdf" data={{ bytes: data().data, maxPages: 40 }} />')
  expect(source).not.toContain("<iframe")
  expect(source).toContain('return "PDF"')
  expect(source).toContain("STORED_PDF_PREVIEW_LIMIT")
  expect(source).toContain("previewAbort.current?.abort()")
})

test("never hands protected artifact URLs to browser-native readers", () => {
  expect(source).not.toContain("sdk.request.url")
  expect(source).not.toMatch(/\bfetch\s*\(/)
  expect(source).not.toMatch(/<a(?:\s|>)/)
  expect(source).toContain("downloadBlob(version.filename, blob)")
  expect(source).toContain('role="alert"')
})

test("keeps rename and recoverable deletion in the stored artifact lifecycle", () => {
  expect(source).toContain('method: "PATCH"')
  expect(source).toContain('method: "DELETE"')
  expect(source).toContain("Recoverable from Files for 30 days")
  expect(source).toContain("uiStore.updateSaved(updated)")
  expect(source).toContain("uiStore.closeWorkTab(`saved:${props.artifact.id}`)")
})

test("uses the shared quiet boundary and control language", () => {
  expect(source).toContain('import { Button } from "@synsci/ui/button"')
  expect(source).toContain('import { IconButton } from "@synsci/ui/icon-button"')
  expect(source).toContain('import { TextField } from "@synsci/ui/text-field"')
  expect(source).toContain('variant="secondary"')
  expect(source).toContain('"border-bottom": "1px solid var(--border-weak-base)"')
  expect(source).toContain('background: "var(--surface-raised-base)"')
  expect(source).toContain('"border-radius": "var(--radius-md)"')
  expect(source).toContain('"border-radius": "var(--radius-sm)"')
  expect(source).not.toContain("--color-border-subtle")
  expect(source).not.toMatch(/"border-radius": "\d+px"/)
  expect(source).not.toContain("const actionCard")
})
