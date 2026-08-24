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
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Session } from "@/session"
import { ProjectTrust } from "@/project/trust"
import { BundledSkills } from "./bundled"
import { lazy } from "@/util/lazy"
import { Install } from "./install/install"
import { isRetiredProductSkillName, isRetiredProductSkillPath, RETIRED_PRODUCT_SKILL_NAMES } from "./retired"
import { purgeRetiredAtlasAgentInstall } from "./retired-install"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    origin: z.enum(["default", "installed", "user", "project"]),
    /** Whether the skill is user-facing (shows in / autocomplete) or an
     *  internal helper used transitively by other skills. Defaults to true.
     *  Driven by `openscience-skills.json` `entries[]` for URL-installed skills;
     *  bundled skills omit this and are always entries. */
    entry: z.boolean().optional(),
  })
  export type Info = z.infer<typeof Info>
  const Frontmatter = Info.pick({ name: true, description: true, category: true, tags: true, entry: true }).extend({
    disabled: z.boolean().optional(),
  })

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
  const priority = { default: 0, installed: 1, user: 2, project: 3 } as const

  async function read(match: string, origin: Info["origin"]): Promise<Info | undefined> {
    const md = await ConfigMarkdown.parse(match).catch((err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse skill ${match}`
      Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
      log.error("failed to load skill", { skill: match, err })
      return undefined
    })
    if (!md) return

    const parsed = Frontmatter.safeParse(md.data)
    if (!parsed.success) return

    if (isRetiredProductSkillName(parsed.data.name) || isRetiredProductSkillPath(match)) {
      log.info("Skipped retired product skill", { name: parsed.data.name, path: match })
      return
    }

    if (parsed.data.disabled) {
      log.info("Skipped skill disabled by frontmatter", { name: parsed.data.name, path: match })
      return
    }

    const desc = parsed.data.description.toLowerCase()
    if (desc.includes("always run this skill") || desc.includes("must always run")) {
      log.warn("blocked skill with injection pattern", {
        name: parsed.data.name,
        reason: "description contains injection directive",
      })
      return
    }

    return {
      name: parsed.data.name,
      description: parsed.data.description,
      location: match,
      category: parsed.data.category,
      tags: parsed.data.tags,
      entry: parsed.data.entry,
      origin,
    }
  }

  const defaults = lazy(async () => {
    if (Flag.OPENSCIENCE_DISABLE_BUNDLED_SKILLS) return []
    const root = await BundledSkills.root()
    if (!root) return []
    const skills: Info[] = []
    let count = 0
    for await (const match of SKILL_GLOB.scan({
      cwd: root,
      absolute: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const skill = await read(match, "default")
      if (skill) skills.push(skill)
      count++
    }
    log.info("Loaded bundled skills", { path: root, count })
    return skills
  })

  async function compute() {
    const skills: Record<string, Info> = {}
    const disabled = Flag.OPENSCIENCE_DISABLED_SKILLS

    const add = (skill: Info) => {
      const directory = path.basename(path.dirname(skill.location))
      if (isRetiredProductSkillName(skill.name) || isRetiredProductSkillName(directory)) return
      if (disabled.has(skill.name) || disabled.has(directory)) {
        log.info("Skipped skill disabled by operator policy", { name: skill.name, directory, path: skill.location })
        return
      }
      const existing = skills[skill.name]
      const origin = skill.origin
      if (existing && priority[existing.origin] > priority[origin]) return
      if (existing) {
        log.warn("duplicate skill name", {
          name: skill.name,
          existing: existing.location,
          duplicate: skill.location,
        })
      }
      skills[skill.name] = skill
    }

    const addSkill = async (match: string, origin: Info["origin"]) => {
      const skill = await read(match, origin)
      if (skill) add(skill)
    }

    // Scan .claude/skills/ directories (project-level)
    const claudeDirs = (await ProjectTrust.allowed(Instance.project))
      ? await Array.fromAsync(
          Filesystem.up({
            targets: [".claude"],
            start: Instance.directory,
            stop: Instance.worktree,
          }),
        )
      : []
    const globalClaude = `${Global.Path.home}/.claude`
    // Startup performs this before account gating. Keep the catalog boundary
    // defensive too for SDK consumers that call Skill directly.
    const retired = await purgeRetiredAtlasAgentInstall(Global.Path.home).catch((error) => {
      log.warn("failed to purge retired Atlas agent install", { error })
      return 0
    })
    if (retired > 0) log.info("Removed retired Atlas agent install artifacts", { count: retired })
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
          await addSkill(match, "project")
        }
      }

      if (await Filesystem.isDir(globalClaude)) {
        for await (const match of CLAUDE_SKILL_GLOB.scan({
          cwd: globalClaude,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        })) {
          await addSkill(match, "installed")
        }
      }
    }

    // Config caches directories for the lifetime of a project instance. A
    // project may create its first .openscience/skills directory after a chat
    // has already started, so discover trusted project roots again whenever
    // the skill catalog itself is invalidated.
    const projectDirs =
      !Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG && (await ProjectTrust.allowed(Instance.project))
        ? await Array.fromAsync(
            Filesystem.up({
              targets: [".openscience", ".synsc"],
              start: Instance.directory,
              stop: Instance.worktree,
            }),
          )
        : []
    const directories = new Set([...(await Config.executableDirectories()), ...projectDirs])

    // Scan .openscience/skill/ directories
    for (const dir of directories) {
      for await (const match of OPENSCIENCE_SKILL_GLOB.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match, "project")
      }
    }

    // Default skills are an immutable release asset. Source builds scan the
    // repository tree; compiled releases materialize their embedded archive to
    // a versioned cache directory. Neither path needs Atlas or a network.
    for (const skill of await defaults()) add(skill)

    // === User Skills: authored locally via openscience/web, private by default ===
    for (const name of RETIRED_PRODUCT_SKILL_NAMES) {
      await fs.rm(path.join(USER_SKILL_DIR, name), { recursive: true, force: true }).catch(() => {})
    }
    if (await Filesystem.isDir(USER_SKILL_DIR)) {
      let userCount = 0
      for await (const match of SKILL_GLOB.scan({
        cwd: USER_SKILL_DIR,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match, "user")
        userCount++
      }
      if (userCount > 0) {
        log.info("Loaded user skills", { count: userCount })
      }
    }

    // === Installed Skills: URL-installed third-party skills ===
    // Local-first store at:
    //   ~/.openscience/installed-skills/<ns>/skills/<name>/SKILL.md
    // mirroring the upstream plugin convention. The repository pointer,
    // pinned SHA and local security verdict live beside the installed files.
    const installedDir = path.join(Global.Path.data, "installed-skills")

    // Remove only the exact retired product commands from the local install
    // store. Similarly named third-party skills remain untouched.
    await Install.purgeRetired()

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
        await addSkill(match, "installed")
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
    const config = await Config.getExecution()
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
        await addSkill(match, "project")
      }
    }

    return skills
  }

  export const state = Instance.state(compute)
  const lists = new WeakMap<Record<string, Info>, Info[]>()

  export async function invalidate() {
    State.clear(Instance.directory, compute)
    await Bus.publish(Event.Updated, {})
  }

  export async function writeUser(input: { name: string; content: string }) {
    const name = UserSkillName.parse(input.name)
    const dir = path.join(USER_SKILL_DIR, name)
    const file = path.join(dir, "SKILL.md")
    if (isRetiredProductSkillName(name)) {
      throw new InvalidError({ path: file, message: `Skill ${name} has been retired and cannot be restored.` })
    }
    const tmp = path.join(USER_SKILL_DIR, `${name}.${Date.now()}.tmp.md`)
    await fs.mkdir(USER_SKILL_DIR, { recursive: true })
    await Bun.write(tmp, input.content, { mode: 0o600 })
    try {
      const md = await ConfigMarkdown.parse(tmp)
      const parsed = Frontmatter.safeParse(md.data)
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
      if (isRetiredProductSkillName(parsed.data.name)) {
        throw new InvalidError({
          path: file,
          message: `Skill ${parsed.data.name} has been retired and cannot be restored.`,
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
        name: parsed.data.name,
        description: parsed.data.description,
        category: parsed.data.category,
        tags: parsed.data.tags,
        entry: parsed.data.entry,
        location: file,
        origin: "user",
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
    if (isRetiredProductSkillName(name)) return undefined
    return state().then((x) => x[name])
  }

  export async function all() {
    const current = await state()
    const cached = lists.get(current)
    if (cached) return cached
    const value = Object.values(current).filter((skill) => !isRetiredProductSkillName(skill.name))
    lists.set(current, value)
    return value
  }
}
