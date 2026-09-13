import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill/skill"
import { tmpdir, trustProject } from "../fixture/fixture"

async function writeSkill(root: string, relative: string, name: string, description: string) {
  const file = path.join(root, relative, "SKILL.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(
    file,
    `---\nname: ${name}\ndescription: ${description}\ncategory: research\n---\n\n# ${name}\n\n${description}\n`,
  )
  return file
}

describe("skill roots", () => {
  test("a directory registered at runtime is scanned recursively, reported as a root, and can win or be removed", async () => {
    await using tmp = await tmpdir({ git: true })
    const pack = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-skill-pack-"))
    try {
      const projectAlpha = await writeSkill(tmp.path, ".openscience/skill/alpha", "alpha", "Project alpha.")
      const packAlpha = await writeSkill(pack, "ml/alpha", "alpha", "Pack alpha.")
      const packBeta = await writeSkill(pack, "ml/beta", "beta", "Pack beta.")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const before = await Skill.roots()
          expect(before.roots.map((root) => root.kind)).toContain("project")
          expect(before.roots.some((root) => root.path === pack)).toBe(false)
          expect((await Skill.get("alpha"))?.location).toBe(projectAlpha)

          const root = await Skill.addRoot(pack)
          expect(root).toMatchObject({ path: pack, kind: "runtime", skills: 2, shadowed: 0 })
          // The nested layout is found, and the later custom root wins the
          // name collision; the loser is reported on both sides.
          expect((await Skill.get("beta"))?.location).toBe(packBeta)
          const alpha = await Skill.get("alpha")
          expect(alpha?.location).toBe(packAlpha)
          expect(alpha?.shadows).toEqual([projectAlpha])
          const after = await Skill.roots()
          expect(after.shadowed).toEqual([{ name: "alpha", location: projectAlpha, origin: "project", by: packAlpha }])
          expect(
            after.roots.find((item) => item.kind === "project" && item.path.includes(".openscience")),
          ).toMatchObject({
            skills: 0,
            shadowed: 1,
          })
          expect(after.revision).toBeGreaterThan(before.revision)
          expect(await Skill.content("beta")).toMatchObject({ name: "beta", location: packBeta })
          expect((await Skill.content("beta"))?.content).toContain("Pack beta.")

          await expect(Skill.addRoot(pack)).rejects.toMatchObject({ data: { code: "duplicate" } })
          await expect(Skill.addRoot(path.join(pack, "missing"))).rejects.toMatchObject({ data: { code: "missing" } })
          const empty = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-empty-"))
          await expect(Skill.addRoot(empty)).rejects.toMatchObject({ data: { code: "empty" } })
          await fs.rm(empty, { recursive: true, force: true })

          await Skill.removeRoot(pack)
          expect(await Skill.get("beta")).toBeUndefined()
          expect((await Skill.get("alpha"))?.location).toBe(projectAlpha)
          expect((await Skill.roots()).shadowed).toEqual([])
          await expect(Skill.removeRoot(pack)).rejects.toMatchObject({ data: { code: "unknown" } })
        },
      })
    } finally {
      await fs.rm(pack, { recursive: true, force: true })
    }
  })

  test("persisting a root writes skills.paths in the project config and survives a rebuild", async () => {
    await using tmp = await tmpdir({ git: true })
    const pack = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-skill-pack-"))
    try {
      await writeSkill(pack, "gamma", "gamma", "Pack gamma.")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const root = await Skill.addRoot(pack, { persist: "project" })
          expect(root.skills).toBe(1)
          expect((await Config.get()).skills?.paths).toEqual([pack])
          // A rebuild reads the root from config now, not from the runtime set.
          await Skill.invalidate()
          expect((await Skill.roots()).roots.find((item) => item.path === pack)?.kind).toBe("config")
          expect(await Skill.get("gamma")).toBeDefined()

          await Skill.removeRoot(pack, { persist: "project" })
          expect((await Config.get()).skills?.paths ?? []).toEqual([])
          expect(await Skill.get("gamma")).toBeUndefined()
        },
      })
    } finally {
      await fs.rm(pack, { recursive: true, force: true })
    }
  })
})
