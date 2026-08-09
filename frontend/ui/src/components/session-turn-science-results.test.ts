import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./session-turn.tsx", import.meta.url)), "utf8")

test("successful science results stay outside collapsed steps while failures remain inspectable", () => {
  expect(source).toContain('new Set(["notebook", "rkernel", "modal", "compute_job"])')
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
