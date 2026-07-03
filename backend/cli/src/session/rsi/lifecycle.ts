/**
 * RSI Lifecycle — Usage tracking and lifecycle management for learned skills.
 *
 * - Tracks usage count per learned skill
 * - Archives skills with 0 uses after 30 days
 * - Flags high performers (>10 uses) for potential promotion
 */

import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Log } from "@/util/log"

export namespace RSILifecycle {
  const log = Log.create({ service: "rsi-lifecycle" })
  const LEARNED_SKILLS_DIR = path.join(Global.Path.data, "learned-skills")
  const STATS_PATH = path.join(LEARNED_SKILLS_DIR, ".stats.json")
  const ARCHIVE_AFTER_DAYS = 30
  const HIGH_PERFORMER_THRESHOLD = 10

  interface Stats {
    skills: Record<string, SkillStats>
  }

  interface SkillStats {
    usageCount: number
    firstUsed: number
    lastUsed: number
    created: number
  }

  async function readStats(): Promise<Stats> {
    try {
      return await Bun.file(STATS_PATH).json()
    } catch {
      return { skills: {} }
    }
  }

  async function writeStats(stats: Stats): Promise<void> {
    await fs.mkdir(path.dirname(STATS_PATH), { recursive: true })
    await Bun.write(STATS_PATH, JSON.stringify(stats, null, 2))
  }

  /** Increment usage count for a learned skill. */
  export async function trackUsage(skillName: string): Promise<void> {
    const stats = await readStats()
    const now = Date.now()
    if (!stats.skills[skillName]) {
      stats.skills[skillName] = {
        usageCount: 0,
        firstUsed: now,
        lastUsed: now,
        created: now,
      }
    }
    stats.skills[skillName].usageCount++
    stats.skills[skillName].lastUsed = now
    await writeStats(stats)
  }

  /** Register a newly created learned skill in stats. */
  export async function registerSkill(skillName: string): Promise<void> {
    const stats = await readStats()
    if (!stats.skills[skillName]) {
      const now = Date.now()
      stats.skills[skillName] = {
        usageCount: 0,
        firstUsed: 0,
        lastUsed: 0,
        created: now,
      }
      await writeStats(stats)
    }
  }

  /** Get stats for a skill. */
  export async function getStats(skillName: string): Promise<SkillStats | null> {
    const stats = await readStats()
    return stats.skills[skillName] ?? null
  }

  /** Archive unused skills (0 uses after ARCHIVE_AFTER_DAYS). Returns archived count. */
  export async function archiveUnused(): Promise<number> {
    const stats = await readStats()
    const now = Date.now()
    const threshold = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000
    let archived = 0

    for (const [name, s] of Object.entries(stats.skills)) {
      if (s.usageCount === 0 && now - s.created > threshold) {
        const dir = path.join(LEARNED_SKILLS_DIR, name)
        const exists = await fs.stat(dir).catch(() => null)
        if (exists) {
          await fs.rm(dir, { recursive: true })
          delete stats.skills[name]
          archived++
          log.info("archived unused learned skill", { name, age: Math.round((now - s.created) / 86400000) })
        }
      }
    }

    if (archived > 0) {
      await writeStats(stats)
    }
    return archived
  }

  /** Find high-performing skills (>HIGH_PERFORMER_THRESHOLD uses). */
  export async function highPerformers(): Promise<string[]> {
    const stats = await readStats()
    return Object.entries(stats.skills)
      .filter(([, s]) => s.usageCount > HIGH_PERFORMER_THRESHOLD)
      .map(([name]) => name)
  }

  /** Startup lifecycle check — archive unused, log high performers. */
  export async function startupCheck(): Promise<void> {
    try {
      const archived = await archiveUnused()
      if (archived > 0) {
        log.info("startup: archived unused learned skills", { count: archived })
      }

      const performers = await highPerformers()
      if (performers.length > 0) {
        log.info("startup: high-performing learned skills", { skills: performers })
      }
    } catch (e) {
      log.warn("lifecycle startup check failed", { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
