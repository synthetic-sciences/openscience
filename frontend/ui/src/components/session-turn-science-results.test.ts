import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./session-turn.tsx", import.meta.url)), "utf8")

test("science tools stay in the chronological activity stream while generated artifacts use their result strip", () => {
  expect(source).toContain("Session outputs")
  expect(source).toContain("Keep important deliverables in Results")
  expect(source).not.toContain("Analysis outputs")
  expect(source).not.toContain("isPromotedTool")
  expect(source).toContain("hideGeneratedTools")
  expect(source).toContain(
    "if (props.hideGeneratedTools && isGeneratedTool(part)) return [{ message, part, hidden: true }]",
  )
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

test("assistant text remains in the literal trace instead of a generated Response block", () => {
  const parts = readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")
  expect(source).toContain("hideTools={!props.stepsExpanded}")
  expect(source).not.toContain("hideResponsePart")
  expect(source).not.toContain("ui.sessionTurn.summary.response")
  expect(source).toContain('data-slot="session-turn-response-section"')
  expect(source).toContain("const traceByID")
  expect(source).toContain("const traceIDs")
  expect(source).toContain("<For each={traceIDs()}>")
  expect(source).not.toContain("<Index each={trace()}")
  expect(source).toContain("hideCopy />")
  expect(parts).toContain("<Show when={!props.hideCopy}>")
})

test("a provider failure has exactly one owner in expanded and collapsed activity", () => {
  expect(source).toContain("props.stepsExpanded && error()")
  expect(source).toContain("error() && !props.stepsExpanded")
  expect(source.match(/<SessionErrorNotice error=\{value\(\)\} \/>/g)).toHaveLength(2)
})
