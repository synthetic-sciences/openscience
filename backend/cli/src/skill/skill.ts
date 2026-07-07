import z from "zod"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { State } from "../project/state"
import { runtimeRegexPass, classifierInjectionRegexPass } from "./install/review"
import { NamedError } from "@synsci/util/error"
import { ConfigMarkdown } from "../config/markdown"
import INITIALIZE_ATLAS_GRAPH_MD from "./system/initialize-atlas-graph.txt"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Session } from "@/session"
import { OpenScience } from "@/openscience"
import { Installation } from "@/installation"

// System skills the product invokes directly (e.g. the canvas prefills
// `/initialize-atlas-graph`) but which are not part of the server skill
// catalog. Their SKILL.md is embedded so they resolve in every install —
// including the compiled binary, which ships no skills and otherwise depends on
// the API index. Kept in sync with skills/research/<name>/SKILL.md by a test.
const SYSTEM_SKILLS: Array<{ name: string; content: string }> = [
  { name: "initialize-atlas-graph", content: INITIALIZE_ATLAS_GRAPH_MD },
]

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    /** Whether the skill is user-facing (shows in / autocomplete) or an
     *  internal helper used transitively by other skills. Defaults to true.
     *  Driven by `openscience-skills.json` `entries[]` for URL-installed skills;
     *  bundled / learned skills omit this and are always entries. */
    entry: z.boolean().optional(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("skill.updated", z.object({})),
  }

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const OPENSCIENCE_SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")
  const CLAUDE_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
  const SKILL_GLOB = new Bun.Glob("**/SKILL.md")
  const USER_SKILL_DIR = path.join(Global.Path.data, "user-skills")
  const UserSkillName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)

  async function compute() {
    const skills: Record<string, Info> = {}

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true, category: true, tags: true, entry: true }).safeParse(
        md.data,
      )
      if (!parsed.success) return

      // Block skills with injection-like descriptions
      const desc = (parsed.data.description ?? "").toLowerCase()
      if (desc.includes("always run this skill") || desc.includes("must always run")) {
        log.warn("blocked skill with injection pattern", {
          name: parsed.data.name,
          reason: "description contains injection directive",
        })
        return
      }

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        category: parsed.data.category,
        tags: parsed.data.tags,
        entry: parsed.data.entry,
      }
    }

    // Scan .claude/skills/ directories (project-level)
    const claudeDirs = await Array.fromAsync(
      Filesystem.up({
        targets: [".claude"],
        start: Instance.directory,
        stop: Instance.worktree,
      }),
    )
    // Also include global ~/.claude/skills/
    const globalClaude = `${Global.Path.home}/.claude`
    if (await Filesystem.isDir(globalClaude)) {
      claudeDirs.push(globalClaude)
    }

    if (!Flag.OPENSCIENCE_DISABLE_CLAUDE_CODE_SKILLS) {
      for (const dir of claudeDirs) {
        const matches = await Array.fromAsync(
          CLAUDE_SKILL_GLOB.scan({
            cwd: dir,
            absolute: true,
            onlyFiles: true,
            followSymlinks: true,
            dot: true,
          }),
        ).catch((error) => {
          log.error("failed .claude directory scan for skills", { dir, error })
          return []
        })

        for (const match of matches) {
          await addSkill(match)
        }
      }
    }

    // Scan .openscience/skill/ directories
    for (const dir of await Config.directories()) {
      for await (const match of OPENSCIENCE_SKILL_GLOB.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
      }
    }

    // === Server-side Skills: fetched from API, cached locally ===
    if (!Flag.OPENSCIENCE_DISABLE_BUNDLED_SKILLS) {
      const cacheDir = Global.Path.cache

      // Try fetching skill index from dashboard API
      const index = await OpenScience.fetchSkillIndex()
      if (index) {
        for (const skill of index) {
          if (!skills[skill.name]) {
            // Block skills with injection patterns (same check as addSkill)
            const desc = (skill.description ?? "").toLowerCase()
            if (desc.includes("always run this skill") || desc.includes("must always run")) {
              log.warn("blocked API skill with injection pattern", {
                name: skill.name,
                reason: "description contains injection directive",
              })
              continue
            }
            const cachePath = path.join(cacheDir, "skills", skill.name, "SKILL.md")
            skills[skill.name] = {
              name: skill.name,
              description: skill.description,
              location: cachePath, // may not exist yet — fetched lazily when invoked
              category: skill.category,
              tags: skill.tags,
            }
          }
        }
        log.info("Loaded skill index from API", { count: index.length })
      } else {
        // Offline fallback: scan cached skills directory
        const cachedSkillsDir = path.join(cacheDir, "skills")
        if (await Filesystem.isDir(cachedSkillsDir)) {
          let count = 0
          for await (const match of SKILL_GLOB.scan({
            cwd: cachedSkillsDir,
            absolute: true,
            onlyFiles: true,
            followSymlinks: true,
          })) {
            await addSkill(match)
            count++
          }
          log.info("Loaded cached skills (offline)", { count })
        }
      }

      // Development fallback: only when running from source (not compiled binary)
      const devSkillsPath = path.join(import.meta.dir, "../../skills")
      if (Installation.VERSION === "local" && (await Filesystem.isDir(devSkillsPath))) {
        let count = 0
        for await (const match of SKILL_GLOB.scan({
          cwd: devSkillsPath,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        })) {
          await addSkill(match)
          count++
        }
        log.info("Loaded dev skills", { path: devSkillsPath, count })
      }
    }

    // === Learned Skills: from RSI distillation, cloud-synced + local ===
    const learnedDir = path.join(Global.Path.data, "learned-skills")

    // Sync from cloud: fetch learned skills index and write any missing to disk.
    // Gated on the same flag as the skill index above so it is one consistent
    // "no server-side skill I/O" switch — this keeps skill discovery from
    // blocking on a slow/unreachable backend (#138) and makes it deterministic
    // in tests (preload sets the flag). The local learned-skills scan below still
    // runs regardless.
    const cloudLearned = Flag.OPENSCIENCE_DISABLE_BUNDLED_SKILLS
      ? null
      : await OpenScience.fetchLearnedSkills().catch(() => null)
    if (cloudLearned) {
      for (const entry of cloudLearned) {
        const skillDir = path.join(learnedDir, entry.name)
        const skillPath = path.join(skillDir, "SKILL.md")
        const exists = await Bun.file(skillPath).exists()
        if (!exists) {
          const content = await OpenScience.fetchLearnedSkillContent(entry.name).catch(() => null)
          if (content) {
            await fs.mkdir(skillDir, { recursive: true })
            await Bun.write(skillPath, content)
            log.info("synced learned skill from cloud", { name: entry.name })
          }
        }
      }
    }

    // Scan local learned-skills directory (includes both local and just-synced cloud skills)
    if (await Filesystem.isDir(learnedDir)) {
      let learnedCount = 0
      for await (const match of SKILL_GLOB.scan({
        cwd: learnedDir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
        learnedCount++
      }
      if (learnedCount > 0) {
        log.info("Loaded learned skills", { count: learnedCount })
      }
    }

    // === User Skills: authored locally via openscience/web, private by default ===
    if (await Filesystem.isDir(USER_SKILL_DIR)) {
      let userCount = 0
      for await (const match of SKILL_GLOB.scan({
        cwd: USER_SKILL_DIR,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
        userCount++
      }
      if (userCount > 0) {
        log.info("Loaded user skills", { count: userCount })
      }
    }

    // === Installed Skills: URL-installed third-party skills ===
    // Local-first store at:
    //   ~/.openscience/installed-skills/<ns>/skills/<name>/SKILL.md
    // mirroring the upstream plugin convention. Cloud sync via
    // /api/cli/installed-skills returns install pointers (repo_url + sha);
    // each machine re-fetches from git on first sync. The DB row is just
    // the install ledger / kill-switch hook.
    const installedDir = path.join(Global.Path.data, "installed-skills")

    // One-time on-disk migration from the legacy flat layout
    // (<ns>/<name>/SKILL.md) → plugin layout (<ns>/skills/<name>/SKILL.md).
    // Idempotent: skips namespaces that already have the skills/ subdir.
    if (await Filesystem.isDir(installedDir)) {
      try {
        const nsDirs = await fs.readdir(installedDir, { withFileTypes: true })
        for (const ns of nsDirs) {
          if (!ns.isDirectory()) continue
          const nsPath = path.join(installedDir, ns.name)
          const skillsSubdir = path.join(nsPath, "skills")
          if (await Filesystem.isDir(skillsSubdir)) continue
          // No skills/ subdir — sniff for legacy layout (children with SKILL.md).
          const children = await fs.readdir(nsPath, { withFileTypes: true })
          await fs.mkdir(skillsSubdir, { recursive: true })
          let migrated = 0
          for (const c of children) {
            if (!c.isDirectory()) continue
            const src = path.join(nsPath, c.name)
            const hasSkill = await Bun.file(path.join(src, "SKILL.md")).exists()
            if (!hasSkill) continue
            await fs.rename(src, path.join(skillsSubdir, c.name))
            migrated++
          }
          if (migrated > 0) {
            log.info("migrated installed skills to plugin layout", { namespace: ns.name, migrated })
          } else {
            await fs.rmdir(skillsSubdir).catch(() => {})
          }
        }
      } catch {
        /* migration best-effort */
      }
    }

    // Same gate as the learned + index fetches above: a slow/unreachable backend
    // must not wedge skill discovery, and tests stay network-independent. The
    // local installed-skills scan below still runs regardless.
    const cloudInstalled = Flag.OPENSCIENCE_DISABLE_BUNDLED_SKILLS
      ? null
      : await OpenScience.fetchInstalledSkills().catch(() => null)
    if (cloudInstalled) {
      for (const entry of cloudInstalled) {
        const skillDir = path.join(installedDir, entry.namespace, "skills", entry.name)
        const skillPath = path.join(skillDir, "SKILL.md")
        const exists = await Bun.file(skillPath).exists()
        if (!exists) {
          // Pointer-only DB: re-fetch from git using stored repo_url + sha.
          // Skips Layer 3 — the first install's classifier verdict is
          // authoritative; the SHA is content-addressed so the content is
          // provably identical. Layers 1 + 2 still run as paranoid defense.
          try {
            const { gitFetchPinned } = await import("./install/git-fetch")
            await gitFetchPinned({
              repo_url: entry.repo_url,
              pinned_sha: entry.pinned_sha,
              namespace: entry.namespace,
              skillName: entry.name,
              destDir: skillDir,
            })
            log.info("synced installed skill from git", {
              namespace: entry.namespace,
              name: entry.name,
              sha: entry.pinned_sha.slice(0, 7),
            })
          } catch (e) {
            log.warn("failed to sync installed skill from git", {
              namespace: entry.namespace,
              name: entry.name,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }
      }
    }

    if (await Filesystem.isDir(installedDir)) {
      let installedCount = 0
      const entriesByNs = new Map<string, Set<string> | null>()
      try {
        const nsDirs = await fs.readdir(installedDir, { withFileTypes: true })
        for (const ns of nsDirs) {
          if (!ns.isDirectory()) continue
          const manifestPath = path.join(installedDir, ns.name, "openscience-skills.json")
          try {
            const raw = await Bun.file(manifestPath).text()
            const parsed = JSON.parse(raw) as { entries?: unknown }
            if (Array.isArray(parsed.entries)) {
              entriesByNs.set(ns.name, new Set(parsed.entries.filter((e): e is string => typeof e === "string")))
            } else {
              entriesByNs.set(ns.name, null)
            }
          } catch {
            entriesByNs.set(ns.name, null)
          }
        }
      } catch {
        /* installedDir read failed — skip */
      }

      for await (const match of SKILL_GLOB.scan({
        cwd: installedDir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
        installedCount++
        // SKILL_GLOB matches <installedDir>/<ns>/skills/<name>/SKILL.md.
        const rel = match.slice(installedDir.length + 1)
        const segments = rel.split("/")
        const ns = segments[0]
        const skillName = segments[2]
        const entrySet = entriesByNs.get(ns)
        if (entrySet) {
          const skill = Object.values(skills).find((s) => s.location === match)
          if (skill) {
            skill.entry = entrySet.has(skillName) || entrySet.has(skill.name)
          }
        }
      }
      if (installedCount > 0) {
        log.info("Loaded installed skills", { count: installedCount })
      }
    }

    // Scan additional skill paths from config
    const config = await Config.get()
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)
      if (!(await Filesystem.isDir(resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      for await (const match of SKILL_GLOB.scan({
        cwd: resolved,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
      }
    }

    // System skills: embedded so they resolve in every install even when the
    // server catalog and the shipping binary omit them. Materialize to the cache
    // only when not already loaded (dev/source and API entries take precedence).
    // Respects the bundled-skills opt-out, same as the catalog.
    if (!Flag.OPENSCIENCE_DISABLE_BUNDLED_SKILLS) {
      for (const sys of SYSTEM_SKILLS) {
        if (skills[sys.name]) continue
        const file = path.join(Global.Path.cache, "system-skills", sys.name, "SKILL.md")
        if (!(await Bun.file(file).exists())) {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await Bun.write(file, sys.content)
        }
        await addSkill(file)
      }
    }

    return skills
  }

  export const state = Instance.state(compute)

  export async function invalidate() {
    State.clear(Instance.directory, compute)
    await Bus.publish(Event.Updated, {})
  }

  export async function writeUser(input: { name: string; content: string }) {
    const name = UserSkillName.parse(input.name)
    const dir = path.join(USER_SKILL_DIR, name)
    const file = path.join(dir, "SKILL.md")
    const tmp = path.join(USER_SKILL_DIR, `${name}.${Date.now()}.tmp.md`)
    await fs.mkdir(USER_SKILL_DIR, { recursive: true })
    await Bun.write(tmp, input.content, { mode: 0o600 })
    try {
      const md = await ConfigMarkdown.parse(tmp)
      const parsed = Info.pick({ name: true, description: true, category: true, tags: true, entry: true }).safeParse(
        md.data,
      )
      if (!parsed.success) {
        throw new InvalidError({
          path: file,
          message: "Skill frontmatter must include name and description.",
          issues: parsed.error.issues,
        })
      }
      if (parsed.data.name !== name) {
        throw new NameMismatchError({
          path: file,
          expected: name,
          actual: parsed.data.name,
        })
      }
      // Server-side moderation: block injection / catastrophic patterns the
      // same way URL-installed skills are screened (Layers 1 + 2). Warnings
      // (Layer 4) are advisory and don't block local authoring.
      const entry = {
        namespace: "user",
        name: parsed.data.name,
        description: parsed.data.description ?? "",
        content: input.content,
        scripts: [],
        references: [],
      }
      const rejected = [...runtimeRegexPass([entry]).rejected, ...classifierInjectionRegexPass([entry]).rejected]
      if (rejected.length > 0) {
        throw new InvalidError({
          path: file,
          message: `Skill rejected by safety review: ${rejected.map((r) => r.reason).join("; ")}`,
        })
      }
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(file, input.content, { mode: 0o600 })
      await invalidate()
      return {
        ...parsed.data,
        location: file,
      } satisfies Info
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  export async function deleteUser(name: string) {
    const safe = UserSkillName.parse(name)
    const dir = path.join(USER_SKILL_DIR, safe)
    await fs.rm(dir, { recursive: true, force: true })
    await invalidate()
    return true
  }

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x))
  }
}
