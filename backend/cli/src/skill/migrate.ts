import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { OpenScience } from "@/openscience"
import { Log } from "@/util/log"
import { Install } from "./install/install"
import { classifierInjectionRegexPass, runtimeRegexPass } from "./install/review"
import { Skill } from "./skill"

export namespace SkillMigration {
  const log = Log.create({ service: "skill-migration" })
  const marker = path.join(Global.Path.data, "migrations", "atlas-skills-v1.json")
  const state: { pending?: Promise<boolean> } = {}

  async function migrate(): Promise<boolean> {
    if (await Bun.file(marker).exists()) return false
    if (!(await OpenScience.getSession())) return false

    const [learned, installed] = await Promise.all([
      OpenScience.fetchLegacyLearnedSkills(),
      OpenScience.fetchLegacyInstalledSkills(),
    ])
    if (!learned || !installed) return false

    const dir = path.join(Global.Path.data, "learned-skills")
    const imported = await Promise.all(
      learned.map(async (entry) => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name)) return 0
        const file = path.join(dir, entry.name, "SKILL.md")
        if (await Bun.file(file).exists()) return 0
        const content = await OpenScience.fetchLegacyLearnedSkillContent(entry.name)
        if (!content) throw new Error(`Could not export legacy learned skill: ${entry.name}`)
        const skill = {
          namespace: "learned",
          name: entry.name,
          description: entry.description,
          content,
          scripts: [],
          references: [],
        }
        const rejected = [...runtimeRegexPass([skill]).rejected, ...classifierInjectionRegexPass([skill]).rejected]
        if (rejected.length) {
          log.warn("skipped unsafe legacy learned skill", { name: entry.name, reason: rejected[0]?.reason })
          return 0
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, content, { mode: 0o600 })
        return 1
      }),
    )
    const learnedCount = imported.reduce<number>((total, value) => total + value, 0)
    const installedCount = await Install.importLegacy(installed)
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await Bun.write(
      marker,
      JSON.stringify(
        {
          completed_at: new Date().toISOString(),
          learned: learnedCount,
          installed: installedCount,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
    if (learnedCount || installedCount) await Skill.invalidate()
    log.info("legacy Atlas skills imported locally", { learned: learnedCount, installed: installedCount })
    return true
  }

  export function run(): Promise<boolean> {
    if (state.pending) return state.pending
    state.pending = migrate().finally(() => {
      delete state.pending
    })
    return state.pending
  }
}
