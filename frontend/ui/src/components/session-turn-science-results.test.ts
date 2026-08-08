import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./session-turn.tsx", import.meta.url)), "utf8")

test("scientific code, results, artifacts, and remote jobs stay outside collapsed steps", () => {
  expect(source).toContain('new Set(["notebook", "rkernel", "artifact", "modal", "compute_job"])')
  expect(source).toContain('aria-label="Analysis code and results"')
  expect(source).toContain("hidePromotedTools")
  expect(source).toContain(".filter(isPromotedTool)")
  expect(source).toContain("parts.filter((part) => !isPromotedTool(part))")
})
