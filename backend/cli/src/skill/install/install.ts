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
import { OpenScience } from "../../openscience"

export interface InstallOptions {
  confirm?: boolean
  progress?: Progress
  /** Skip Layer 3 (LLM classifier) and the cloud upload side-effect. Local
   *  install only. Local regex layers (1, 2, 4) still run. Off by default;
   *  on means "I accept that no LLM reviewed this skill." */
  skipClassifier?: boolean
}

export interface InstallResult {
  installed: { namespace: string; name: string; verdict: string }[]
  rejected: Rejection[]
  warnings: Warning[]
  reviewReasoningByName: Record<string, string>
}

function installedDir(): string {
  // Same path the loader scans (Global.Path.data resolves XDG_DATA_HOME first).
  // Allow tests to override via OPENSCIENCE_DATA_DIR without monkey-patching globals.
  const base = process.env.OPENSCIENCE_DATA_DIR ?? Global.Path.data
  return path.join(base, "installed-skills")
}

export namespace Install {
  /** Add skill(s) from a git URL. Local-first: writes to disk, then
   *  uploads. Throws on unrecoverable error (URL invalid, no skills, etc.). */
  export async function add(url: string, options: InstallOptions = {}): Promise<InstallResult> {
    const confirm = options.confirm ?? true
    const progress = options.progress ?? Progress.silent()
    const skipClassifier = options.skipClassifier ?? false

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

      // Layer 3 (server-side) — skipped when --skip-classifier is set.
      const reasoningByName: Record<string, string> = {}
      const classifierRejected: Rejection[] = []
      if (!skipClassifier && surviving.length > 0) {
        const review = await OpenScience.requestSkillReview(
          surviving.map((s) => ({
            namespace: s.namespace,
            name: s.name,
            description: s.description,
            content: s.content,
            scripts: s.scripts,
          })),
        )
        if (!review) {
          throw new Error(
            "Layer-3 classifier unreachable. Aborting install. " +
              "(Pass --skip-classifier to bypass at your own risk.)",
          )
        }
        for (const r of review.per_skill) {
          reasoningByName[r.name] = r.reasoning
          if (r.verdict === "reject") {
            classifierRejected.push({
              name: r.name,
              reason: `classifier rejected: ${r.reasoning}`,
            })
          }
        }
        surviving = surviving.filter((s) => !classifierRejected.find((r) => r.name === s.name))
      }

      // Layer 4
      const l4 = suspiciousRegexPass(surviving)

      progress.done("Security checks complete")

      const rejected = [...l1.rejected, ...l2.rejected, ...classifierRejected]

      if (confirm && !(await confirmInteractive(parsed, sha, surviving, l4.warnings, reasoningByName))) {
        return {
          installed: [],
          rejected,
          warnings: l4.warnings,
          reviewReasoningByName: reasoningByName,
        }
      }

      // Write to disk + upload. Layout mirrors the upstream plugin
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
          for (const f of skill.scripts) {
            const target = path.join(skillDir, f.path)
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, f.content)
          }
          for (const f of skill.references) {
            const target = path.join(skillDir, f.path)
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, f.content)
          }

          const warningsForSkill = l4.warnings.filter((w) => w.name === skill.name)
          const verdict: "pass" | "warn" = warningsForSkill.length ? "warn" : "pass"
          if (!skipClassifier) {
            // Pointer-only upload — the backend stores the install ledger
            // (repo_url + pinned_sha + classifier verdict), not the SKILL.md
            // content. Other machines re-fetch from git on next sync.
            // Best-effort; local install stands if the upload fails.
            await OpenScience.postInstalledSkill({
              namespace: skill.namespace,
              name: skill.name,
              description: skill.description,
              repo_url: parsed.cloneUrl,
              pinned_sha: sha,
              review_verdict: verdict,
              review_meta: {
                reasoning: reasoningByName[skill.name] ?? "",
                warnings: warningsForSkill,
              },
            }).catch(() => {
              /* swallow — disk is canonical */
            })
          }
          installed.push({ namespace: skill.namespace, name: skill.name, verdict })
        }
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

  /** Remove an installed skill (namespace or namespace/name).
   *
   *  Local-first: the on-disk directory is always removed if it exists.
   *  The backend archive call is best-effort — if it fails (offline,
   *  unauthorized, etc.) the local view still reflects the removal. The
   *  next successful sync will reconcile. The returned count reflects what
   *  was removed locally OR archived on the backend, whichever is larger,
   *  so the user sees a stable count even when offline. */
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
      const ok = await OpenScience.deleteInstalledSkill(namespace, name).catch(() => false)
      return { archived: ok || existedLocally ? 1 : 0 }
    }

    const dir = path.join(root, namespace)
    let localCount = 0
    try {
      const entries = await fs.readdir(path.join(dir, "skills"))
      localCount = entries.length
    } catch {
      /* skills/ subdir absent */
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    const result = await OpenScience.deleteInstalledNamespace(namespace).catch(() => null)
    return { archived: Math.max(result?.archived ?? 0, localCount) }
  }

  export async function list(): Promise<{ namespace: string; name: string; description: string; verdict: string }[]> {
    const rows = await OpenScience.fetchInstalledSkills()
    return (rows ?? []).map((r) => ({
      namespace: r.namespace,
      name: r.name,
      description: r.description,
      verdict: r.review_verdict,
    }))
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
