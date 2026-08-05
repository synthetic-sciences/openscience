import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./FileExplorer.tsx", import.meta.url)), "utf8")

// FileExplorer.tsx no longer renders the Files right-pane — FilesPane.tsx
// (see FilesPane.test.ts) owns that role now. What remains here is
// ExternalFileAccess, the permission boundary for files outside the session,
// and the two grant primitives it actually uses (readAccess, grantAccess).
// Revocation left with the sources screen: the pane revokes, this file does
// not, so a third helper here would be source text nothing calls.
// The artifacts resource that used to sit here moved to
// @/artifacts/resource (resource.test.ts) once the pane actually consumed it.
// Coverage of the retired sources screen and drill-down browser (grouping,
// artifact rows, trash recovery, folder navigation) is gone with the markup
// it described, not carried over — FilesPane's own suite covers the new pane.
describe("file explorer surface", () => {
  test("keeps the grant primitives ExternalFileAccess depends on", () => {
    const value = source()

    expect(value).toContain('method: "POST"')
    expect(value).not.toContain('method: "DELETE"')
    expect(value).toContain("request(sessionUrl(identity.sessionID")
    expect(value).toContain("readAccess(sdk.request, current)")
    expect(value).toContain("Read only")
    expect(value).toContain("Read & write")
    expect(value).toContain("Available for")
    expect(value).toContain('label: "This project"')
  })

  test("routes unconnected absolute files to a permission boundary rather than re-rooting", () => {
    const value = source()

    expect(value).toContain("export function ExternalFileAccess")
    expect(value).toContain('aria-label="File access required"')
    expect(value).toContain("will not silently change the project root")
    expect(value).toContain("findFilesystemGrant")
    expect(value).toContain("Request access")
  })
})
