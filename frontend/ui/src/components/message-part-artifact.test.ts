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
  expect(part).toContain('title: saved() ? "Saved to Results"')
  expect(artifact).toContain("getFilename(artifact().path)")
  expect(part).toContain('data-slot="saved-artifact-preview"')
  expect(part).toContain('data-slot="saved-artifact-preview-text"')
  expect(artifact).toContain("const artifact = saved()")
  expect(artifact).toContain("data.openArtifact(artifact.id)")
  expect(artifact).toContain("data.openFile?.(artifact.path)")
  expect(artifact).toContain("onClick={open}")
  expect(part).toContain("Open Result")
  expect(artifact).not.toContain("artifact().version")
  expect(artifact).not.toContain("artifact().size")
  expect(artifact).not.toContain("artifact().sha256")
  expect(artifact).not.toContain("Show save receipt")
  expect(artifact).not.toContain("defaultOpen")
})

test("saving a written file confirms the Result without exposing storage versions", () => {
  const turn = readFileSync(fileURLToPath(new URL("./session-turn.tsx", import.meta.url)), "utf8")

  expect(turn).toContain('return "Saved to Results"')
  expect(turn).not.toContain("Saved as Result · v")
  expect(turn).not.toContain("version: result.version")
})

test("Modal and compute job results use a dedicated compact renderer", () => {
  const part = source()
  const remote = part.slice(
    part.indexOf("function RemoteComputeTool"),
    part.indexOf('ToolRegistry.register({ name: "modal"'),
  )

  expect(part).toContain('name: "modal"')
  expect(part).toContain('name: "compute_job"')
  expect(part).toContain('title: props.title || (props.tool === "modal" ? "Modal compute" : "Remote compute")')
  expect(part).toContain("props.metadata.job ??")
  expect(part).toContain('"job" in envelope ? envelope.job : undefined')
  expect(remote).not.toContain("defaultOpen")
})
