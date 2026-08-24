import { describe, expect, test } from "bun:test"
import path from "path"

describe("system skills", () => {
  const root = path.join(import.meta.dir, "..", "..")

  test("embedded goal matches the canonical SKILL.md", async () => {
    const embedded = await Bun.file(path.join(root, "src/skill/system/goal.txt")).text()
    const canonical = await Bun.file(path.join(root, "skills/other/goal/SKILL.md")).text()
    expect(embedded).toBe(canonical)
  })
})
