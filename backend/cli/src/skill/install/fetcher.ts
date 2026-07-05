import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { $ } from "bun"
import type { ParsedSkillUrl } from "./namespace"

export interface ScriptFile {
  path: string
  content: string
}

export interface SkillEntry {
  namespace: string
  name: string
  description: string
  content: string
  scripts: ScriptFile[]
  references: ScriptFile[]
}

export interface FetchResult {
  repo: string
  sha: string
  tmpDir: string
  manifest: SkillEntry[]
  /** Repo's declared user-facing entry points (from `openscience-skills.json` at
   *  repo root). Null means the repo didn't declare a manifest — caller
   *  should treat every skill as an entry (backwards-compat). */
  entries: string[] | null
}

/** Clone `parsed.cloneUrl` shallowly into a tmp dir, pin the commit SHA,
 *  enumerate `skills/<name>/SKILL.md` files, and return them with companion
 *  files (scripts/, references/) included.
 *
 *  Caller is responsible for cleaning up `tmpDir` via
 *  `rm(..., { recursive: true })`.
 */
export async function fetchManifest(parsed: ParsedSkillUrl): Promise<FetchResult> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openscience-skill-"))

  const cloneArgs = parsed.ref
    ? ["clone", "--depth", "1", "--branch", parsed.ref, parsed.cloneUrl, tmpDir]
    : ["clone", "--depth", "1", parsed.cloneUrl, tmpDir]
  // Fail fast on auth challenges instead of hanging on a credential prompt.
  // Skill install runs in agent/CLI contexts where there's no interactive
  // human to type a username; if the repo needs auth, the user should
  // configure git credentials themselves before retrying.
  const clone = await $`git ${cloneArgs}`
    .env({
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    })
    .quiet()
    .nothrow()
  if (clone.exitCode !== 0) {
    await rm(tmpDir, { recursive: true, force: true })
    throw new Error(`git clone failed: ${clone.stderr.toString()}`)
  }

  const sha = (await $`git rev-parse HEAD`.cwd(tmpDir).text()).trim()

  const rootForScan = parsed.path ? path.join(tmpDir, parsed.path) : path.join(tmpDir, "skills")

  const skillDirs: string[] = []
  try {
    const entries = await readdir(rootForScan, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(rootForScan, e.name)
      const skillMd = path.join(full, "SKILL.md")
      try {
        await stat(skillMd)
        skillDirs.push(full)
      } catch {
        /* no SKILL.md, skip */
      }
    }
  } catch {
    // root dir missing
  }

  if (skillDirs.length === 0) {
    await rm(tmpDir, { recursive: true, force: true })
    throw new Error("No skills found in repo. Expected `skills/<name>/SKILL.md` files.")
  }

  const manifest: SkillEntry[] = []
  for (const dir of skillDirs) {
    const name = path.basename(dir)
    const content = await readFile(path.join(dir, "SKILL.md"), "utf-8")
    const description = extractDescription(content)
    const scripts = await collectCompanion(dir, "scripts")
    const references = await collectCompanion(dir, "references")
    manifest.push({
      namespace: parsed.namespace,
      name,
      description,
      content,
      scripts,
      references,
    })
  }

  // Optional manifest: `openscience-skills.json` at repo root listing entries.
  // Tolerate malformed JSON (treat as absent rather than failing the install).
  let entries: string[] | null = null
  try {
    const manifestPath = path.join(tmpDir, "openscience-skills.json")
    await stat(manifestPath)
    const raw = await readFile(manifestPath, "utf-8")
    const parsedManifest = JSON.parse(raw) as { entries?: unknown }
    if (Array.isArray(parsedManifest.entries)) {
      entries = parsedManifest.entries.filter((e): e is string => typeof e === "string")
    }
  } catch {
    /* missing or malformed — leave entries null */
  }

  return { repo: parsed.cloneUrl, sha, tmpDir, manifest, entries }
}

/** Pull the `description:` field out of YAML frontmatter, or empty. */
function extractDescription(skillMd: string): string {
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return ""
  const line = fmMatch[1].split("\n").find((l) => l.trim().startsWith("description:"))
  if (!line) return ""
  return line
    .replace(/^\s*description:\s*/, "")
    .replace(/^["']|["']$/g, "")
    .trim()
}

async function collectCompanion(skillDir: string, sub: string): Promise<ScriptFile[]> {
  const subDir = path.join(skillDir, sub)
  try {
    await stat(subDir)
  } catch {
    return []
  }
  const out: ScriptFile[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        const rel = path.relative(skillDir, full)
        const content = await readFile(full, "utf-8")
        out.push({ path: rel, content })
      }
    }
  }
  await walk(subDir)
  return out
}
