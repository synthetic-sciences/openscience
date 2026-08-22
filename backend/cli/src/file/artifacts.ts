import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { SafeFileIO } from "./safe-io"

export namespace ArtifactFile {
  const gitConfig = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`]

  function gitEnv(root: string) {
    return {
      PATH: process.env.PATH ?? "",
      LANG: process.env.LANG ?? "C",
      GIT_CEILING_DIRECTORIES: path.dirname(root),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  export const Kind = z.enum([
    "notebook",
    "dataset",
    "figure",
    "report",
    "structure",
    "sequence",
    "genomics",
    "spectrum",
    "model",
    "archive",
  ])
  export type Kind = z.infer<typeof Kind>

  export const Info = z.object({
    name: z.string(),
    path: z.string(),
    kind: Kind,
    format: z.string(),
    size: z.number(),
    modified: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export const Provenance = z.object({
    path: z.string(),
    tracked: z.boolean(),
    dirty: z.boolean(),
    status: z.enum(["clean", "modified", "added", "deleted", "untracked", "local"]),
    branch: z.string().optional(),
    commit: z
      .object({
        sha: z.string(),
        author: z.string(),
        email: z.string(),
        date: z.string(),
        message: z.string(),
      })
      .optional(),
  })
  export type Provenance = z.infer<typeof Provenance>

  export const AuditCheck = z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
    weight: z.number().positive(),
  })
  export type AuditCheck = z.infer<typeof AuditCheck>

  export const Audit = z.object({
    generated_at: z.string(),
    score: z.number().int().min(0).max(100),
    status: z.enum(["ready", "warnings", "blocked"]),
    git: z
      .object({
        branch: z.string().optional(),
        commit: z.string().optional(),
        dirty: z.boolean(),
      })
      .optional(),
    lockfiles: z.string().array(),
    environments: z.string().array(),
    notebooks: z.object({
      total: z.number().int().nonnegative(),
      valid: z.number().int().nonnegative(),
      invalid: z.string().array(),
    }),
    artifacts: z.object({
      total: z.number().int().nonnegative(),
      nonempty: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    }),
    checks: AuditCheck.array(),
  })
  export type Audit = z.infer<typeof Audit>

  export const ManifestArtifact = Info.extend({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type ManifestArtifact = z.infer<typeof ManifestArtifact>

  export const Manifest = z.object({
    format: z.literal("openscience.artifact-manifest.v1"),
    generated_at: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    artifacts: ManifestArtifact.array(),
  })
  export type Manifest = z.infer<typeof Manifest>

  const kinds: Record<Kind, string[]> = {
    notebook: ["ipynb"],
    dataset: ["csv", "tsv", "jsonl", "parquet", "feather", "arrow", "xls", "xlsx", "h5", "hdf5", "h5ad", "loom"],
    figure: ["png", "jpg", "jpeg", "svg", "webp", "tif", "tiff", "gif"],
    report: ["pdf", "html", "htm", "md", "markdown", "docx", "tex", "latex"],
    structure: ["pdb", "ent", "cif", "mmcif", "pdbqt", "gro", "xyz", "sdf", "mol", "mol2", "smi", "smiles"],
    sequence: ["fa", "fasta", "faa", "fna", "ffn", "frn", "fastq", "fq"],
    genomics: ["vcf", "bcf", "bam", "cram", "bed", "bedgraph", "gff", "gff3", "gtf", "bigwig", "bw"],
    spectrum: ["mzml", "mzxml", "mgf", "cdf"],
    model: ["pkl", "pickle", "joblib", "pt", "pth", "ckpt", "safetensors", "onnx", "pb"],
    archive: ["zip", "tar", "gz", "bz2", "xz", "7z"],
  }
  const extensions = Object.fromEntries(
    Object.entries(kinds).flatMap(([kind, values]) => values.map((value) => [value, kind])),
  ) as Record<string, Kind>
  const excluded = new Set([
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".turbo",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "target",
    "vendor",
    "__pycache__",
  ])
  const LIMIT = 5_000
  const DEPTH = 16
  const VISITS = 50_000
  const NOTEBOOK_LIMIT = 32 * 1024 * 1024
  const NOTEBOOK_TOTAL = 256 * 1024 * 1024
  const NOTEBOOK_CONCURRENCY = 2
  const lockfiles = [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "renv.lock",
    "Cargo.lock",
    "Manifest.toml",
  ]
  const environments = [
    "pyproject.toml",
    "requirements.txt",
    "environment.yml",
    "environment.yaml",
    "Dockerfile",
    "compose.yml",
    "docker-compose.yml",
    "package.json",
    "renv.lock",
    "Project.toml",
  ]

  export function classify(file: string): { kind: Kind; format: string } | undefined {
    const format = path.extname(file).slice(1).toLowerCase()
    const kind = extensions[format]
    if (!kind) return
    return { kind, format }
  }

  export type ScanLimits = { artifacts: number; visits: number }

  export function limits(): ScanLimits {
    return { artifacts: 0, visits: 0 }
  }

  export async function scan(root: string, shared: ScanLimits = limits()): Promise<Info[]> {
    const artifacts: Info[] = []
    const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
      if (depth > DEPTH || shared.artifacts >= LIMIT || shared.visits >= VISITS) return
      const [canonical, info] = await Promise.all([
        fs.promises.realpath(directory).catch(() => undefined),
        fs.promises.lstat(directory).catch(() => undefined),
      ])
      if (depth === 0 && info && !info.isDirectory()) {
        throw Object.assign(new Error(`Artifact root is not a directory: ${directory}`), { code: "ENOTDIR" })
      }
      if (!canonical || canonical !== path.resolve(directory) || !info?.isDirectory() || info.isSymbolicLink()) {
        if (depth === 0) throw new Error(`Artifact root is unavailable or indirect: ${directory}`)
        return
      }
      const entries = await fs.promises.opendir(directory).catch((error) => {
        if (depth === 0) throw error
        return undefined
      })
      if (!entries) return
      await (async () => {
        for await (const entry of entries) {
          shared.visits += 1
          if (shared.artifacts >= LIMIT || shared.visits >= VISITS) return
          if (entry.isDirectory()) {
            if (excluded.has(entry.name) || entry.name.startsWith(".")) continue
            await walk(path.join(directory, entry.name), path.join(relative, entry.name), depth + 1)
            continue
          }
          if (!entry.isFile()) continue
          const classified = classify(entry.name)
          if (!classified) continue
          const full = path.join(directory, entry.name)
          const stat = await fs.promises.lstat(full).catch(() => undefined)
          if (!stat?.isFile()) continue
          if (shared.artifacts >= LIMIT) return
          shared.artifacts += 1
          artifacts.push({
            name: entry.name,
            path: path.join(relative, entry.name).replaceAll(path.sep, "/").replace(/^\.\//, ""),
            kind: classified.kind,
            format: classified.format,
            size: stat.size,
            modified: stat.mtimeMs,
          })
        }
      })().catch((error) => {
        if (depth === 0) throw error
      })
    }
    await walk(root, ".", 0)
    return artifacts.toSorted((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
  }

  export async function provenance(root: string, file: string, display = file): Promise<Provenance> {
    const env = gitEnv(root)
    const result = await $`git ${gitConfig} rev-parse --show-toplevel`.cwd(root).env(env).quiet().nothrow()
    const repo = result.exitCode === 0 ? (await result.text()).trim() : undefined
    const target = path.isAbsolute(file) ? file : path.resolve(root, file)
    if (!repo || !path.isAbsolute(repo) || !within(root, repo)) {
      return { path: display, tracked: false, dirty: false, status: "local" }
    }
    const relative = path.relative(repo, target)
    if (!within(repo, target)) return { path: display, tracked: false, dirty: false, status: "local" }
    const [branchResult, trackedResult, statusResult, logResult] = await Promise.all([
      $`git ${gitConfig} branch --show-current`.cwd(repo).env(env).quiet().nothrow().text(),
      $`git ${gitConfig} ls-files --error-unmatch -- ${relative}`.cwd(repo).env(env).quiet().nothrow(),
      $`git ${gitConfig} status --porcelain=v1 -- ${relative}`.cwd(repo).env(env).quiet().nothrow().text(),
      $`git ${gitConfig} log -1 --format=%H%x00%an%x00%ae%x00%aI%x00%s -- ${relative}`
        .cwd(repo)
        .env(env)
        .quiet()
        .nothrow()
        .text(),
    ])
    const tracked = trackedResult.exitCode === 0
    const code = statusResult.trim().slice(0, 2)
    const status = statusOf(code, tracked)
    const parts = logResult.trim().split("\0")
    const commit =
      parts.length >= 5
        ? {
            sha: parts[0]!,
            author: parts[1]!,
            email: parts[2]!,
            date: parts[3]!,
            message: parts.slice(4).join("\0"),
          }
        : undefined
    return {
      path: display,
      tracked,
      dirty: status !== "clean",
      status,
      branch: branchResult.trim() || undefined,
      commit,
    }
  }

  function within(root: string, target: string) {
    return Filesystem.contains(root, target)
  }

  export async function audit(root: string): Promise<Audit> {
    const artifacts = await scan(root)
    const env = gitEnv(root)
    const notebooks = artifacts.filter((artifact) => artifact.kind === "notebook")
    const notebookBytes = { total: 0 }
    const batches = Array.from({ length: Math.ceil(notebooks.length / NOTEBOOK_CONCURRENCY) }, (_, index) =>
      notebooks.slice(index * NOTEBOOK_CONCURRENCY, (index + 1) * NOTEBOOK_CONCURRENCY),
    )
    const invalid: string[] = []
    for (const batch of batches) {
      invalid.push(
        ...(
          await Promise.all(
            batch.map(async (notebook) => {
              if (notebook.size > NOTEBOOK_LIMIT || notebookBytes.total + notebook.size > NOTEBOOK_TOTAL) {
                return notebook.path
              }
              notebookBytes.total += notebook.size
              const value = await SafeFileIO.optional(path.join(root, notebook.path), { maxBytes: NOTEBOOK_LIMIT })
                .then((snapshot) => (snapshot ? JSON.parse(snapshot.bytes.toString("utf8")) : undefined))
                .catch(() => undefined)
              if (!value || typeof value !== "object") return notebook.path
              const record = value as Record<string, unknown>
              if (typeof record.nbformat !== "number" || !Array.isArray(record.cells)) return notebook.path
              return undefined
            }),
          )
        ).filter((file): file is string => !!file),
      )
    }
    const [branch, commit, status, presentLocks, presentEnvironments, readme] = await Promise.all([
      $`git ${gitConfig} branch --show-current`.cwd(root).env(env).quiet().nothrow().text(),
      $`git ${gitConfig} rev-parse HEAD`.cwd(root).env(env).quiet().nothrow().text(),
      $`git ${gitConfig} status --porcelain`.cwd(root).env(env).quiet().nothrow().text(),
      Promise.all(lockfiles.map(async (file) => ((await Bun.file(path.join(root, file)).exists()) ? file : undefined))),
      Promise.all(
        environments.map(async (file) => ((await Bun.file(path.join(root, file)).exists()) ? file : undefined)),
      ),
      Promise.all(["README.md", "README.rst", "README.txt"].map((file) => Bun.file(path.join(root, file)).exists())),
    ])
    const locks = presentLocks.filter((file): file is string => !!file)
    const envs = presentEnvironments.filter((file): file is string => !!file)
    const git = commit.trim()
      ? {
          branch: branch.trim() || undefined,
          commit: commit.trim(),
          dirty: Boolean(status.trim()),
        }
      : undefined
    const checks = [
      check(
        "git-repository",
        "Version-controlled project",
        git ? "pass" : "fail",
        git ? "Git repository detected." : "Initialize Git so every result can point to exact code.",
        10,
      ),
      check(
        "git-clean",
        "Clean working tree",
        !git ? "fail" : git.dirty ? "warn" : "pass",
        !git
          ? "No Git state is available."
          : git.dirty
            ? "Commit or stash local changes before a definitive run."
            : "Working tree matches the captured commit.",
        15,
      ),
      check(
        "git-commit",
        "Reachable code snapshot",
        git?.commit ? "pass" : "fail",
        git?.commit ? `Current commit ${git.commit.slice(0, 12)}.` : "Create a commit before recording results.",
        10,
      ),
      check(
        "environment-lock",
        "Locked dependencies",
        locks.length ? "pass" : "fail",
        locks.length ? locks.join(", ") : "Add a lockfile such as uv.lock, renv.lock, bun.lock, or package-lock.json.",
        15,
      ),
      check(
        "environment-spec",
        "Environment specification",
        envs.length ? "pass" : "warn",
        envs.length
          ? envs.join(", ")
          : "Add pyproject.toml, environment.yml, requirements.txt, Dockerfile, or an equivalent spec.",
        10,
      ),
      check(
        "notebooks",
        "Executable notebook structure",
        invalid.length ? "fail" : "pass",
        invalid.length
          ? `Invalid notebooks: ${invalid.join(", ")}`
          : notebooks.length
            ? `${notebooks.length} notebook${notebooks.length === 1 ? "" : "s"} passed structural validation.`
            : "No notebooks need validation.",
        15,
      ),
      check(
        "artifacts",
        "Non-empty research artifacts",
        !artifacts.length || artifacts.some((artifact) => artifact.size === 0) ? "warn" : "pass",
        artifacts.length
          ? `${artifacts.filter((artifact) => artifact.size > 0).length}/${artifacts.length} artifacts are non-empty.`
          : "No generated research artifacts yet.",
        10,
      ),
      check(
        "readme",
        "Project instructions",
        readme.some(Boolean) ? "pass" : "warn",
        readme.some(Boolean) ? "README found." : "Add a README with setup, data, and execution instructions.",
        5,
      ),
    ] satisfies AuditCheck[]
    const total = checks.reduce((sum, item) => sum + item.weight, 0)
    const earned = checks.reduce(
      (sum, item) => sum + (item.status === "pass" ? item.weight : item.status === "warn" ? item.weight / 2 : 0),
      0,
    )
    const score = Math.round((earned / total) * 100)
    return Audit.parse({
      generated_at: new Date().toISOString(),
      score,
      status: checks.some((item) => item.status === "fail") ? "blocked" : score >= 85 ? "ready" : "warnings",
      git,
      lockfiles: locks,
      environments: envs,
      notebooks: {
        total: notebooks.length,
        valid: notebooks.length - invalid.length,
        invalid,
      },
      artifacts: {
        total: artifacts.length,
        nonempty: artifacts.filter((artifact) => artifact.size > 0).length,
        bytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
      },
      checks,
    })
  }

  export async function manifest(root: string): Promise<Manifest> {
    const artifacts = await scan(root)
    const sorted = artifacts.toSorted((a, b) => a.path.localeCompare(b.path))
    const batches = Array.from({ length: Math.ceil(sorted.length / 16) }, (_, index) =>
      sorted.slice(index * 16, (index + 1) * 16),
    )
    const hashed: ManifestArtifact[] = []
    for (const batch of batches) {
      hashed.push(
        ...(await Promise.all(
          batch.map(async (artifact) => {
            const current = await hash(path.join(root, artifact.path))
            return ManifestArtifact.parse({
              ...artifact,
              size: current.size,
              modified: current.modified,
              sha256: current.sha256,
            })
          }),
        )),
      )
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(hashed.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")),
    )
    return Manifest.parse({
      format: "openscience.artifact-manifest.v1",
      generated_at: new Date().toISOString(),
      digest: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      artifacts: hashed,
    })
  }

  function check(id: string, label: string, status: AuditCheck["status"], detail: string, weight: number): AuditCheck {
    return { id, label, status, detail, weight }
  }

  async function hash(file: string) {
    const source = await SafeFileIO.open(file)
    const digest = new Bun.CryptoHasher("sha256")
    const reader = source.stream().getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        digest.update(chunk.value)
      }
      return { sha256: digest.digest("hex"), size: source.size, modified: source.mtimeMs }
    } finally {
      reader.releaseLock()
      await source.close()
    }
  }

  function statusOf(code: string, tracked: boolean): Provenance["status"] {
    if (code === "??") return "untracked"
    if (code.includes("D")) return "deleted"
    if (code.includes("A")) return "added"
    if (code) return "modified"
    return tracked ? "clean" : "local"
  }
}
