import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./session-turn.tsx", import.meta.url)), "utf8")

test("successful science results stay available in compact metadata while failures remain inspectable", () => {
  expect(source).toContain('new Set(["python", "r", "notebook", "rkernel", "modal", "compute_job"])')
  expect(source).toContain('aria-label="Analysis code and results"')
  expect(source).toContain('data-slot="session-turn-metadata"')
  expect(source).toContain("Analysis outputs")
  expect(source).toContain("Other changed files")
  expect(source).toContain("hidePromotedTools")
  expect(source).toContain(".filter(isPromotedTool)")
  expect(source).toContain(
    "if (props.hidePromotedTools && isHiddenTool(part)) return [{ message, part, hidden: true }]",
  )
  expect(source).toContain('part.state.status === "error"')
  expect(source).toContain("metadata?.ok !== false")

  const css = readFileSync(fileURLToPath(new URL("./session-turn.css", import.meta.url)), "utf8")
  expect(css).toContain('[data-slot="session-turn-metadata"]')
  expect(css).toContain("&[open] > summary")
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

test("expanded steps render literal tool activity and first-class delegation results", () => {
  const parts = readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")
  const css = readFileSync(fileURLToPath(new URL("./message-part.css", import.meta.url)), "utf8")

  expect(source).toContain("groupResearchTrace")
  expect(source).toContain("props.messages.flatMap")
  expect(source).toContain("messages={assistantMessages()}")
  expect(source).toContain("groupResearchTrace")
  expect(parts).toContain('<details\n              data-component="delegation-card"')
  expect(parts).toContain('data-slot="delegation-summary"')
  expect(parts).toContain('data-slot="delegation-body"')
  expect(parts).toContain('data-slot="delegation-findings"')
  expect(parts).toContain('data-slot="delegation-activity"')
  expect(parts).toContain('data-slot="delegation-raw"')
  expect(parts).toContain("Open agent")
  expect(parts).toContain("<Markdown text={text()} cacheKey={part.id} />")
  expect(parts).toContain('data-origin="provider-reasoning"')
  expect(parts).not.toContain('data-slot="reasoning-part-label"')
  expect(css).toContain('[data-component="delegation-card"]')
})

test("activity shows provider reasoning without the repetitive execution-trace legend", () => {
  const parts = readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")
  const english = readFileSync(fileURLToPath(new URL("../i18n/en.ts", import.meta.url)), "utf8")

  expect(source).not.toContain('data-slot="session-turn-trace-legend"')
  expect(source).toContain("hideReasoning={false}")
  expect(source).toContain("latestReasoningOnly={working()}")
  expect(source).toContain("liveReasoningDisplayText")
  expect(source).toContain('entry.part?.type !== "reasoning" || entry.part.id === latestReasoning')
  expect(parts).toContain("reasoningDisplayText")
  expect(parts).toContain('data-origin="provider-reasoning"')
  expect(english).toContain('"ui.sessionTurn.steps.show": "Show reasoning and activity"')
  expect(english).not.toContain("model summaries are provider-generated")
})

test("live status skips invisible lifecycle parts and recognizes remote compute", () => {
  expect(source).toContain('case "compute_job"')
  expect(source).toContain("if (!lastStatus) lastStatus = computeStatusFromPart(part, i18n.t)")
  expect(source).toContain("return lastStatus")
})
