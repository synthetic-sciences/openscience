import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { parseSkillUrl } from "./namespace"
import { fetchManifest, type SkillEntry } from "./fetcher"
import {
  runtimeRegexPass,
  classifierInjectionRegexPass,
  suspiciousRegexPass,
  type Warning,
  type Rejection,
} from "./review"
import { Progress } from "./progress"
import { gitFetchPinned } from "./git-fetch"

export interface InstallOptions {
  confirm?: boolean
  progress?: Progress
}

export interface InstallResult {
  installed: { namespace: string; name: string; verdict: string }[]
  rejected: Rejection[]
  warnings: Warning[]
  reviewReasoningByName: Record<string, string>
}

function installedDir(): string {
  // Same path the loader scans (Global.Path.data defaults to ~/.openscience).
  // Allow tests to override via OPENSCIENCE_DATA_DIR without monkey-patching globals.
  const base = process.env.OPENSCIENCE_DATA_DIR ?? Global.Path.data
  return path.join(base, "installed-skills")
}

const LEDGER = ".openscience-install.json"

interface LocalInstall {
  repo_url: string
  pinned_sha: string
  installed_at: string
  skills: { name: string; description: string; verdict: "pass" | "warn" }[]
}

export namespace Install {
  /** Add skill(s) from a git URL. The repository, security verdict and all
   *  installed contents stay on this machine. */
  export async function add(url: string, options: InstallOptions = {}): Promise<InstallResult> {
    const confirm = options.confirm ?? true
    const progress = options.progress ?? Progress.silent()

    progress.start("Fetching repo")
    const parsed = parseSkillUrl(url)
    const { sha, tmpDir, manifest, entries } = await fetchManifest(parsed)

    try {
      progress.update("Performing security checks")

      // Layer 1
      const l1 = runtimeRegexPass(manifest)
      let surviving = manifest.filter((s) => !l1.rejected.find((r) => r.name === s.name))

      // Layer 2
      const l2 = classifierInjectionRegexPass(surviving)
      surviving = surviving.filter((s) => !l2.rejected.find((r) => r.name === s.name))

      const reasoningByName: Record<string, string> = {}
      const l4 = suspiciousRegexPass(surviving)

      progress.done("Security checks complete")

      const rejected = [...l1.rejected, ...l2.rejected]

      if (confirm && !(await confirmInteractive(parsed, sha, surviving, l4.warnings, reasoningByName))) {
        return {
          installed: [],
          rejected,
          warnings: l4.warnings,
          reviewReasoningByName: reasoningByName,
        }
      }

      // Write to disk. Layout mirrors the upstream plugin
      // convention: <ns>/skills/<name>/SKILL.md so future hooks/, scripts/
      // additions live where users expect.
      const installed: InstallResult["installed"] = []
      const nsDir = path.join(installedDir(), parsed.namespace)
      const skillsDir = path.join(nsDir, "skills")
      try {
        await fs.mkdir(skillsDir, { recursive: true })
        // Persist the repo's entry manifest (or absence thereof) so the
        // loader can filter user-facing skills from internal helpers.
        if (entries !== null) {
          await fs.writeFile(path.join(nsDir, "openscience-skills.json"), JSON.stringify({ entries }, null, 2))
        }
        for (const skill of surviving) {
          const skillDir = path.join(skillsDir, skill.name)
          await fs.mkdir(skillDir, { recursive: true })
          await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.content)
          for (const f of [...skill.scripts, ...skill.references]) {
            const target = path.join(skillDir, f.path)
            const resolved = path.resolve(target)
            if (!resolved.startsWith(path.resolve(skillDir) + path.sep)) {
              throw new Error(`Unsafe companion path in ${skill.name}: ${f.path}`)
            }
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, f.content)
          }

          const warningsForSkill = l4.warnings.filter((w) => w.name === skill.name)
          const verdict: "pass" | "warn" = warningsForSkill.length ? "warn" : "pass"
          installed.push({ namespace: skill.namespace, name: skill.name, verdict })
        }
        const ledger: LocalInstall = {
          repo_url: parsed.cloneUrl,
          pinned_sha: sha,
          installed_at: new Date().toISOString(),
          skills: surviving.map((skill) => ({
            name: skill.name,
            description: skill.description,
            verdict: l4.warnings.some((warning) => warning.name === skill.name) ? "warn" : "pass",
          })),
        }
        await Bun.write(path.join(nsDir, LEDGER), JSON.stringify(ledger, null, 2) + "\n")
      } catch (err) {
        // Rollback partial files
        await fs.rm(nsDir, { recursive: true, force: true }).catch(() => {})
        throw err
      }

      return {
        installed,
        rejected,
        warnings: l4.warnings,
        reviewReasoningByName: reasoningByName,
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Remove an installed skill (namespace or namespace/name) locally. */
  export async function remove(target: string): Promise<{ archived: number }> {
    const [namespace, name] = target.split("/", 2)
    const root = installedDir()

    if (name) {
      // Plugin layout: skill dir lives at <ns>/skills/<name>
      const dir = path.join(root, namespace, "skills", name)
      const existedLocally = await fs
        .stat(dir)
        .then(() => true)
        .catch(() => false)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { archived: existedLocally ? 1 : 0 }
    }

    const dir = path.join(root, namespace)
    const localCount = await fs
      .readdir(path.join(dir, "skills"))
      .then((entries) => entries.length)
      .catch(() => 0)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    return { archived: localCount }
  }

  export async function list(): Promise<{ namespace: string; name: string; description: string; verdict: string }[]> {
    const root = installedDir()
    const namespaces = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const groups = await Promise.all(
      namespaces
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = path.join(root, entry.name)
          const ledger = await Bun.file(path.join(dir, LEDGER))
            .json()
            .then((value) => value as LocalInstall)
            .catch(() => undefined)
          const records = new Map(ledger?.skills.map((skill) => [skill.name, skill]) ?? [])
          const skills = await fs.readdir(path.join(dir, "skills"), { withFileTypes: true }).catch(() => [])
          return Promise.all(
            skills
              .filter((skill) => skill.isDirectory())
              .map(async (skill) => {
                const record = records.get(skill.name)
                const content = await Bun.file(path.join(dir, "skills", skill.name, "SKILL.md"))
                  .text()
                  .catch(() => "")
                const description = record?.description ?? content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ""
                return {
                  namespace: entry.name,
                  name: skill.name,
                  description,
                  verdict: record?.verdict ?? "pass",
                }
              }),
          )
        }),
    )
    return groups.flat()
  }

  /** One-time compatibility import for installations that previously kept
   *  their third-party install ledger in Atlas. New installs never call Atlas. */
  export async function importLegacy(
    rows: {
      namespace: string
      name: string
      description: string
      repo_url: string
      pinned_sha: string
      review_verdict: string
    }[],
  ): Promise<number> {
    const root = installedDir()
    const groups = Map.groupBy(rows, (row) => row.namespace)
    const counts = await Promise.all(
      [...groups.entries()].map(async ([namespace, skills]) => {
        const dir = path.join(root, namespace)
        const current = await Bun.file(path.join(dir, LEDGER))
          .json()
          .then((value) => value as LocalInstall)
          .catch(() => undefined)
        const records = new Map(current?.skills.map((skill) => [skill.name, skill]) ?? [])
        const imported = await Promise.all(
          skills.map(async (skill) => {
            const target = path.join(dir, "skills", skill.name)
            if (await Bun.file(path.join(target, "SKILL.md")).exists()) return 0
            await gitFetchPinned({
              repo_url: skill.repo_url,
              pinned_sha: skill.pinned_sha,
              namespace,
              skillName: skill.name,
              destDir: target,
            })
            records.set(skill.name, {
              name: skill.name,
              description: skill.description,
              verdict: skill.review_verdict === "warn" ? "warn" : "pass",
            })
            return 1
          }),
        )
        const first = skills[0]
        if (!first) return 0
        const ledger: LocalInstall = {
          repo_url: current?.repo_url ?? first.repo_url,
          pinned_sha: current?.pinned_sha ?? first.pinned_sha,
          installed_at: current?.installed_at ?? new Date().toISOString(),
          skills: [...records.values()],
        }
        await fs.mkdir(dir, { recursive: true })
        await Bun.write(path.join(dir, LEDGER), JSON.stringify(ledger, null, 2) + "\n")
        return imported.reduce<number>((total, value) => total + value, 0)
      }),
    )
    return counts.reduce<number>((total, value) => total + value, 0)
  }
}

async function confirmInteractive(
  parsed: ReturnType<typeof parseSkillUrl>,
  sha: string,
  surviving: SkillEntry[],
  warnings: Warning[],
  reasoningByName: Record<string, string>,
): Promise<boolean> {
  const header = [
    `Adding skills from ${parsed.cloneUrl} @ ${sha.slice(0, 7)}`,
    `Namespace: ${parsed.namespace}`,
    `Safety review: ${warnings.length ? "warn" : "pass"}`,
    "",
  ].join("\n")
  process.stdout.write(header)
  for (const skill of surviving) {
    process.stdout.write(`  ${skill.name.padEnd(22)} ${skill.description}\n`)
    const ws = warnings.filter((w) => w.name === skill.name)
    for (const w of ws) {
      process.stdout.write(`    ⚠ ${w.file}:${w.line}  contains \`${w.pattern}\`\n`)
    }
    if (reasoningByName[skill.name]) {
      process.stdout.write(`    Reasoning: ${reasoningByName[skill.name]}\n`)
    }
  }
  process.stdout.write(`\n${surviving.length} skill(s) will be added. Proceed? [y/N] `)
  const answer = await readSingleLine()
  return /^y(es)?$/i.test(answer.trim())
}

async function readSingleLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = ""
    process.stdin.setEncoding("utf-8")
    const onData = (chunk: string) => {
      buf += chunk
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData)
        process.stdin.pause()
        resolve(buf.split("\n")[0])
      }
    }
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}
