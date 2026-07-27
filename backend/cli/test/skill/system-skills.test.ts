import { describe, expect, test } from "bun:test"
import path from "path"

// The `initialize-atlas-graph` system skill is embedded (src/skill/system/*.txt)
// so it resolves in every install — including the compiled binary, which ships
// no skills and otherwise relies on the API catalog. Guard the embedded copy
// against silent drift from the canonical SKILL.md in the skills tree.
describe("system skills", () => {
  const root = path.join(import.meta.dir, "..", "..")

  test("embedded initialize-atlas-graph matches the canonical SKILL.md", async () => {
    const embedded = await Bun.file(path.join(root, "src/skill/system/initialize-atlas-graph.txt")).text()
    const canonical = await Bun.file(path.join(root, "skills/research/initialize-atlas-graph/SKILL.md")).text()
    expect(embedded).toBe(canonical)
  })

  test("embedded goal matches the canonical SKILL.md", async () => {
    const embedded = await Bun.file(path.join(root, "src/skill/system/goal.txt")).text()
    const canonical = await Bun.file(path.join(root, "skills/other/goal/SKILL.md")).text()
    expect(embedded).toBe(canonical)
  })
})
