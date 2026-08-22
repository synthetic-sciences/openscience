import path from "path"
import fs from "fs/promises"
import z from "zod"
import ignore from "ignore"
import { Filesystem } from "../../util/filesystem"
import type { ModalAdapter } from "./adapter"
import { ModalUpload } from "./upload"

export namespace ModalPlan {
  const DENY = new Set([".git", "node_modules", ".openscience", ".modal.toml", ".ssh"])
  const SECRET = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i

  export const Schema = z.object({
    digest: z.string().length(64),
    provider: z.literal("modal"),
    purpose: z.string(),
    app: z.string(),
    environment: z.string().optional(),
    image: z.string(),
    packages: z.array(z.string()),
    gpu: z.string(),
    resources: z
      .object({
        cpus: z.number().optional(),
        gpus: z.number().optional(),
        memory_gb: z.number().optional(),
      })
      .optional(),
    timeout_minutes: z.number().positive(),
    network: z.enum(["unrestricted", "none"]),
    command: z.string(),
    cwd: z.string(),
    workspace_cwd: z.string(),
    uploads: z.array(
      z.object({
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string().length(64),
      }),
    ),
    upload_bytes: z.number().int().nonnegative(),
    outputs: z.string().array(),
    warning: z.string(),
  })
  export type Schema = z.infer<typeof Schema>

  export type Input = {
    purpose?: string
    command: string
    cwd: string
    workspaceCwd?: string
    image: string
    packages: string[]
    gpu: string
    resources?: { cpus?: number; gpus?: number; memory_gb?: number }
    timeoutMinutes: number
    uploads: string[]
    outputs: string[]
    context: Pick<ModalAdapter.Context, "app" | "environment" | "network">
  }

  export type Prepared = { plan: Schema; files: ModalAdapter.File[] }

  const posix = (value: string) => value.split(path.sep).join("/").replace(/^\.\//, "")

  function workspaceCwd(value: string | undefined) {
    const current = posix(value?.trim() || ".")
    if (path.posix.isAbsolute(current) || current.split("/").includes("..")) {
      throw new Error(`Modal working directory must stay inside the session workspace: ${value}`)
    }
    return current || "."
  }

  function forbidden(file: string) {
    const segments = file.split("/")
    return segments.some((part) => DENY.has(part)) || SECRET.test(file)
  }

  async function ignored(root: string, files: string[]) {
    const git = Bun.which("git")
    const repository = await fs.stat(path.join(root, ".git")).then(
      () => true,
      () => false,
    )
    if (git && repository && files.length) {
      const proc = Bun.spawn([git, "-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
        stdin: new Blob([`${files.join("\0")}\0`]),
        stdout: "pipe",
        stderr: "ignore",
      })
      const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      if (code === 0 || code === 1) return new Set(output.split("\0").filter(Boolean))
    }
    const [project, local] = await Promise.all([
      Bun.file(path.join(root, ".gitignore"))
        .text()
        .catch(() => ""),
      Bun.file(path.join(root, ".git", "info", "exclude"))
        .text()
        .catch(() => ""),
    ])
    const matcher = ignore().add(project).add(local)
    return new Set(files.filter((file) => matcher.ignores(file)))
  }

  export async function files(root: string, patterns: string[], label = "Modal") {
    const project = await Filesystem.canonical(root)
    if (!project) throw new Error(`${label} project directory is unavailable: ${root}`)
    const files = new Map<string, Omit<ModalAdapter.File, "sha256"> & { snapshot: ModalUpload.Snapshot }>()
    const found = new Set<string>()
    for (const pattern of patterns) {
      if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
        throw new Error(`${label} upload pattern must stay inside the project: ${pattern}`)
      }
      const scan = new Bun.Glob(pattern).scan({ cwd: project, dot: true, onlyFiles: true, followSymlinks: true })
      for await (const file of scan) {
        found.add(posix(file))
        if (found.size > ModalUpload.COUNT_LIMIT) {
          throw new Error(`${label} uploads exceed the ${ModalUpload.COUNT_LIMIT}-file approval limit`)
        }
      }
    }
    const excludes = await ignored(project, [...found])
    for (const relative of found) {
      if (excludes.has(relative)) continue
      if (forbidden(relative)) throw new Error(`${label} upload policy denied: ${relative}`)
      const canonical = await Filesystem.canonical(path.resolve(project, relative))
      if (!canonical || !Filesystem.contains(project, canonical)) {
        throw new Error(`${label} upload escaped the project: ${relative}`)
      }
      const resolved = posix(path.relative(project, canonical))
      const canonicalIgnored =
        resolved === relative ? excludes.has(resolved) : (await ignored(project, [resolved])).has(resolved)
      if (canonicalIgnored) continue
      if (forbidden(resolved)) throw new Error(`${label} upload policy denied: ${relative}`)
      if (files.has(canonical)) continue
      const snapshot = await ModalUpload.inspect(canonical, label)
      files.set(canonical, {
        path: resolved,
        canonical,
        size: snapshot.size,
        snapshot,
      })
    }
    const candidates = [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path))
    const bytes = ModalUpload.validate(candidates, label)
    const result: ModalAdapter.File[] = []
    for (const file of candidates) {
      result.push({
        path: file.path,
        canonical: file.canonical,
        size: file.size,
        sha256: (await ModalUpload.hash(file.canonical, file.snapshot, label)).sha256,
      })
    }
    return { files: result, bytes }
  }

  export async function prepare(input: Input): Promise<Prepared> {
    const upload = await files(input.cwd, input.uploads)
    const value = {
      provider: "modal" as const,
      purpose: input.purpose?.trim() || "Research computation",
      app: input.context.app,
      environment: input.context.environment,
      image: input.image,
      packages: input.packages.toSorted(),
      gpu: input.gpu,
      resources: input.resources,
      timeout_minutes: input.timeoutMinutes,
      network: input.context.network,
      command: input.command,
      cwd: input.cwd,
      workspace_cwd: workspaceCwd(input.workspaceCwd),
      uploads: upload.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      upload_bytes: upload.bytes,
      outputs: input.outputs.toSorted(),
      warning: "This run uses your Modal account and may incur charges until it exits, times out, or is cancelled.",
    }
    // The absolute cwd is a per-conversation scratch path. Bind the stable
    // workspace-relative cwd plus reviewed input paths and hashes so exact
    // project/global approvals can carry across isolated conversations.
    const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify({ ...value, cwd: undefined })).digest("hex")
    return { plan: Schema.parse({ digest, ...value }), files: upload.files }
  }
}
