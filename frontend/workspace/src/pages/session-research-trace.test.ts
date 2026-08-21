import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./session.tsx", import.meta.url)), "utf8")

test("show-steps expansion survives navigation and reloads", () => {
  expect(source).toContain('const traceExpansionKey = "openscience-trace-expansion-v1"')
  expect(source).toContain("readTraceExpansion()")
  expect(source).toContain("writeTraceExpansion(next)")
})

test("delegated sessions expose parent and sibling navigation", () => {
  expect(source).toContain("Delegated agent")
  expect(source).toContain('aria-label="Back to parent session"')
  expect(source).toContain('aria-label="Previous delegated agent"')
  expect(source).toContain('aria-label="Next delegated agent"')
  expect(source).toContain("childSessions().length")
})
