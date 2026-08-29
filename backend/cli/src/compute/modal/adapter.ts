import path from "path"
import crypto from "crypto"
import fs from "fs/promises"
import {
  ClientClosedError,
  InternalFailure,
  InvalidError,
  ModalClient,
  NotFoundError,
  SandboxTimeoutError,
  TimeoutError,
  type Sandbox,
} from "modal"
import { Filesystem } from "../../util/filesystem"
import { ModalUpload } from "./upload"
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
    packageLock?: { digest: string; requirements: string }
    gpu: string
    gpus?: number
    cpus?: number
    memoryGb?: number
    timeoutMinutes?: number
    /** Ephemeral values resolved from reviewed symbolic references only after
     * approval. They are never persisted in Job or Plan records. */
    secrets?: Record<string, string>
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
    output: (value: string, mode?: "append" | "replace") => Promise<void>
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

  export class OwnershipError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "ModalOwnershipError"
    }
  }

  export type RecoveryFailure =
    | { retryable: true }
    | {
        retryable: false
        kind: "unauthorized" | "quota_exhausted" | "ownership_mismatch" | "invalid_request" | "not_found"
      }

  /**
   * Modal already retries transient gRPC failures inside the SDK. Classify
   * failures that cannot improve with time so a recovered job does not reserve
   * local concurrency forever. Unknown transport failures remain retryable.
   */
  export function recoveryFailure(error: unknown): RecoveryFailure {
    if (error instanceof OwnershipError) return { retryable: false, kind: "ownership_mismatch" }
    if (error instanceof NotFoundError) return { retryable: false, kind: "not_found" }
    if (error instanceof InvalidError) return { retryable: false, kind: "invalid_request" }
    if (
      error instanceof InternalFailure ||
      error instanceof TimeoutError ||
      error instanceof SandboxTimeoutError ||
      error instanceof ClientClosedError
    ) {
      return { retryable: true }
    }
    if (!error || typeof error !== "object") return { retryable: true }
    const value = error as { code?: unknown; status?: unknown }
    const code = typeof value.code === "number" ? value.code : undefined
    const status = typeof value.status === "number" ? value.status : undefined
    // gRPC status codes: INVALID_ARGUMENT=3, NOT_FOUND=5,
    // PERMISSION_DENIED=7, RESOURCE_EXHAUSTED=8, FAILED_PRECONDITION=9,
    // UNAUTHENTICATED=16. Some HTTP transports expose 401/403/404 instead.
    if (code === 16 || code === 7 || status === 401 || status === 403) {
      return { retryable: false, kind: "unauthorized" }
    }
    if (code === 5 || status === 404) return { retryable: false, kind: "not_found" }
    // RESOURCE_EXHAUSTED and HTTP 429 cover transient rate/concurrency
    // throttles as well as hard account quotas. Without a provider-specific
    // hard-quota signal, preserve recovery and let the bounded backoff retry.
    if (code === 8 || status === 429) return { retryable: true }
    if (code === 3 || code === 9 || status === 400 || status === 422) {
      return { retryable: false, kind: "invalid_request" }
    }
    return { retryable: true }
  }

  export function volume(project: string, id: string) {
    const digest = crypto.createHash("sha256").update(`${project}\0${id}`).digest("hex").slice(0, 32)
    return `openscience-job-${digest}`
  }

  const clean = (value: string) => value.split(path.sep).join("/").replace(/^\.\//, "")

  type ClosableClient = Pick<ModalClient, "close">

  /**
   * modal@0.9.0's public `close()` does not currently tear down the client's
   * underlying gRPC channels. Reusing one process-scoped client per credential
   * identity therefore prevents every status poll, recovery, and release call
   * from opening another live transport in the long-running OpenScience server.
   *
   * Keep the pool deliberately small. Changing credentials or environments is
   * rare and a process restart is safer than silently accumulating transports
   * after repeated profile churn. Keys are one-way digests, never raw tokens.
   */
  export class ClientPool<T extends ClosableClient> {
    private readonly values = new Map<string, T>()
    private disposed = false

    constructor(
      private readonly create: (context: Pick<Context, "tokenId" | "tokenSecret" | "environment">) => T,
      private readonly limit = 4,
    ) {}

    acquire(context: Pick<Context, "tokenId" | "tokenSecret" | "environment">): T {
      if (this.disposed) throw new Error("Modal client pool is disposed; restart OpenScience before using Modal again")
      const key = crypto
        .createHash("sha256")
        .update(`${context.tokenId}\0${context.tokenSecret}\0${context.environment ?? ""}`)
        .digest("hex")
      const existing = this.values.get(key)
      if (existing) return existing
      if (this.values.size >= this.limit) {
        throw new Error(
          `Modal credentials or environments changed more than ${this.limit} times in this OpenScience process. Restart OpenScience before using Modal again.`,
        )
      }
      const created = this.create(context)
      this.values.set(key, created)
      return created
    }

    get size() {
      return this.values.size
    }

    dispose() {
      if (this.disposed) return
      this.disposed = true
      for (const value of this.values.values()) value.close()
      this.values.clear()
    }
  }

  const clients = new ClientPool(
    (context) =>
      new ModalClient({
        tokenId: context.tokenId,
        tokenSecret: context.tokenSecret,
        environment: context.environment,
      }),
  )
  process.once("exit", () => clients.dispose())

  function client(context: Context) {
    return clients.acquire(context)
  }

  /** Terminal process-lifecycle cleanup for tests and one-shot hosts.
   *
   * The current Modal SDK exposes no transport-disposal API: `close()` only
   * resets SDK auth state and does not close gRPC channels. OpenScience's
   * long-running servers therefore reuse this bounded pool, while their
   * existing explicit process-exit path performs the actual socket teardown.
   * Do not call this and then try to dispatch more Modal work. */
  export function dispose() {
    clients.dispose()
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

  export function layers(packages: string[], packageLock?: { digest: string; requirements: string }) {
    if (packageLock) {
      const encoded = Buffer.from(packageLock.requirements).toString("base64")
      return [
        `RUN printf '%s' ${quote(encoded)} | base64 -d > /tmp/openscience-requirements.txt && python -m pip install --disable-pip-version-check --no-cache-dir --no-deps --only-binary=:all: --require-hashes -r /tmp/openscience-requirements.txt && rm -f /tmp/openscience-requirements.txt`,
      ]
    }
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

  export async function consumeOutput(
    stream: ReadableStream<string>,
    output: Hooks["output"],
    firstMode: "append" | "replace" = "append",
  ) {
    const reader = stream.getReader()
    const maxLine = 1024 * 1024
    const omitted = `[OpenScience omitted an output line larger than ${maxLine} characters]`
    const state = { first: true, pending: "", discarding: false }
    const emit = async (value: string) => {
      if (!value) return
      await output(value, state.first ? firstMode : "append")
      state.first = false
    }
    const consume = async (value: string) => {
      let cursor = 0
      while (cursor < value.length) {
        const newline = value.indexOf("\n", cursor)
        const end = newline < 0 ? value.length : newline + 1
        const segment = value.slice(cursor, end)
        cursor = end
        if (state.discarding) {
          if (newline >= 0) {
            state.discarding = false
            await emit(`${omitted}\n`)
          }
          continue
        }
        if (state.pending.length + segment.length > maxLine) {
          state.pending = ""
          if (newline >= 0) await emit(`${omitted}\n`)
          else state.discarding = true
          continue
        }
        state.pending += segment
        if (newline >= 0) {
          const complete = state.pending
          state.pending = ""
          await emit(complete)
        }
      }
    }
    try {
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        await consume(item.value)
      }
    } finally {
      try {
        if (state.discarding) await emit(omitted)
        else await emit(state.pending)
        if (state.first && firstMode === "replace") await output("", "replace")
      } finally {
        reader.releaseLock()
      }
    }
  }

  async function outcome(sandbox: Sandbox, output: Hooks["output"], reattach = false) {
    const [code] = await Promise.all([
      sandbox.wait(),
      consumeOutput(sandbox.stdout, output, reattach ? "replace" : "append"),
    ])
    return { code }
  }

  async function replay(log: string, output: Hooks["output"]) {
    const stream = Bun.file(log).stream().pipeThrough(new TextDecoderStream())
    await consumeOutput(stream, output, "replace")
  }

  async function harvest(
    context: Context,
    spec: Spec,
    fallback?: { code: number },
    options: { partial?: boolean; log?: boolean } = {},
  ): Promise<Result & { log?: string }> {
    if (fallback && !spec.outputs.length && !options.log) return { code: fallback.code, outputs: [] }
    const codePath = path.posix.basename(EXIT_CODE)
    const logPath = path.posix.basename(RUN_LOG)
    const wantLog = options.log || fallback === undefined
    const entries = options.partial
      ? await ModalVolume.list(context, spec.volume, "/", true)
      : await ModalVolume.wait(context, spec.volume, codePath)
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
    const sizes = new Map(
      entries.filter((entry) => entry.type === "file").map((entry) => [clean(entry.path), entry.size]),
    )
    const paths = [
      ...new Set([
        ...(complete ? [codePath] : []),
        ...(wantLog && sizes.has(logPath) ? [logPath] : []),
        ...selected.map((entry) => clean(entry.path)),
      ]),
    ]
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
    if ((wantLog && !logged && !options.partial) || (!saved && fallback === undefined)) {
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
    return { code, outputs, ...(logged ? { log: logged.staging } : {}) }
  }

  export function validateUploads(files: File[]) {
    return ModalUpload.validate(files)
  }

  export async function preflightUploads(project: string, files: File[]) {
    validateUploads(files)
    const root = await Filesystem.canonical(project)
    if (!root) throw new Error(`Modal project directory is unavailable before upload: ${project}`)
    const result: (File & { snapshot: ModalUpload.Snapshot })[] = []
    for (const file of files) {
      const current = await Filesystem.canonical(file.canonical)
      if (!current || current !== file.canonical || !Filesystem.contains(root, current)) {
        throw new Error(`Modal input changed or escaped the project before upload: ${file.path}`)
      }
      const snapshot = await ModalUpload.inspect(current)
      if (snapshot.size !== file.size) throw new Error(`Modal input changed after approval: ${file.path}`)
      result.push({ ...file, snapshot })
    }
    ModalUpload.validate(result)
    return result
  }

  async function upload(sandbox: Sandbox, spec: Spec) {
    const approved = await preflightUploads(spec.project, spec.uploads)
    await fs.mkdir(spec.staging, { recursive: true, mode: 0o700 })
    const base = await Filesystem.canonical(spec.staging)
    if (!base) throw new Error(`Modal input staging directory is unavailable: ${spec.staging}`)
    const staging = await fs.mkdtemp(path.join(base, ".inputs-"))
    await fs.chmod(staging, 0o700)
    try {
      await sandbox.filesystem.makeDirectory(ROOT)
      for (const [index, file] of approved.entries()) {
        const local = path.join(staging, String(index))
        await ModalUpload.stage(file.canonical, local, { ...file.snapshot, sha256: file.sha256 })
        const remote = path.posix.join(ROOT, file.path)
        await sandbox.filesystem.copyFromLocal(local, remote)
        await ModalUpload.hash(local, { size: file.size, sha256: file.sha256 })
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
    await sandbox.filesystem.writeText("approved\n", path.posix.join(ROOT, ".openscience-ready"))
  }

  async function own(sandbox: Sandbox, id: string, project: string) {
    const tags = await sandbox.getTags()
    const owner = crypto.createHash("sha256").update(project).digest("hex").slice(0, 20)
    if (tags.openscience !== "true" || tags.openscience_job !== id || tags.openscience_project !== owner) {
      throw new OwnershipError(`Modal sandbox ${sandbox.sandboxId} is not owned by OpenScience job ${id}`)
    }
  }

  export async function check(context: Context) {
    const modal = client(context)
    return Promise.resolve().then(async () => {
      const iterator = modal.sandboxes.list({ environment: context.environment })[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.(undefined)
      return { ok: true as const, sdk: modal.version() }
    })
  }

  export async function run(context: Context, spec: Spec, hooks: Hooks): Promise<Result> {
    const modal = client(context)
    return Promise.resolve().then(async () => {
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
      const commands = layers(spec.packages, spec.packageLock)
      const image = commands.length ? base.dockerfileCommands(commands) : base
      await hooks.log(
        commands.length
          ? spec.packageLock
            ? `Building image ${spec.image} from locked wheels (${spec.packageLock.digest.slice(0, 12)})`
            : `Building image ${spec.image} with ${spec.packages.length} Python package${spec.packages.length === 1 ? "" : "s"}`
          : `Resolving image ${spec.image}`,
      )
      const ready = await image.build(app).catch((error) => {
        const detail = error instanceof Error ? error.message.trim() : String(error).trim()
        const guidance = commands.length
          ? "The selected image must provide python and pip for the requested packages; omit image to use the configured Python image."
          : "Verify that the image name and registry are publicly accessible."
        throw new Error(
          `Modal could not build image ${spec.image}. ${guidance}${detail ? ` Provider detail: ${detail}` : ""}`,
          { cause: error },
        )
      })
      const volume = await modal.volumes.fromName(spec.volume, {
        environment: context.environment,
        createIfMissing: true,
      })
      await hooks.log(`Image ready: ${ready.imageId}`)
      await hooks.log(`Creating ${gpu === "none" ? "CPU" : gpu} sandbox`)
      const secrets =
        spec.secrets && Object.keys(spec.secrets).length ? [await modal.secrets.fromObject(spec.secrets)] : undefined
      const sandbox = await modal.sandboxes.create(app, ready, {
        command: ["bash", "-lc", script(spec.command)],
        workdir: ROOT,
        gpu: gpu === "none" ? undefined : gpu,
        cpu: spec.cpus,
        memoryMiB: spec.memoryGb ? Math.ceil(spec.memoryGb * 1024) : undefined,
        timeoutMs: (spec.timeoutMinutes ?? context.timeoutMinutes) * 60_000,
        secrets,
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
        await sandbox.terminate({ wait: true }).catch(() => undefined)
        throw error
      })
      await hooks.log(`Sandbox ready: ${sandbox.sandboxId}`)
      await upload(sandbox, spec).catch(async (error) => {
        await sandbox.terminate({ wait: true }).catch(() => undefined)
        throw error
      })
      await hooks.log(
        `Uploaded ${spec.uploads.length} input file${spec.uploads.length === 1 ? "" : "s"} (${spec.uploads.reduce((sum, file) => sum + file.size, 0)} bytes)`,
      )
      await hooks.log(`Running command: ${spec.command}`)
      const settled = await outcome(sandbox, hooks.output)
      await hooks.log(`Command exited with code ${settled.code}; compute sandbox released`)
      const recovered = await harvest(context, spec, settled).catch((error) => {
        throw new HarvestError(settled.code, error)
      })
      if (recovered.log) await replay(recovered.log, hooks.output)
      if (settled.code === 124 && recovered.code !== settled.code) {
        await hooks.log(`Sandbox exit ${settled.code} overrides durable command marker ${recovered.code}`)
      }
      const result = reconcile(settled.code, recovered)
      await hooks.log(
        `Downloaded ${recovered.outputs.length} output file${recovered.outputs.length === 1 ? "" : "s"} directly from Modal Volume`,
      )
      return result
    })
  }

  export async function recover(
    context: Context,
    spec: Spec,
    sandboxId: string | undefined,
    hooks: Pick<Hooks, "log" | "output">,
  ): Promise<Result> {
    const modal = client(context)
    return Promise.resolve().then(async () => {
      const sandbox = sandboxId
        ? await modal.sandboxes.fromId(sandboxId).catch((error) => {
            if (error instanceof NotFoundError) return undefined
            throw error
          })
        : undefined
      if (!sandbox) {
        await hooks.log(
          sandboxId
            ? `Sandbox ${sandboxId} ended; harvesting durable volume ${spec.volume}`
            : `No live sandbox found; harvesting durable volume ${spec.volume}`,
        )
        const recovered = await harvest(context, spec)
        if (recovered.log) await replay(recovered.log, hooks.output)
        await hooks.log(`Recovered command exit code ${recovered.code}`)
        await hooks.log(`Recovered ${recovered.outputs.length} output file${recovered.outputs.length === 1 ? "" : "s"}`)
        return recovered
      }
      await own(sandbox, spec.id, spec.project)
      await hooks.log(`Reattached to sandbox ${sandboxId}`)
      const settled = await outcome(sandbox, hooks.output, true)
      const recovered = await harvest(context, spec, settled).catch((error) => {
        throw new HarvestError(settled.code, error)
      })
      if (recovered.log) await replay(recovered.log, hooks.output)
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
  }

  /** Collect declared files from a stopped sandbox without requiring the
   * command-completion marker. Cancellation deliberately retains the durable
   * Volume, so partially written scientific outputs can still be delivered
   * before an explicit release deletes that Volume. */
  export async function collect(context: Context, spec: Spec, hooks: Pick<Hooks, "log" | "output">): Promise<Result> {
    await hooks.log(`Collecting partial output from durable volume ${spec.volume}`)
    const recovered = await harvest(context, spec, { code: 130 }, { partial: true, log: true })
    if (recovered.log) await replay(recovered.log, hooks.output)
    await hooks.log(
      `Recovered ${recovered.outputs.length} partial output file${recovered.outputs.length === 1 ? "" : "s"}`,
    )
    return recovered
  }

  export async function find(context: Context, jobId: string, project: string) {
    const modal = client(context)
    return Promise.resolve().then(async () => {
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
  }

  export async function close(context: Context, sandboxId: string, jobId: string, project: string) {
    const modal = client(context)
    return Promise.resolve().then(async () => {
      const sandbox = await modal.sandboxes.fromId(sandboxId)
      await own(sandbox, jobId, project)
      await sandbox.terminate({ wait: true })
    })
  }

  export async function release(context: Context, spec: Pick<Spec, "id" | "project" | "volume">, sandboxId?: string) {
    const expected = volume(spec.project, spec.id)
    if (spec.volume !== expected)
      throw new Error(`Modal volume ${spec.volume} is not owned by OpenScience job ${spec.id}`)
    const modal = client(context)
    return Promise.resolve().then(async () => {
      if (sandboxId) {
        const sandbox = await modal.sandboxes.fromId(sandboxId).catch((error) => {
          if (error instanceof NotFoundError) return undefined
          throw error
        })
        if (sandbox) {
          await own(sandbox, spec.id, spec.project)
          await sandbox.terminate({ wait: true })
        }
      }
      await modal.volumes.delete(spec.volume, { environment: context.environment, allowMissing: true })
    })
  }
}
