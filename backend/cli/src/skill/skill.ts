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
import { lazy } from "@synsci/util/lazy"
import { Install } from "./install/install"
import { isRetiredProductSkillName, isRetiredProductSkillPath, RETIRED_PRODUCT_SKILL_NAMES } from "./retired"
import { purgeRetiredAtlasAgentInstall } from "./retired-install"
import { SkillCatalog } from "./catalog"
import { PermissionNext } from "@/permission/next"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  const AllowedTools = z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : value.split(/[\s,]+/)))
    .transform((value) =>
      [
        ...new Set(
          value.map((item) =>
            item
              .trim()
              .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
              .replace(/[-\s]+/g, "_")
              .toLowerCase(),
          ),
        ),
      ]
        .filter(Boolean)
        .filter((item) => /^[a-z0-9][a-z0-9_]*$/.test(item)),
    )
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    /** One line (under 120 characters) for always-visible indexes such as the
     *  core skill list; the description stays the full selection text. */
    summary: z.string().optional(),
    location: z.string(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    role: SkillCatalog.Role.optional(),
    capability: z.string().optional(),
    /** Provider-facing capabilities this skill may request after the user
     *  loads it. This only affects visibility; normal tool permissions remain
     *  authoritative at execution time. */
    allowed_tools: z.array(z.string()).optional(),
    requirements: z.object({ all: z.array(z.string()).optional(), any: z.array(z.string()).optional() }).optional(),
    catalog_status: SkillCatalog.Status.optional(),
    upstream: SkillCatalog.Upstream.optional(),
    origin: z.enum(["default", "installed", "user", "project"]),
    /** Whether the skill is user-facing (shows in / autocomplete) or an
     *  internal helper used transitively by other skills. Defaults to true.
     *  Driven by `openscience-skills.json` `entries[]` for URL-installed skills;
     *  bundled skills omit this and are always entries. */
    entry: z.boolean().optional(),
    /** Locations of same-named skills this one won over, so a local edit that
     *  had no effect is explained rather than silent. */
    shadows: z.array(z.string()).optional(),
  })
  export type Info = z.infer<typeof Info>

  export const Root = z
    .object({
      path: z.string(),
      kind: z.enum(["bundled", "project", "user", "installed", "config", "runtime"]),
      skills: z.number().int().nonnegative(),
      shadowed: z.number().int().nonnegative(),
    })
    .meta({ ref: "SkillRoot" })
  export type Root = z.infer<typeof Root>

  export const Shadowed = z
    .object({
      name: z.string(),
      location: z.string(),
      origin: z.enum(["default", "installed", "user", "project"]),
      by: z.string(),
    })
    .meta({ ref: "ShadowedSkill" })
  export type Shadowed = z.infer<typeof Shadowed>
  export const CatalogEntry = Info.extend({
    permission_action: PermissionNext.Action,
    recommended: z.boolean(),
    enabled: z.boolean().optional().describe("Selected for on-demand use; permissions remain independently enforced."),
    disabled_by: z.enum(["server", "project"]).optional(),
  })
  export type CatalogEntry = z.infer<typeof CatalogEntry>
  export type CatalogSnapshot = {
    /** Every user-facing skill in the library, annotated with its effective
     * permission state. Denied rows remain here so Settings can restore them. */
    library: CatalogEntry[]
    /** The only skills system routing, model search, and slash invocation may
     * advertise. Runtime permission checks remain authoritative at execution. */
    allowed: CatalogEntry[]
  }
  const Frontmatter = Info.pick({
    name: true,
    description: true,
    summary: true,
    category: true,
    tags: true,
    role: true,
    capability: true,
    allowed_tools: true,
    requirements: true,
    entry: true,
  }).extend({
    "allowed-tools": AllowedTools.optional(),
    allowed_tools: AllowedTools.optional(),
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
  const duplicates = new Set<string>()
  const recommended = new Set([
    "research-lookup",
    "literature-review",
    "paper-writing",
    "citations",
    "figures",
    "schematics",
    "exploratory-data-analysis",
  ])

  async function parse(match: string, origin: Info["origin"]) {
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
    if (!parsed.success) {
      // Same visibility as a YAML failure: a skill that silently vanishes from
      // the catalog because `description` is missing is indistinguishable from
      // one that was never installed.
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
        .join("; ")
      Bus.publish(Session.Event.Error, {
        error: new NamedError.Unknown({ message: `Skill ${match} has invalid frontmatter (${detail})` }).toObject(),
      })
      log.warn("invalid skill frontmatter", { path: match, issues: parsed.error.issues })
      return
    }

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

    const catalog = SkillCatalog.get(parsed.data.name)
    const info: Info = {
      name: parsed.data.name,
      description: parsed.data.description,
      summary: parsed.data.summary,
      location: match,
      category: parsed.data.category,
      tags: parsed.data.tags,
      role: parsed.data.role ?? catalog?.role,
      capability: parsed.data.capability ?? catalog?.capability,
      allowed_tools: parsed.data.allowed_tools ?? parsed.data["allowed-tools"],
      requirements: parsed.data.requirements ?? catalog?.requirements,
      catalog_status: catalog?.status,
      upstream: catalog?.upstream,
      entry: parsed.data.entry,
      origin,
    }
    return { info, content: md.content }
  }

  async function read(match: string, origin: Info["origin"]): Promise<Info | undefined> {
    return (await parse(match, origin))?.info
  }

  /** Read current instructions at use time. Catalogs retain metadata only. */
  export async function load(skill: Info) {
    const loaded = await parse(skill.location, skill.origin)
    if (!loaded || loaded.info.name !== skill.name) {
      throw new InvalidError({
        path: skill.location,
        message: `Skill ${skill.name} changed or is no longer valid. Refresh Skills and select it again.`,
      })
    }
    return loaded
  }

  const defaults = lazy(async () => {
    if (Flag.OPENSCIENCE_DISABLE_BUNDLED_SKILLS) return []
    const root = await BundledSkills.root()
    if (!root) return []
    const skills: Info[] = []
    let scanned = 0
    for (const match of (
      await Array.fromAsync(
        SKILL_GLOB.scan({
          cwd: root,
          absolute: true,
          onlyFiles: true,
          followSymlinks: false,
        }),
      )
    ).toSorted()) {
      const skill = await read(match, "default")
      if (skill) skills.push(skill)
      scanned++
    }
    // `count` is what the catalog exposes; `dropped` covers retired, disabled
    // and invalid files, so a release that ships a broken skill shows up here.
    log.info("Loaded bundled skills", { path: root, count: skills.length, dropped: scanned - skills.length })
    return skills
  })

  type Meta = { roots: Root[]; shadowed: Shadowed[]; revision: number }
  const meta = new WeakMap<Record<string, Info>, Meta>()
  const revisions = { value: 0 }

  async function compute() {
    const skills: Record<string, Info> = {}
    const disabled = Flag.OPENSCIENCE_DISABLED_SKILLS
    const shadowed: Shadowed[] = []
    const roots: Root[] = []
    /** Every scan below runs inside `scan(root, kind, ...)` so the catalog
     * can say which directories contributed and how many skills each won. */
    const scan = async (
      root: string,
      kind: Root["kind"],
      work: (accept: (skill: Info) => boolean) => Promise<void>,
    ) => {
      const entry: Root = { path: root, kind, skills: 0, shadowed: 0 }
      await work((skill) => {
        const accepted = add(skill)
        if (accepted) entry.skills += 1
        return accepted
      })
      roots.push(entry)
    }

    const add = (skill: Info): boolean => {
      const directory = path.basename(path.dirname(skill.location))
      if (isRetiredProductSkillName(skill.name) || isRetiredProductSkillName(directory)) return false
      if (disabled.has(skill.name) || disabled.has(directory)) {
        log.info("Skipped skill disabled by operator policy", { name: skill.name, directory, path: skill.location })
        return false
      }
      const existing = skills[skill.name]
      const origin = skill.origin
      if (existing && priority[existing.origin] > priority[origin]) {
        shadowed.push({ name: skill.name, location: skill.location, origin, by: existing.location })
        existing.shadows = [...(existing.shadows ?? []), skill.location]
        return false
      }
      if (existing) {
        shadowed.push({ name: skill.name, location: existing.location, origin: existing.origin, by: skill.location })
        skill.shadows = [...(existing.shadows ?? []), existing.location]
        // The catalog is rebuilt on every invalidation; the same collision
        // warned once per build is log spam, so warn once per process per
        // pair and demote later builds to debug.
        const pair = [skill.name, ...[existing.location, skill.location].toSorted()].join("\0")
        const level = duplicates.has(pair) ? "debug" : "warn"
        duplicates.add(pair)
        log[level]("duplicate skill name", {
          name: skill.name,
          existing: existing.location,
          duplicate: skill.location,
        })
      }
      skills[skill.name] = skill
      return true
    }

    const addSkill = async (match: string, origin: Info["origin"], accept: (skill: Info) => boolean = add) => {
      const skill = await read(match, origin)
      if (skill) accept(skill)
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
      for (const dir of claudeDirs.toReversed()) {
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

        await scan(path.join(dir, "skills"), "project", async (accept) => {
          for (const match of matches.toSorted()) await addSkill(match, "project", accept)
        })
      }

      if (await Filesystem.isDir(globalClaude)) {
        await scan(path.join(globalClaude, "skills"), "installed", async (accept) => {
          for (const match of (
            await Array.fromAsync(
              CLAUDE_SKILL_GLOB.scan({
                cwd: globalClaude,
                absolute: true,
                onlyFiles: true,
                followSymlinks: true,
                dot: true,
              }),
            )
          ).toSorted()) {
            await addSkill(match, "installed", accept)
          }
        })
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
    const projectSet = new Set(projectDirs)
    const directories = new Set([
      ...(await Config.executableDirectories()).filter((dir) => !projectSet.has(dir)),
      ...projectDirs.toSorted((a, b) => a.length - b.length || a.localeCompare(b)),
    ])

    // Scan .openscience/skill/ directories
    for (const dir of directories) {
      const matches = (
        await Array.fromAsync(
          OPENSCIENCE_SKILL_GLOB.scan({
            cwd: dir,
            absolute: true,
            onlyFiles: true,
            followSymlinks: true,
          }),
        )
      ).toSorted()
      if (!matches.length) continue
      const origin = projectSet.has(dir) ? "project" : "user"
      await scan(dir, origin, async (accept) => {
        for (const match of matches) await addSkill(match, origin, accept)
      })
    }

    // Default skills are an immutable release asset. Source builds scan the
    // repository tree; compiled releases materialize their embedded archive to
    // a versioned cache directory. Neither path needs Atlas or a network.
    const bundled = await defaults().catch((error) => {
      defaults.reset()
      State.clear(Instance.directory, compute)
      throw error
    })
    if (bundled.length) {
      const bundledRoot = path.dirname(path.dirname(path.dirname(bundled[0]!.location)))
      await scan(bundledRoot, "bundled", async (accept) => {
        for (const skill of bundled) accept(skill)
      })
    }

    // === User Skills: authored locally via openscience/web, private by default ===
    for (const name of RETIRED_PRODUCT_SKILL_NAMES) {
      await fs.rm(path.join(USER_SKILL_DIR, name), { recursive: true, force: true }).catch(() => {})
    }
    if (await Filesystem.isDir(USER_SKILL_DIR)) {
      let userCount = 0
      await scan(USER_SKILL_DIR, "user", async (accept) => {
        for (const match of (
          await Array.fromAsync(
            SKILL_GLOB.scan({
              cwd: USER_SKILL_DIR,
              absolute: true,
              onlyFiles: true,
              followSymlinks: true,
            }),
          )
        ).toSorted()) {
          await addSkill(match, "user", accept)
          userCount++
        }
      })
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

      const installedMatches = (
        await Array.fromAsync(
          SKILL_GLOB.scan({
            cwd: installedDir,
            absolute: true,
            onlyFiles: true,
            followSymlinks: true,
          }),
        )
      ).toSorted()
      const installedRoot: Root = { path: installedDir, kind: "installed", skills: 0, shadowed: 0 }
      if (installedMatches.length) roots.push(installedRoot)
      for (const match of installedMatches) {
        await addSkill(match, "installed", (skill) => {
          const accepted = add(skill)
          if (accepted) installedRoot.skills += 1
          return accepted
        })
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

    // Scan additional skill roots: `skills.paths` from config, then the roots
    // registered through the API for this project (no restart needed). Both
    // load as project skills, the highest precedence, because the user put
    // them there on purpose.
    const config = await Config.getExecution()
    const configured = (config.skills?.paths ?? []).map(resolveRoot)
    const extra = [
      ...configured.map((root) => ({ root, kind: "config" as const })),
      ...[...runtimeRoots()]
        .filter((root) => !configured.includes(root))
        .map((root) => ({ root, kind: "runtime" as const })),
    ]
    for (const { root, kind } of extra) {
      if (!(await Filesystem.isDir(root))) {
        log.warn("skill path not found", { path: root })
        continue
      }
      await scan(root, kind, async (accept) => {
        for (const match of (
          await Array.fromAsync(
            SKILL_GLOB.scan({
              cwd: root,
              absolute: true,
              onlyFiles: true,
              followSymlinks: true,
            }),
          )
        ).toSorted()) {
          await addSkill(match, "project", accept)
        }
      })
    }

    // Counts are settled once every root has been scanned: a skill accepted
    // early can still lose to a later root, and belongs to the winner's count
    // only while it wins.
    const within = (location: string) =>
      roots
        .filter((item) => location.startsWith(`${item.path}${path.sep}`))
        .sort((a, b) => b.path.length - a.path.length)[0]
    for (const root of roots) {
      root.skills = 0
      root.shadowed = 0
    }
    for (const skill of Object.values(skills)) {
      const root = within(skill.location)
      if (root) root.skills += 1
    }
    for (const entry of shadowed) {
      const root = within(entry.location)
      if (root) root.shadowed += 1
    }
    revisions.value += 1
    meta.set(skills, { roots, shadowed, revision: revisions.value })
    return skills
  }

  /** Roots registered for this project through the API; never written to
   * disk unless the caller asked to persist them. */
  const runtimeRoots = Instance.state(() => new Set<string>())

  function resolveRoot(raw: string) {
    const expanded = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw
    return path.normalize(path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded))
  }

  /** Every directory contributing to the catalog, with what each one won and
   * what it lost to a same-named skill elsewhere. */
  export async function roots(): Promise<{ roots: Root[]; shadowed: Shadowed[]; revision: number }> {
    const current = await state()
    const info = meta.get(current)
    return info ?? { roots: [], shadowed: [], revision: revisions.value }
  }

  export const RootError = NamedError.create(
    "SkillRootError",
    z.object({ path: z.string(), code: z.enum(["missing", "empty", "duplicate", "unknown"]), message: z.string() }),
  )

  /**
   * Register a directory as a skill root for this project. The directory must
   * exist and hold at least one SKILL.md (a typo'd path is the failure people
   * hit, and it must not be a silent no-op); a root that is already active is
   * an error rather than a second copy of every skill. With `persist`, the
   * absolute path is written to `skills.paths` in the global or project
   * config so it survives a restart.
   */
  export async function addRoot(raw: string, options: { persist?: "global" | "project" } = {}): Promise<Root> {
    const resolved = resolveRoot(raw)
    if (!(await Filesystem.isDir(resolved))) {
      throw new RootError({ path: resolved, code: "missing", message: `${resolved} is not a directory` })
    }
    const first = await Array.fromAsync(SKILL_GLOB.scan({ cwd: resolved, onlyFiles: true, followSymlinks: true }))
    if (!first.length) {
      throw new RootError({ path: resolved, code: "empty", message: `${resolved} contains no SKILL.md` })
    }
    const active = (await roots()).roots.some((root) => root.path === resolved)
    if (active || runtimeRoots().has(resolved)) {
      throw new RootError({ path: resolved, code: "duplicate", message: `${resolved} is already a skill root` })
    }
    if (options.persist) {
      const current =
        options.persist === "global" ? (await Config.getGlobal()).skills?.paths : (await Config.get()).skills?.paths
      const paths = [...(current ?? []), resolved]
      if (options.persist === "global") await Config.updateGlobal({ skills: { paths } })
      else await Config.update({ skills: { paths } })
    }
    runtimeRoots().add(resolved)
    await invalidate()
    log.info("skill root added", { path: resolved, persist: options.persist ?? false })
    const found = (await roots()).roots.find((root) => root.path === resolved)
    return found ?? { path: resolved, kind: "runtime", skills: 0, shadowed: 0 }
  }

  /** Drop a root registered at runtime, and with `persist` also remove it
   * from the config list it was written to. */
  export async function removeRoot(raw: string, options: { persist?: "global" | "project" } = {}) {
    const resolved = resolveRoot(raw)
    const known = runtimeRoots().delete(resolved)
    let persisted = false
    if (options.persist) {
      const current =
        options.persist === "global" ? (await Config.getGlobal()).skills?.paths : (await Config.get()).skills?.paths
      const paths = (current ?? []).filter((item) => resolveRoot(item) !== resolved)
      if (paths.length !== (current ?? []).length) {
        persisted = true
        if (options.persist === "global") await Config.updateGlobal({ skills: { paths } })
        else await Config.update({ skills: { paths } })
      }
    }
    if (!known && !persisted) {
      throw new RootError({ path: resolved, code: "unknown", message: `${resolved} is not a registered skill root` })
    }
    await invalidate()
    log.info("skill root removed", { path: resolved, persist: options.persist ?? false })
  }

  /** The instructions of one skill, for clients without filesystem access. */
  export async function content(
    name: string,
  ): Promise<{ name: string; location: string; content: string } | undefined> {
    const skill = await get(name)
    if (!skill) return
    const text = await Bun.file(skill.location).text()
    return { name: skill.name, location: skill.location, content: text }
  }

  export const state = Instance.state(compute)
  const lists = new WeakMap<Record<string, Info>, Info[]>()
  const catalogs = new WeakMap<Info[], Map<string, CatalogSnapshot>>()

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
        role: parsed.data.role ?? SkillCatalog.get(parsed.data.name)?.role,
        capability: parsed.data.capability ?? SkillCatalog.get(parsed.data.name)?.capability,
        allowed_tools: parsed.data.allowed_tools ?? parsed.data["allowed-tools"],
        requirements: parsed.data.requirements ?? SkillCatalog.get(parsed.data.name)?.requirements,
        catalog_status: SkillCatalog.get(parsed.data.name)?.status,
        upstream: SkillCatalog.get(parsed.data.name)?.upstream,
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

  export async function get(name: string, options: { includeDisabled?: boolean } = {}) {
    if (isRetiredProductSkillName(name)) return undefined
    if (!options.includeDisabled && (await selection()).has(name)) return undefined
    return state().then((x) => {
      const skill = x[name]
      return skill?.catalog_status === "blocked" ? undefined : skill
    })
  }

  export async function all(options: { includeDisabled?: boolean } = {}) {
    if (options.includeDisabled) return entries()
    const disabled = await selection()
    const skills = await entries()
    if (!disabled.size) return skills
    return skills.filter((skill) => !disabled.has(skill.name))
  }

  async function selection() {
    const [global, project] = await Promise.all([Config.getGlobal(), Config.get()])
    // A project's selection can narrow the server default, not silently turn
    // a skill back on after the user disabled it for this installation.
    return new Map([
      ...(project.skills?.disabled ?? []).map((name) => [name, "project"] as const),
      ...(global.skills?.disabled ?? []).map((name) => [name, "server"] as const),
    ])
  }

  async function entries() {
    const current = await state()
    const cached = lists.get(current)
    if (cached) return cached
    const value = Object.values(current).filter(
      (skill) => !isRetiredProductSkillName(skill.name) && skill.catalog_status !== "blocked",
    )
    lists.set(current, value)
    return value
  }

  /** Build the single permission-annotated catalog consumed by every skill
   * discovery surface. Skill contents stay lazy; this snapshot contains only
   * the already-indexed frontmatter metadata. */
  export async function catalog(permission: PermissionNext.Ruleset): Promise<CatalogSnapshot> {
    const current = await entries()
    const disabled = await selection()
    const key = JSON.stringify([permission, [...disabled].sort()])
    const cached = catalogs.get(current)?.get(key)
    if (cached) return cached

    const library = current.map((skill) => ({
      ...skill,
      permission_action: PermissionNext.evaluate("skill", skill.name, permission).action,
      recommended: recommended.has(skill.name),
      enabled: !disabled.has(skill.name),
      disabled_by: disabled.get(skill.name),
    }))
    const snapshot = {
      library,
      allowed: library.filter((skill) => skill.enabled && skill.permission_action !== "deny"),
    }
    const snapshots = catalogs.get(current) ?? new Map<string, CatalogSnapshot>()
    snapshots.set(key, snapshot)
    if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!)
    catalogs.set(current, snapshots)
    return snapshot
  }
}
