import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./session-turn.tsx", import.meta.url)), "utf8")

test("successful science results stay outside collapsed steps while failures remain inspectable", () => {
  expect(source).toContain('new Set(["python", "r", "notebook", "rkernel", "modal", "compute_job"])')
  expect(source).toContain('aria-label="Analysis code and results"')
  expect(source).toContain("hidePromotedTools")
  expect(source).toContain(".filter(isPromotedTool)")
  expect(source).toContain("parts.filter((part) => !isHiddenTool(part))")
  expect(source).toContain('part.state.status === "error"')
  expect(source).toContain("metadata?.ok !== false")
})

test("completed saved artifacts render in an end-of-turn Generated strip", () => {
  expect(source).toContain("generatedArtifacts(")
  expect(source).toContain('data-slot="session-turn-generated"')
  expect(source).toContain('data-slot="session-turn-generated-artifact"')
  expect(source).toContain("data.openArtifact(artifact.id)")
})

test("long transcript diffs use a bounded progressive-disclosure preview", () => {
  expect(source).toContain('data-slot="session-turn-diff-preview"')
  expect(source).toContain('data-slot="session-turn-diff-actions"')
  expect(source).toContain("aria-controls={previewID()}")
  expect(source).toContain("aria-expanded={expanded()}")
  expect(source).toContain("Expand preview")
  expect(source).toContain("Compact preview")
  expect(source).toContain("data.openFile?.(diff.file!)")

  const css = readFileSync(fileURLToPath(new URL("./session-turn.css", import.meta.url)), "utf8")
  expect(css).toContain('[data-slot="session-turn-diff-preview"]')
  expect(css).toContain("max-height: 240px")
  expect(css).toContain('[data-slot="session-turn-diff-preview"][data-expanded="true"]')
  expect(css).toContain("max-height: min(70dvh, 720px)")
  expect(css).toContain("overflow-y: auto")
  expect(css).toContain("@media (max-width: 480px)")
})
