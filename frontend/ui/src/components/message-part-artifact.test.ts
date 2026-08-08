import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")

test("saved workspace artifacts render previewable, openable results", () => {
  const part = source()
  const artifact = part.slice(
    part.indexOf("function SavedArtifactTool"),
    part.indexOf('ToolRegistry.register({\n  name: "artifact"'),
  )

  expect(part).toContain('name: "artifact"')
  expect(part).toContain('data-component="saved-artifact-tool"')
  expect(part).toContain('title: saved() ? "Saved artifact"')
  expect(part).toContain("sha256 {artifact().sha256.slice(0, 12)}")
  expect(part).toContain('data-slot="saved-artifact-preview"')
  expect(part).toContain('data-slot="saved-artifact-preview-text"')
  expect(part).toContain("data.openFile?.(artifact().path)")
  expect(part).toContain("Open beside chat")
  expect(part).toContain("<summary>Show save receipt</summary>")
  expect(artifact).not.toContain("defaultOpen")
})

test("Modal and compute job results use a dedicated compact renderer", () => {
  const part = source()
  const remote = part.slice(
    part.indexOf("function RemoteComputeTool"),
    part.indexOf('ToolRegistry.register({ name: "modal"'),
  )

  expect(part).toContain('name: "modal"')
  expect(part).toContain('name: "compute_job"')
  expect(part).toContain('title: props.tool === "modal" ? "Modal compute" : "Remote compute result"')
  expect(remote).not.toContain("defaultOpen")
})
