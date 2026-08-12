import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./Icon.tsx", import.meta.url)), "utf8")

test("workspace icons normalize size and weight through the shared adapter", () => {
  expect(source).toContain("if (value <= 12) return 12")
  expect(source).toContain("if (value <= 16) return 16")
  expect(source).toContain("if (value <= 18) return 18")
  expect(source).toContain("return 20")
  expect(source).toContain("Math.min(1.75, Math.max(1.5, value))")
  expect(source).toContain('"--icon-stroke-width": weight(props.strokeWidth)')
})

test("workspace semantics map to dedicated shared glyphs", () => {
  expect(source).toContain('IconLayoutGrid = icon("layout-grid")')
  expect(source).toContain('IconSplit = icon("split")')
  expect(source).toContain('IconCpu = icon("cpu")')
  expect(source).toContain('IconFolderTree = icon("folder-tree")')
  expect(source).toContain('IconRefresh = icon("refresh")')
  expect(source).toContain('IconFlask = icon("flask")')
  expect(source).toContain('IconFile = icon("file")')
  expect(source).toContain('IconAtom = icon("atom")')
  expect(source).toContain('IconNetwork = icon("network")')
  expect(source).toContain('IconArtifact = icon("artifact")')
  expect(source).toContain('IconResearch = icon("research")')
  expect(source).not.toContain('IconSplit = icon("task")')
  expect(source).not.toContain('IconNetwork = icon("branch")')
  expect(source).not.toContain('IconCpu = icon("providers")')
  expect(source).not.toContain('IconFile = icon("code-lines")')
})

test("agent identity uses the research-specific mark", () => {
  const agent = readFileSync(fileURLToPath(new URL("./AgentIcon.tsx", import.meta.url)), "utf8")

  expect(agent).toContain('import { IconResearch } from "./Icon"')
  expect(agent).toContain("<IconResearch")
  expect(agent).not.toContain("<IconAtom")
})
