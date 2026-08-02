import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./FileExplorer.tsx", import.meta.url)), "utf8")

describe("file explorer surface", () => {
  test("organizes Files around sources instead of a host filesystem root", () => {
    const value = source()

    expect(value).toContain('title="Workspace"')
    expect(value).toContain('detail="Local and session files"')
    expect(value).toContain("Session workspace")
    expect(value).toContain("Browse files")
    expect(value).toContain('title="Artifacts"')
    expect(value).toContain('title="Connected locations"')
    expect(value).toContain("FilesSourceList")
    expect(value).toContain("connectedFilesystemGrants")
    expect(value).toContain("sessionFilesystemRoot")
    expect(value).toContain("formOverlay()")
    expect(value).not.toContain("This computer")
    expect(value).not.toContain('placeholder="/absolute/path"')
    expect(value).not.toContain("onHome")
    expect(value).not.toContain("onRoot={()")
    expect(value).toContain("disabled={!props.sessionReady}")
    expect(value).toContain("if (!root) return")
  })

  test("uses directional filesystem grants for explicit connection and revocation", () => {
    const value = source()

    expect(value).toContain('method: "POST"')
    expect(value).toContain('method: "DELETE"')
    expect(value).toContain("request(sessionUrl(identity.sessionID")
    expect(value).toContain("readAccess(sdk.request, current)")
    expect(value).toContain("Read only")
    expect(value).toContain("Read & write")
    expect(value).toContain("Available for")
    expect(value).toContain('label: "This project"')
    expect(value).toContain('aria-label="Choose folder"')
    expect(value).toContain('aria-label="Choose file"')
    expect(value).toContain("Revoke")
    expect(value).toContain("code runtimes do not gain a writable mount")
  })

  test("keeps real SDK browsing and contextual-pane file opening inside a selected source", () => {
    const value = source()

    expect(value).toContain(".list(input)")
    expect(value).toContain("containsFilePath(view.source.root, node.absolute)")
    expect(value).toContain("uiStore.openFile(projectRoot(), path)")
    expect(value).toContain('aria-label="Back to file sources"')
    expect(value).toContain('aria-label="Files in source"')
    expect(value).not.toContain("centerTabs")
  })

  test("opens durable artifact rows in their immutable saved-artifact view", () => {
    const value = source()

    expect(value).toContain("onInspectArtifact")
    expect(value).toContain("<IconMoreH")
    expect(value).toContain("onOpenArtifact={uiStore.openSaved}")
    expect(value).toContain("onInspectArtifact={uiStore.openSaved}")
    expect(value).toContain("request(`/file/artifact-store?state=${state}`)")
    expect(value).toContain('aria-label="Artifact trash"')
    expect(value).toContain("retained 30 days")
    expect(value).toContain("onRestoreArtifact={restore}")
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
