import { test, expect } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"
import { Skill } from "../../src/skill"
import path from "path"

// Same fields the loader validates in Skill.compute() before accepting a skill.
const Frontmatter = Skill.Info.pick({ name: true, description: true, category: true, tags: true, entry: true })

const root = path.join(import.meta.dir, "..", "..", "skills")
const files = await Array.fromAsync(new Bun.Glob("**/SKILL.md").scan({ cwd: root, absolute: true }))

// Every bundled SKILL.md that declares a frontmatter block must produce a
// loadable skill. Malformed YAML (e.g. the unquoted `ray[train]` extras in
// issue #187) leaves the parser with empty data, so the loader silently drops
// the skill and it never appears in `skill list`. Category READMEs carry no
// frontmatter block and are intentionally skipped.
test("every bundled skill with frontmatter loads", async () => {
  expect(files.length).toBeGreaterThan(0)
  const broken = await Promise.all(
    files.map(async (file) => {
      const raw = await Bun.file(file).text()
      if (!raw.startsWith("---")) return undefined
      const parsed = await ConfigMarkdown.parse(file)
      return Frontmatter.safeParse(parsed.data).success ? undefined : path.relative(root, file)
    }),
  )
  expect(broken.filter(Boolean)).toEqual([])
})

test("ray-train frontmatter parses with quoted extras", async () => {
  const parsed = await ConfigMarkdown.parse(path.join(root, "ml-training", "ray-train", "SKILL.md"))
  expect(parsed.data.name).toBe("ray-train")
  expect(parsed.data.dependencies[0]).toBe("ray[train]")
})

test("ray-data frontmatter parses with quoted extras", async () => {
  const parsed = await ConfigMarkdown.parse(path.join(root, "data-engineering", "ray-data", "SKILL.md"))
  expect(parsed.data.name).toBe("ray-data")
  expect(parsed.data.dependencies[0]).toBe("ray[data]")
})
