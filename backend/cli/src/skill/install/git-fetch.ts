import { mkdtemp, readFile, rm, mkdir, stat, readdir, copyFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { $ } from "bun"
import { runtimeRegexPass, classifierInjectionRegexPass, type Warning } from "./review"
import type { SkillEntry } from "./fetcher"

interface FetchPinnedParams {
  repo_url: string
  pinned_sha: string
  namespace: string
  skillName: string
  destDir: string
}

/** Sync-time git fetch: clone the pinned SHA, copy one skill's tree into
 *  destDir, run Layers 1 & 2 regex as paranoid defense-in-depth (the SHA
 *  is content-addressed so contents are immutable, but if they ever match
 *  a Tier-1 pattern we want to refuse — could mean the original install's
 *  Layer-3 was bypassed somehow).
 *
 *  Skips Layer 3 — the first install's classifier verdict is authoritative.
 *  Server-side `archived_at` is the kill-switch: an archived row simply
 *  doesn't appear in fetchInstalledSkills, so sync never even tries.
 */
export async function gitFetchPinned(params: FetchPinnedParams): Promise<void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openscience-skill-sync-"))
  try {
    // Clone full repo at default branch, then checkout the pinned SHA.
    // Shallow `--depth 1` won't work because we need an arbitrary SHA.
    const clone = await $`git clone --quiet ${params.repo_url} ${tmpDir}`
      .env({
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      })
      .quiet()
      .nothrow()
    if (clone.exitCode !== 0) {
      throw new Error(`git clone failed: ${clone.stderr.toString()}`)
    }
    const checkout = await $`git checkout --quiet ${params.pinned_sha}`.cwd(tmpDir).quiet().nothrow()
    if (checkout.exitCode !== 0) {
      throw new Error(`pinned SHA ${params.pinned_sha} unreachable: ${checkout.stderr.toString()}`)
    }

    const srcSkill = path.join(tmpDir, "skills", params.skillName)
    const srcSkillMd = path.join(srcSkill, "SKILL.md")
    try {
      await stat(srcSkillMd)
    } catch {
      throw new Error(`skill ${params.namespace}/${params.skillName} not found in repo at this SHA`)
    }

    // Paranoid local defense-in-depth (cheap, fast)
    const content = await readFile(srcSkillMd, "utf-8")
    const fakeEntry: SkillEntry = {
      namespace: params.namespace,
      name: params.skillName,
      description: "",
      content,
      scripts: [],
      references: [],
    }
    const l1 = runtimeRegexPass([fakeEntry])
    if (l1.rejected.length > 0) {
      throw new Error(`Layer-1 reject on sync: ${l1.rejected[0]!.reason}`)
    }
    const l2 = classifierInjectionRegexPass([fakeEntry])
    if (l2.rejected.length > 0) {
      throw new Error(`Layer-2 reject on sync: ${l2.rejected[0]!.reason}`)
    }

    // Copy the skill directory tree to destDir
    await mkdir(params.destDir, { recursive: true })
    await copyTree(srcSkill, params.destDir)

    // Also copy the namespace's openscience-skills.json (entries manifest) if
    // present. This is per-namespace, not per-skill — only the first sync
    // per namespace needs to write it.
    const nsDir = path.dirname(path.dirname(params.destDir))
    const nsManifest = path.join(nsDir, "openscience-skills.json")
    const upstreamManifest = path.join(tmpDir, "openscience-skills.json")
    if ((await Bun.file(upstreamManifest).exists()) && !(await Bun.file(nsManifest).exists())) {
      await copyFile(upstreamManifest, nsManifest)
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dest, { recursive: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyTree(s, d)
    } else if (entry.isFile()) {
      await copyFile(s, d)
    }
  }
}
