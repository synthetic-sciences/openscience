import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { OpenScience } from "@/openscience"
import { Log } from "@/util/log"
import { Install } from "./install/install"
import { Skill } from "./skill"

export namespace SkillMigration {
  const log = Log.create({ service: "skill-migration" })
  const marker = path.join(Global.Path.data, "migrations", "atlas-skills-v1.json")
  const state: { pending?: Promise<boolean> } = {}

  async function migrate(): Promise<boolean> {
    if (await Bun.file(marker).exists()) return false
    if (!(await OpenScience.getSession())) return false

    const installed = await OpenScience.fetchLegacyInstalledSkills()
    if (!installed) return false

    const installedCount = await Install.importLegacy(installed)
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await Bun.write(
      marker,
      JSON.stringify(
        {
          completed_at: new Date().toISOString(),
          installed: installedCount,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
    if (installedCount) await Skill.invalidate()
    log.info("legacy Atlas skill installs imported locally", { installed: installedCount })
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
