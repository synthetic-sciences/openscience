import path from "path"
import crypto from "crypto"
import { ModalClient, type Sandbox } from "modal"
import { Filesystem } from "../../util/filesystem"
import { ModalVolume } from "./volume"

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
    concurrency: number
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
    volume: string
  }

  export type Result = {
    code: number
    outputs: { path: string; staging: string; size: number; sha256?: string }[]
    timedOut?: boolean
  }

  export type Hooks = {
    created: (id: string) => Promise<void>
    log: (value: string) => Promise<void>
    output: (value: string) => Promise<void>
  }

  export class HarvestError extends Error {
    constructor(
      readonly code: number,
      cause: unknown,
    ) {
      super(`Modal command exited with code ${code}, but its durable Volume could not be downloaded`, { cause })
      this.name = "ModalHarvestError"
    }
  }

  export function volume(project: string, id: string) {
    const digest = crypto.createHash("sha256").update(`${project}\0${id}`).digest("hex").slice(0, 32)
    return `openscience-job-${digest}`
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
      'exit "$code"',
    ].join("; ")
  }

  export function layers(packages: string[]) {
    if (!packages.length) return []
    return [`RUN python -m pip install --disable-pip-version-check --no-cache-dir ${packages.map(quote).join(" ")}`]
  }

  export function reconcile(code: number, recovered: Result): Result {
    if (code === 124) return { ...recovered, code, timedOut: true }
    if (recovered.code !== code) {
      throw new Error(`Modal sandbox exit ${code} disagrees with durable result ${recovered.code}`)
    }
    return recovered
  }

  async function hash(file: string) {
    const data = await Bun.file(file).arrayBuffer()
    return new Bun.CryptoHasher("sha256").update(data).digest("hex")
  }

  async function outcome(sandbox: Sandbox, output: Hooks["output"]) {
    const state = { value: "" }
    const emit = async () => {
      const read = await sandbox.filesystem.readText(RUN_LOG).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
      if (!read.ok) return
      if (read.value === state.value) return
      state.value = read.value
      await output(read.value)
    }
    for (;;) {
      const status = await sandbox.poll()
      await emit()
      if (status !== null) {
        await Bun.sleep(100)
        await emit()
        return { code: status, log: state.value }
      }
      await Bun.sleep(250)
    }
  }

  async function harvest(
    context: Context,
    spec: Spec,
    fallback?: { code: number; log: string },
  ): Promise<Result & { log: string }> {
    if (fallback && !spec.outputs.length) return { code: fallback.code, outputs: [], log: fallback.log }
    const codePath = path.posix.basename(EXIT_CODE)
    const logPath = path.posix.basename(RUN_LOG)
    const entries = await ModalVolume.wait(context, spec.volume, codePath)
    const complete = entries.some((entry) => entry.type === "file" && entry.path === codePath)
    if (!complete && fallback === undefined) throw new Error("Modal output Volume has no completed command result")
    const patterns = spec.outputs.map((pattern) => new Bun.Glob(pattern))
    const selected = entries.filter(
      (entry) =>
        entry.type === "file" &&
        !clean(entry.path).startsWith(".openscience-") &&
        patterns.some((pattern) => pattern.match(clean(entry.path))),
    )
    const total = selected.reduce((sum, entry) => sum + entry.size, 0)
    if (total > 20 * 1024 * 1024 * 1024) throw new Error("Modal outputs exceed the 20 GiB recovery limit")
    const paths = [
      ...new Set([...(complete ? [codePath] : []), logPath, ...selected.map((entry) => clean(entry.path))]),
    ]
    const sizes = new Map(
      entries.filter((entry) => entry.type === "file").map((entry) => [clean(entry.path), entry.size]),
    )
    const declared = paths.map((entry) => sizes.get(entry))
    let declaredBytes: number | undefined
    if (declared.every((entry) => entry !== undefined)) {
      declaredBytes = 0
      for (const entry of declared) {
        declaredBytes = Math.min(Number.MAX_SAFE_INTEGER, declaredBytes + entry!)
      }
    }
    const downloaded = await ModalVolume.download(context, spec.volume, paths, spec.staging, { declaredBytes })
    const files = new Map(downloaded.map((entry) => [entry.path, entry]))
    const saved = files.get(codePath)
    const logged = files.get(logPath)
    if (!logged || (!saved && fallback === undefined)) {
      throw new Error("Modal output Volume is missing its result metadata")
    }
    const code = saved
      ? Number.parseInt((await Bun.file(saved.staging).text()).trim(), 10)
      : (fallback?.code ?? Number.NaN)
    if (!Number.isInteger(code)) throw new Error("Modal output Volume has an invalid command result")
    const outputs = selected.map((entry) => {
      const file = files.get(clean(entry.path))
      if (!file) throw new Error(`Modal output Volume did not download ${entry.path}`)
      return file
    })
    if (outputs.reduce((sum, entry) => sum + entry.size, 0) > 20 * 1024 * 1024 * 1024) {
      throw new Error("Modal outputs exceed the 20 GiB recovery limit")
    }
    return { code, outputs, log: await Bun.file(logged.staging).text() }
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

  async function own(sandbox: Sandbox, id: string, project: string) {
    const tags = await sandbox.getTags()
    const owner = crypto.createHash("sha256").update(project).digest("hex").slice(0, 20)
    if (tags.openscience !== "true" || tags.openscience_job !== id || tags.openscience_project !== owner) {
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
        const bridge = await ModalVolume.check(context)
        await hooks.log(`Local Modal Volume bridge ready: Python SDK ${bridge}`)
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
        const volume = await modal.volumes.fromName(spec.volume, {
          environment: context.environment,
          createIfMissing: true,
        })
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
          volumes: { [ROOT]: volume },
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
        const settled = await outcome(sandbox, hooks.output)
        await hooks.log(`Command exited with code ${settled.code}; GPU sandbox released`)
        const recovered = await harvest(context, spec, settled).catch((error) => {
          throw new HarvestError(settled.code, error)
        })
        if (recovered.log !== settled.log) await hooks.output(recovered.log)
        if (settled.code === 124 && recovered.code !== settled.code) {
          await hooks.log(`Sandbox exit ${settled.code} overrides durable command marker ${recovered.code}`)
        }
        const result = reconcile(settled.code, recovered)
        await hooks.log(
          `Downloaded ${recovered.outputs.length} output file${recovered.outputs.length === 1 ? "" : "s"} directly from Modal Volume`,
        )
        return result
      })
      .finally(() => modal.close())
  }

  export async function recover(
    context: Context,
    spec: Spec,
    sandboxId: string | undefined,
    hooks: Pick<Hooks, "log" | "output">,
  ): Promise<Result> {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        const sandbox = sandboxId ? await modal.sandboxes.fromId(sandboxId).catch(() => undefined) : undefined
        if (!sandbox) {
          await hooks.log(
            sandboxId
              ? `Sandbox ${sandboxId} ended; harvesting durable volume ${spec.volume}`
              : `No live sandbox found; harvesting durable volume ${spec.volume}`,
          )
          const recovered = await harvest(context, spec)
          if (recovered.log) await hooks.output(recovered.log)
          await hooks.log(`Recovered command exit code ${recovered.code}`)
          await hooks.log(
            `Recovered ${recovered.outputs.length} output file${recovered.outputs.length === 1 ? "" : "s"}`,
          )
          return recovered
        }
        await own(sandbox, spec.id, spec.project)
        await hooks.log(`Reattached to sandbox ${sandboxId}`)
        const settled = await outcome(sandbox, hooks.output)
        const recovered = await harvest(context, spec, settled).catch((error) => {
          throw new HarvestError(settled.code, error)
        })
        if (recovered.log !== settled.log) await hooks.output(recovered.log)
        if (settled.code === 124 && recovered.code !== settled.code) {
          await hooks.log(`Sandbox exit ${settled.code} overrides durable command marker ${recovered.code}`)
        }
        const result = reconcile(settled.code, recovered)
        await hooks.log(`Recovered command exit code ${result.code}`)
        await hooks.log(
          `Recovered ${recovered.outputs.length} output file${recovered.outputs.length === 1 ? "" : "s"} directly from Modal Volume`,
        )
        return result
      })
      .finally(() => modal.close())
  }

  export async function find(context: Context, jobId: string, project: string) {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        const owner = crypto.createHash("sha256").update(project).digest("hex").slice(0, 20)
        for await (const sandbox of modal.sandboxes.list({
          environment: context.environment,
          tags: {
            openscience: "true",
            openscience_job: jobId,
            openscience_project: owner,
          },
        })) {
          await own(sandbox, jobId, project)
          return sandbox.sandboxId
        }
        return undefined
      })
      .finally(() => modal.close())
  }

  export async function close(context: Context, sandboxId: string, jobId: string, project: string) {
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        const sandbox = await modal.sandboxes.fromId(sandboxId)
        await own(sandbox, jobId, project)
        await sandbox.terminate()
      })
      .finally(() => modal.close())
  }

  export async function release(context: Context, spec: Pick<Spec, "id" | "project" | "volume">, sandboxId?: string) {
    const expected = volume(spec.project, spec.id)
    if (spec.volume !== expected)
      throw new Error(`Modal volume ${spec.volume} is not owned by OpenScience job ${spec.id}`)
    const modal = client(context)
    return Promise.resolve()
      .then(async () => {
        if (sandboxId) {
          const sandbox = await modal.sandboxes.fromId(sandboxId).catch(() => undefined)
          if (sandbox) {
            await own(sandbox, spec.id, spec.project)
            await sandbox.terminate()
          }
        }
        await modal.volumes.delete(spec.volume, { environment: context.environment, allowMissing: true })
      })
      .finally(() => modal.close())
  }
}
