import path from "path"
import fs from "fs/promises"
import z from "zod"
import ignore from "ignore"
import { Filesystem } from "../../util/filesystem"
import type { ModalAdapter } from "./adapter"

export namespace ModalPlan {
  const DENY = new Set([".git", "node_modules", ".openscience", ".modal.toml", ".ssh"])
  const SECRET = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i

  export const Schema = z.object({
    digest: z.string().length(64),
    provider: z.literal("modal"),
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
    command: string
    cwd: string
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

  async function hash(file: string) {
    const data = await Bun.file(file).arrayBuffer()
    return new Bun.CryptoHasher("sha256").update(data).digest("hex")
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

  async function inputs(root: string, patterns: string[]) {
    const project = await Filesystem.canonical(root)
    if (!project) throw new Error(`Modal project directory is unavailable: ${root}`)
    const files = new Map<string, ModalAdapter.File>()
    const found = new Set<string>()
    for (const pattern of patterns) {
      if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
        throw new Error(`Modal upload pattern must stay inside the project: ${pattern}`)
      }
      const scan = new Bun.Glob(pattern).scan({ cwd: project, dot: true, onlyFiles: true, followSymlinks: true })
      for await (const file of scan) found.add(posix(file))
    }
    const excludes = await ignored(project, [...found])
    for (const relative of found) {
      if (excludes.has(relative)) continue
      if (forbidden(relative)) throw new Error(`Modal upload policy denied: ${relative}`)
      const canonical = await Filesystem.canonical(path.resolve(project, relative))
      if (!canonical || !Filesystem.contains(project, canonical)) {
        throw new Error(`Modal upload escaped the project: ${relative}`)
      }
      const resolved = posix(path.relative(project, canonical))
      const canonicalIgnored =
        resolved === relative ? excludes.has(resolved) : (await ignored(project, [resolved])).has(resolved)
      if (canonicalIgnored) continue
      if (forbidden(resolved)) throw new Error(`Modal upload policy denied: ${relative}`)
      const info = await fs.stat(canonical)
      files.set(canonical, {
        path: resolved,
        canonical,
        size: info.size,
        sha256: await hash(canonical),
      })
    }
    const result = [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path))
    const bytes = result.reduce((sum, file) => sum + file.size, 0)
    if (bytes > 104_857_600) throw new Error("Modal uploads exceed the 100 MiB approval limit")
    return { files: result, bytes }
  }

  export async function prepare(input: Input): Promise<Prepared> {
    const upload = await inputs(input.cwd, input.uploads)
    const value = {
      provider: "modal" as const,
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
      uploads: upload.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      upload_bytes: upload.bytes,
      outputs: input.outputs.toSorted(),
      warning: "This run uses your Modal account and may incur charges until it exits, times out, or is cancelled.",
    }
    const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
    return { plan: Schema.parse({ digest, ...value }), files: upload.files }
  }
}
