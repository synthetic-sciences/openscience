import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { ModalClient, type Sandbox } from "modal"
import { Filesystem } from "../../util/filesystem"

export namespace ModalAdapter {
  export const VERSION = "0.9.0"
  export const ROOT = "/workspace"
  const RUN_LOG = path.posix.join(ROOT, ".openscience-run.log")
  const EXIT_CODE = path.posix.join(ROOT, ".openscience-exit-code")

  export type Config = {
    app: string
    image: string
    environment?: string
    network: "unrestricted" | "none"
    timeoutMinutes: number
  }

  export type Context = Config & {
    tokenId: string
    tokenSecret: string
  }

  export type File = {
    path: string
    canonical: string
    size: number
    sha256: string
  }

  export type Spec = {
    id: string
    project: string
    command: string
    image: string
    packages: string[]
    gpu: string
    gpus?: number
    cpus?: number
    memoryGb?: number
    timeoutMinutes?: number
    uploads: File[]
    outputs: string[]
    staging: string
  }

  export type Result = {
    code: number
    outputs: { path: string; staging: string; size: number }[]
  }

  export type Hooks = {
    created: (id: string) => Promise<void>
    log: (value: string) => Promise<void>
    output: (value: string) => Promise<void>
  }

  const clean = (value: string) => value.split(path.sep).join("/").replace(/^\.\//, "")

  function client(context: Context) {
    return new ModalClient({
      tokenId: context.tokenId,
      tokenSecret: context.tokenSecret,
      environment: context.environment,
    })
  }

  function quote(value: string) {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`
  }

  export function script(command: string, root = ROOT) {
    const log = path.posix.join(root, ".openscience-run.log")
    const code = path.posix.join(root, ".openscience-exit-code")
    return [
      `while [ ! -f ${quote(path.posix.join(root, ".openscience-ready"))} ]; do sleep 0.1; done`,
      `: > ${quote(log)}`,
      `bash -lc ${quote(command)} 2>&1 | tee -a ${quote(log)}`,
      "code=${PIPESTATUS[0]}",
      `printf '%s\\n' "$code" > ${quote(code)}`,
      "while :; do sleep 3600; done",
    ].join("; ")
  }

  export function layers(packages: string[]) {
    if (!packages.length) return []
    return [`RUN python -m pip install --disable-pip-version-check --no-cache-dir ${packages.map(quote).join(" ")}`]
  }

  async function hash(file: string) {
    const data = await Bun.file(file).arrayBuffer()
    return new Bun.CryptoHasher("sha256").update(data).digest("hex")
  }

  async function outcome(sandbox: Sandbox, output: Hooks["output"]) {
    const state = { size: 0 }
    const emit = async () => {
      const read = await sandbox.filesystem.readText(RUN_LOG).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
      if (!read.ok) return
      const value = read.value.length >= state.size ? read.value.slice(state.size) : read.value
      state.size = read.value.length
      if (value) await output(value)
    }
    for (;;) {
      const [saved, status] = await Promise.all([
        sandbox.filesystem.readText(EXIT_CODE).catch(() => ""),
        sandbox.poll(),
      ])
      await emit()
      const code = Number.parseInt(saved.trim(), 10)
      if (Number.isInteger(code)) {
        await Bun.sleep(100)
        await emit()
        return code
      }
      if (status !== null) throw new Error(`Modal sandbox exited before recording the command result (code ${status})`)
      await Bun.sleep(250)
    }
  }

  async function files(sandbox: Sandbox, root = ROOT): Promise<{ path: string; size: number }[]> {
    const entries = await sandbox.filesystem.listFiles(root)
    const nested = await Promise.all(
      entries.map(async (entry) => {
        if (entry.type === "directory") return files(sandbox, entry.path)
        if (entry.type !== "file") return []
        return [{ path: entry.path, size: entry.size }]
      }),
    )
    return nested.flat()
  }

  async function collect(sandbox: Sandbox, spec: Spec) {
    if (!spec.outputs.length) return []
    const entries = await files(sandbox)
    const selected = entries.filter((entry) => {
      const relative = clean(path.posix.relative(ROOT, entry.path))
      return spec.outputs.some((pattern) => new Bun.Glob(pattern).match(relative))
    })
    const total = selected.reduce((sum, entry) => sum + entry.size, 0)
    if (total > 20 * 1024 * 1024 * 1024) throw new Error("Modal outputs exceed the 20 GiB recovery limit")
    await fs.mkdir(spec.staging, { recursive: true })
    return Promise.all(
      selected.map(async (entry) => {
        const relative = clean(path.posix.relative(ROOT, entry.path))
        const target = path.join(spec.staging, ...relative.split("/"))
        await sandbox.filesystem.copyToLocal(entry.path, target)
        return { path: relative, staging: target, size: entry.size }
      }),
    )
  }

  async function upload(sandbox: Sandbox, spec: Spec) {
    await sandbox.filesystem.makeDirectory(ROOT)
    for (const file of spec.uploads) {
      const current = await Filesystem.canonical(file.canonical)
      if (!current || !Filesystem.contains(spec.project, current)) {
        throw new Error(`Modal input changed or escaped the project before upload: ${file.path}`)
      }
      if ((await hash(current)) !== file.sha256) throw new Error(`Modal input changed after approval: ${file.path}`)
      await sandbox.filesystem.copyFromLocal(current, path.posix.join(ROOT, file.path))
    }
    await sandbox.filesystem.writeText("approved\n", path.posix.join(ROOT, ".openscience-ready"))
  }

  async function own(sandbox: Sandbox, id: string) {
    const tags = await sandbox.getTags()
    if (tags.openscience !== "true" || tags.openscience_job !== id) {
      throw new Error(`Modal sandbox ${sandbox.sandboxId} is not owned by OpenScience job ${id}`)
    }
  }

  export async function check(context: Context) {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        const iterator = modal.sandboxes.list({ environment: context.environment })[Symbol.asyncIterator]()
        await iterator.next()
        await iterator.return?.(undefined)
        return { ok: true as const, sdk: modal.version() }
      })
      .finally(() => modal.close())
  }

  export async function run(context: Context, spec: Spec, hooks: Hooks): Promise<Result> {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        await hooks.log(`Resolving Modal app ${context.app}`)
        const app = await modal.apps.fromName(context.app, {
          environment: context.environment,
          createIfMissing: true,
        })
        const count = spec.gpus ?? 1
        const gpu = spec.gpu === "none" || count <= 1 ? spec.gpu : `${spec.gpu}:${count}`
        const base = modal.images.fromRegistry(spec.image)
        const commands = layers(spec.packages)
        const image = commands.length ? base.dockerfileCommands(commands) : base
        await hooks.log(
          commands.length
            ? `Building image ${spec.image} with ${spec.packages.length} Python package${spec.packages.length === 1 ? "" : "s"}`
            : `Resolving image ${spec.image}`,
        )
        const ready = await image.build(app)
        await hooks.log(`Image ready: ${ready.imageId}`)
        await hooks.log(`Creating ${gpu === "none" ? "CPU" : gpu} sandbox`)
        const sandbox = await modal.sandboxes.create(app, ready, {
          command: ["bash", "-lc", script(spec.command)],
          workdir: ROOT,
          gpu: gpu === "none" ? undefined : gpu,
          cpu: spec.cpus,
          memoryMiB: spec.memoryGb ? Math.ceil(spec.memoryGb * 1024) : undefined,
          timeoutMs: (spec.timeoutMinutes ?? context.timeoutMinutes) * 60_000,
          blockNetwork: context.network === "none",
          name: `os-${spec.id}`,
          tags: {
            openscience: "true",
            openscience_job: spec.id,
            openscience_project: crypto.createHash("sha256").update(spec.project).digest("hex").slice(0, 20),
          },
        })
        await hooks.created(sandbox.sandboxId).catch(async (error) => {
          await sandbox.terminate().catch(() => undefined)
          throw error
        })
        await hooks.log(`Sandbox ready: ${sandbox.sandboxId}`)
        await upload(sandbox, spec)
        await hooks.log(
          `Uploaded ${spec.uploads.length} input file${spec.uploads.length === 1 ? "" : "s"} (${spec.uploads.reduce((sum, file) => sum + file.size, 0)} bytes)`,
        )
        await hooks.log(`Running command: ${spec.command}`)
        const code = await outcome(sandbox, hooks.output)
        await hooks.log(`Command exited with code ${code}`)
        const outputs = await collect(sandbox, spec)
        await hooks.log(`Collected ${outputs.length} output file${outputs.length === 1 ? "" : "s"}`)
        return { code, outputs }
      })
      .finally(() => modal.close())
  }

  export async function recover(context: Context, spec: Spec, sandboxId: string, hooks: Pick<Hooks, "log" | "output">) {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        const sandbox = await modal.sandboxes.fromId(sandboxId)
        await own(sandbox, spec.id)
        await hooks.log(`Reattached to sandbox ${sandboxId}`)
        const code = await outcome(sandbox, hooks.output)
        await hooks.log(`Recovered command exit code ${code}`)
        const outputs = await collect(sandbox, spec)
        await hooks.log(`Recovered ${outputs.length} output file${outputs.length === 1 ? "" : "s"}`)
        return { code, outputs }
      })
      .finally(() => modal.close())
  }

  export async function find(context: Context, jobId: string) {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        for await (const sandbox of modal.sandboxes.list({
          environment: context.environment,
          tags: { openscience: "true", openscience_job: jobId },
        })) {
          await own(sandbox, jobId)
          return sandbox.sandboxId
        }
        return undefined
      })
      .finally(() => modal.close())
  }

  export async function close(context: Context, sandboxId: string, jobId: string) {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        const sandbox = await modal.sandboxes.fromId(sandboxId)
        await own(sandbox, jobId)
        await sandbox.terminate()
      })
      .finally(() => modal.close())
  }
}
