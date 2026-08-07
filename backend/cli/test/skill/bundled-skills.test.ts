import { test, expect } from "bun:test"
import path from "path"
import { ConfigMarkdown } from "../../src/config/markdown"
import { Skill } from "../../src/skill"

const Frontmatter = Skill.Info.pick({ name: true, description: true, category: true, tags: true, entry: true })
const root = path.join(import.meta.dir, "..", "..", "skills")
const files = await Array.fromAsync(new Bun.Glob("**/SKILL.md").scan({ cwd: root, absolute: true }))

test("every bundled skill with frontmatter parses and validates", async () => {
  expect(files.length).toBe(293)
  const broken = await Promise.all(
    files.map(async (file) => {
      const raw = await Bun.file(file).text()
      if (!raw.startsWith("---")) return path.relative(root, file)
      const parsed = await ConfigMarkdown.parse(file)
      return Frontmatter.safeParse(parsed.data).success ? undefined : path.relative(root, file)
    }),
  )
  expect(broken.filter(Boolean)).toEqual([])
})

test("Ray extras remain scalar dependency names", async () => {
  const train = await ConfigMarkdown.parse(path.join(root, "ml-training", "ray-train", "SKILL.md"))
  const data = await ConfigMarkdown.parse(path.join(root, "data-engineering", "ray-data", "SKILL.md"))
  expect(train.data.dependencies[0]).toBe("ray[train]")
  expect(data.data.dependencies[0]).toBe("ray[data]")
})
