import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "../global"
import { OpenScience } from "../openscience"
import { Shell } from "../shell/shell"
import { Instance } from "../project/instance"
import { Sandbox } from "../sandbox/sandbox"
import { Filesystem } from "../util/filesystem"
import { ProvenanceEnvelope } from "../science/provenance/envelope"
import { ExecutionAuthority } from "../project/execution"
import { ComputeLifecycle } from "./lifecycle"
import { ModalAdapter } from "./modal/adapter"
import { ModalPlan } from "./modal/plan"

export class ComputeJobsCorruptError extends Error {
  constructor(
    readonly filepath: string,
    readonly backup?: string,
    cause?: unknown,
  ) {
    super(
      backup
        ? `Compute job history ${filepath} is corrupt. Refusing to overwrite it; the unmodified bytes were backed up to ${backup}.`
        : `Compute job history ${filepath} is corrupt and cannot be read. Repair or remove it before continuing.`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "ComputeJobsCorruptError"
  }
}

export namespace ComputeJobs {
  export const Scheduler = z.enum(["none", "slurm", "pbs"])
  export type Scheduler = z.infer<typeof Scheduler>

  export const Host = z.object({
    id: z.string(),
    label: z.string(),
    host: z.string(),
    user: z.string().optional(),
    port: z.number().int().positive().optional(),
    scheduler: Scheduler.default("none"),
    workdir: z.string().optional(),
  })
  export type Host = z.infer<typeof Host>

  export const Probe = z.object({
    ok: z.boolean(),
    host: z.string(),
    latency_ms: z.number().nonnegative(),
    hostname: z.string().optional(),
    python: z.boolean(),
    gpu: z.boolean(),
    slurm: z.boolean(),
    pbs: z.boolean(),
    error: z.string().optional(),
  })
  export type Probe = z.infer<typeof Probe>

  export const Target = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }),
    z.object({ kind: z.literal("ssh"), host_id: z.string() }),
    z.object({ kind: z.literal("modal") }),
  ])
  export type Target = z.infer<typeof Target>

  export const Resources = z.object({
    cpus: z.number().int().min(1).max(1024).optional(),
    gpus: z.number().int().min(0).max(128).optional(),
    memory_gb: z.number().min(0.1).max(100_000).optional(),
    time_minutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30)
      .optional(),
    partition: z.string().trim().min(1).max(120).optional(),
  })
  export type Resources = z.infer<typeof Resources>

  export const Artifact = z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    modified_at: z.string(),
  })
  export type Artifact = z.infer<typeof Artifact>

  export const Reproducibility = z.object({
    captured_at: z.string(),
    command: z.string(),
    cwd: z.string(),
    platform: z.string(),
    arch: z.string(),
    bun: z.string(),
    node: z.string(),
    python: z.string().optional(),
    git: z
      .object({
        repository: z.string().optional(),
        branch: z.string().optional(),
        commit: z.string().optional(),
        dirty: z.boolean(),
      })
      .optional(),
    lockfiles: Artifact.array(),
    resources: Resources.optional(),
  })
  export type Reproducibility = z.infer<typeof Reproducibility>

  export const Input = z.object({
    name: z.string().trim().min(1).max(120),
    command: z.string().trim().min(1).max(100_000),
    cwd: z.string().optional(),
    target: Target,
    resources: Resources.optional(),
    modules: z.array(z.string().trim().min(1).max(240)).max(64).optional(),
    container: z.string().trim().min(1).max(2_000).optional(),
    artifacts: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    checkpoint: z.string().trim().min(1).max(2_000).optional(),
    uploads: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    packages: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
    image: z.string().trim().min(1).max(2_000).optional(),
    gpu: z.string().trim().min(1).max(120).optional(),
    approval: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Request = Input.extend({
    sessionID: z.string().startsWith("ses_"),
  })
  export type Request = z.infer<typeof Request>

  export const Status = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"])
  export type Status = z.infer<typeof Status>

  export const Job = z.object({
    id: z.string(),
    name: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    target: Target,
    target_label: z.string(),
    scheduler: Scheduler,
    status: Status,
    created_at: z.string(),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
    exit_code: z.number().int().nullable().optional(),
    pid: z.number().int().positive().optional(),
    error: z.string().optional(),
    resources: Resources.optional(),
    modules: z.array(z.string()).optional(),
    container: z.string().optional(),
    artifact_patterns: z.array(z.string()).optional(),
    artifacts: Artifact.array().optional(),
    checkpoint_path: z.string().optional(),
    checkpoint: Artifact.optional(),
    reproducibility: Reproducibility.optional(),
    provenance: ProvenanceEnvelope.Schema.optional(),
    capture_error: z.string().optional(),
    cleanup_error: z.string().optional(),
    recovery_attempts: z.number().int().nonnegative().optional(),
    recovery_retry_at: z.string().optional(),
    session_id: z.string().startsWith("ses_").optional(),
    authority: ExecutionAuthority.Decision.optional(),
    scope: z
      .object({
        directory: z.string(),
        key: z.string(),
      })
      .optional(),
    sandbox: z
      .object({
        requested: z.boolean(),
        enforced: z.boolean(),
        backend: z.enum(["seatbelt", "bubblewrap", "none"]),
        network: z.enum(["allow", "deny"]),
        warning: z.string().optional(),
      })
      .optional(),
    lifecycle: ComputeLifecycle.State.optional(),
    remote_id: z.string().optional(),
    modal: z
      .object({
        app: z.string(),
        environment: z.string().optional(),
        image: z.string(),
        packages: z.array(z.string()).default([]),
        gpu: z.string(),
        network: z.enum(["unrestricted", "none"]),
        timeout_minutes: z.number().int().positive(),
        uploads: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string() })),
        upload_bytes: z.number().int().nonnegative(),
        approval: z.string().length(64),
        sdk: z.string(),
        volume: z.string().optional(),
      })
      .optional(),
  })
  export type Job = z.infer<typeof Job>

  export type ModalProvider = Pick<typeof ModalAdapter, "run" | "recover" | "find" | "close" | "release" | "volume">

  export type Options = {
    data?: string
    root?: string
    workspace?: string
    hosts?: Host[]
    modal?: ModalAdapter.Config
    credentials?: ModalAdapter.Context
    resolveCredentials?: () => Promise<ModalAdapter.Context>
    provider?: ModalProvider
  }

  async function modalContext(options: Options, message: string): Promise<ModalAdapter.Context> {
    const context = options.credentials ?? (await options.resolveCredentials?.())
    if (!context) throw new Error(message)
    return context
  }

  type Runtime = {
    process?: ChildProcess
    detached: boolean
    authority: ExecutionAuthority.Decision
    root: string
    workspace: string
    id: string
    host?: Host
    modal?: ModalAdapter.Context
    provider?: ModalProvider
  }

  type Scope = {
    root: string
    workspace: string
    key: string
  }

  type Launch = {
    argv: string[]
    sandbox?: Job["sandbox"]
  }

  const active = new Map<string, Runtime>()
  const slots = new Map<string, string>()
  const claims = new Set<string>()
  const locks = new Map<string, Promise<void>>()
  const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])
  const recoveryLimit = 3
  const recoveryDelay = 15_000

  function move(job: Job, event: ComputeLifecycle.Event, value: Partial<Job> = {}): Job {
    const lifecycle = ComputeLifecycle.transition(job.lifecycle ?? ComputeLifecycle.from(job.status), event)
    return Job.parse({ ...job, ...value, status: ComputeLifecycle.legacy(lifecycle), lifecycle })
  }

  const scopeKey = (workspace: string) => crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 40)
  // v1 wrote directly to `<data>/compute/jobs.json` without an owner. Never
  // auto-claim those records: cwd is optional/remote and nested projects make
  // inference ambiguous. They remain recoverable on disk while all current
  // reads and writes use a canonical-workspace bucket below `projects/`.
  const rootOf = (workspace: string, options: Options) =>
    options.root ?? path.join(options.data ?? Global.Path.data, "compute", "projects", scopeKey(workspace))
  const metaOf = (root: string) => path.join(root, "jobs.json")
  const logsOf = (root: string) => path.join(root, "jobs")
  const eventsOf = (root: string, id: string) => path.join(logsOf(root), `${id}.events.log`)
  const exitOf = (root: string, id: string) => path.join(logsOf(root), `${id}.exit`)
  const keyOf = (root: string, id: string) => `${root}\0${id}`

  async function scoped(options: Options): Promise<Scope> {
    const requested = options.workspace ?? Instance.directory
    const workspace = await Filesystem.canonical(requested)
    const info = workspace ? await fs.stat(workspace).catch(() => undefined) : undefined
    if (!workspace || !info?.isDirectory()) throw new Error(`Compute project directory does not exist: ${requested}`)
    return {
      root: rootOf(workspace, options),
      workspace,
      key: scopeKey(workspace),
    }
  }

  async function read(root: string): Promise<Job[]> {
    const filepath = metaOf(root)
    const text = await fs.readFile(filepath, "utf8").catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (text === undefined) return []
    const value = await Promise.resolve()
      .then(() => JSON.parse(text))
      .catch((error) => {
        throw new ComputeJobsCorruptError(filepath, undefined, error)
      })
    const result = Job.array().safeParse(value)
    if (!result.success) throw new ComputeJobsCorruptError(filepath, undefined, result.error)
    return result.data
  }

  async function write(root: string, jobs: Job[]): Promise<void> {
    const clean = await OpenScience.scrubSecrets(jobs)
    const filepath = metaOf(root)
    const temp = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(root, { recursive: true })
    await (async () => {
      const file = await fs.open(temp, "wx", 0o600)
      await file
        .chmod(0o600)
        .then(() => file.writeFile(JSON.stringify(clean, null, 2), "utf8"))
        .then(() => file.sync())
        .finally(() => file.close())
      await fs.rename(temp, filepath)
      const directory = await fs.open(root, "r").catch(() => undefined)
      await directory?.sync().catch(() => undefined)
      await directory?.close().catch(() => undefined)
    })().catch(async (error) => {
      await fs.unlink(temp).catch(() => undefined)
      throw error
    })
  }

  async function event(root: string, id: string, value: string) {
    await fs.mkdir(logsOf(root), { recursive: true })
    const message = OpenScience.redactSecrets(value).replace(/\s+$/, "")
    await fs.appendFile(eventsOf(root, id), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 })
  }

  async function recovery(root: string, job: Job) {
    if (job.recovery_attempts !== undefined) {
      const retry = Date.parse(job.recovery_retry_at ?? "")
      return { attempt: job.recovery_attempts, retry: Number.isFinite(retry) ? retry : 0 }
    }
    const text = await Bun.file(eventsOf(root, job.id))
      .text()
      .catch(() => "")
    const records = text.split("\n").flatMap((line) => {
      const match = line.match(/^\[([^\]]+)\] Modal recovery attempt (\d+)\/\d+ deferred/)
      if (!match) return []
      const time = Date.parse(match[1]!)
      const attempt = Number.parseInt(match[2]!, 10)
      if (!Number.isFinite(time) || !Number.isSafeInteger(attempt)) return []
      return [{ attempt, retry: time + recoveryDelay }]
    })
    return records.at(-1) ?? { attempt: 0, retry: 0 }
  }

  async function snapshot(filepath: string, value: string) {
    const temp = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await fs
      .writeFile(temp, OpenScience.redactSecrets(value), { mode: 0o600, flag: "wx" })
      .then(() => fs.rename(temp, filepath))
      .catch(async (error) => {
        await fs.unlink(temp).catch(() => undefined)
        throw error
      })
  }

  async function preserve(root: string, error: unknown): Promise<never> {
    if (!(error instanceof ComputeJobsCorruptError)) throw error
    const filepath = metaOf(root)
    const backup = `${filepath}.corrupt-${process.pid}`
    const preserved = await fs
      .copyFile(filepath, backup)
      .then(() => fs.chmod(backup, 0o600))
      .then(() => backup)
      .catch(() => undefined)
    throw new ComputeJobsCorruptError(filepath, preserved, error)
  }

  async function change<T>(root: string, edit: (jobs: Job[]) => T | Promise<T>): Promise<T> {
    const prior = locks.get(root) ?? Promise.resolve()
    const task = prior
      .catch(() => undefined)
      .then(async () => {
        const jobs = await read(root).catch((error) => preserve(root, error))
        const result = await edit(jobs)
        await write(root, jobs)
        return result
      })
    locks.set(
      root,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return task
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function sync(scope: Scope, options: Options): Promise<void> {
    const root = scope.root
    const jobs = await read(root)
    const updates = (
      await Promise.all(
        jobs.map(
          async (job): Promise<{ id: string; event: ComputeLifecycle.Event; value: Partial<Job> } | undefined> => {
            const lifecycle = job.lifecycle ?? ComputeLifecycle.from(job.status)
            const key = keyOf(root, job.id)
            const settled =
              terminal.has(job.status) &&
              (job.target.kind !== "modal" ||
                lifecycle.recoverable ||
                (lifecycle.delivery !== "pending" && lifecycle.resource === "closed"))
            if (settled || active.has(key) || claims.has(key)) return
            if (job.status === "queued" && Date.now() - Date.parse(job.created_at) < 5_000) return
            if (job.target.kind === "modal") {
              claims.add(key)
              try {
                const prior = await recovery(root, job)
                if (prior.retry > Date.now()) return
                const credentials = options.credentials ?? (await options.resolveCredentials?.().catch(() => undefined))
                if (!credentials || !job.authority) return
                const provider = options.provider ?? ModalAdapter
                active.set(key, {
                  detached: false,
                  authority: job.authority,
                  root,
                  workspace: scope.workspace,
                  id: job.id,
                  modal: credentials,
                  provider: options.provider,
                })
                const cleanup = terminal.has(job.status) && lifecycle.delivery !== "pending"
                const ready = Promise.withResolvers<void>()
                const task = cleanup
                  ? cleanupModal(job, scope, credentials, provider)
                  : recoverModal(job, scope, credentials, provider, ready.resolve)
                const managed = task
                  .catch(async (error) => {
                    const current = await get(job.id, { root, workspace: scope.workspace })
                    if (error instanceof ModalAdapter.HarvestError && current && !terminal.has(current.status)) {
                      await deferModal(job, scope, error)
                      return
                    }
                    if (current && terminal.has(current.status) && current.lifecycle?.delivery === "pending") {
                      await failModal(current, scope, credentials, error, provider)
                      return
                    }
                    if (!current || terminal.has(current.status)) return
                    const message = OpenScience.redactSecrets(error instanceof Error ? error.message : String(error))
                    const attempt = prior.attempt + 1
                    if (attempt >= recoveryLimit) {
                      await event(root, job.id, `Modal recovery failed after ${attempt} attempts: ${message}`)
                      await failModal(current, scope, credentials, error, provider, true)
                      return
                    }
                    await change(root, (jobs) => {
                      const stored = jobs.find((item) => item.id === job.id)
                      if (!stored) return
                      stored.recovery_attempts = attempt
                      stored.recovery_retry_at = new Date(Date.now() + recoveryDelay).toISOString()
                    })
                    await event(
                      root,
                      job.id,
                      `Modal recovery attempt ${attempt}/${recoveryLimit} deferred for ${recoveryDelay / 1000} seconds: ${message}`,
                    )
                  })
                  .finally(() => active.delete(key))
                void managed.catch(() => undefined)
                if (!cleanup)
                  await Promise.race([
                    ready.promise,
                    Bun.sleep(250),
                    managed.then(
                      () => undefined,
                      () => undefined,
                    ),
                  ])
              } finally {
                claims.delete(key)
              }
              return
            }
            const marker = await Bun.file(exitOf(root, job.id))
              .text()
              .catch(() => undefined)
            const exit = marker?.trim().match(/^-?\d+$/) ? Number(marker.trim()) : undefined
            if (job.target.kind === "local" && exit !== undefined) {
              return {
                id: job.id,
                event: { type: "finish", outcome: exit === 0 ? "succeeded" : "failed" },
                value: {
                  completed_at: new Date().toISOString(),
                  exit_code: exit,
                  pid: undefined,
                },
              }
            }
            if (job.target.kind === "local" && job.pid && alive(job.pid)) return
            return {
              id: job.id,
              event: { type: "interrupt" },
              value: {
                completed_at: new Date().toISOString(),
                exit_code: null,
                pid: undefined,
                error:
                  job.target.kind === "ssh"
                    ? "The app connection ended before this remote job reported a result. Check the remote scheduler before rerunning it."
                    : "The job process ended before it could report a result.",
              },
            }
          },
        ),
      )
    ).filter((item): item is { id: string; event: ComputeLifecycle.Event; value: Partial<Job> } => !!item)
    if (!updates.length) return
    await change(root, (current) => {
      for (const update of updates) {
        const index = current.findIndex((job) => job.id === update.id)
        if (index < 0 || terminal.has(current[index]!.status) || active.has(keyOf(root, update.id))) continue
        const draft = move(current[index]!, update.event, update.value)
        const closed = update.event.type === "finish" ? move(draft, { type: "close" }) : draft
        current[index] = Job.parse({ ...closed, provenance: provenance(closed) })
      }
    })
  }

  export function quote(value: string): string {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`
  }

  function name(value: string): string {
    const clean = value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42)
    return clean || "job"
  }

  function clock(minutes: number): string {
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`
  }

  function workload(input: { command: string; modules?: string[]; container?: string }): string {
    const modules = input.modules?.length ? `module load ${input.modules.map(quote).join(" ")}` : undefined
    const command = input.container
      ? `apptainer exec ${quote(input.container)} bash -lc ${quote(input.command)}`
      : input.command
    return [modules, command].filter((part): part is string => !!part).join(" && ")
  }

  function slurm(input: { resources?: Resources }): string[] {
    const resources = input.resources
    if (!resources) return []
    return [
      resources.cpus ? `--cpus-per-task=${resources.cpus}` : undefined,
      resources.gpus ? `--gres=gpu:${resources.gpus}` : undefined,
      resources.memory_gb ? `--mem=${resources.memory_gb}G` : undefined,
      resources.time_minutes ? `--time=${clock(resources.time_minutes)}` : undefined,
      resources.partition ? `--partition=${quote(resources.partition)}` : undefined,
    ].filter((part): part is string => !!part)
  }

  function pbs(input: { resources?: Resources }): string[] {
    const resources = input.resources
    if (!resources) return []
    const select = [
      "select=1",
      resources.cpus ? `ncpus=${resources.cpus}` : undefined,
      resources.gpus ? `ngpus=${resources.gpus}` : undefined,
      resources.memory_gb ? `mem=${resources.memory_gb}gb` : undefined,
    ]
      .filter((part): part is string => !!part)
      .join(":")
    return [
      select === "select=1" ? undefined : `-l ${quote(select)}`,
      resources.time_minutes ? `-l ${quote(`walltime=${clock(resources.time_minutes)}`)}` : undefined,
    ].filter((part): part is string => !!part)
  }

  function remote(
    input: {
      id: string
      name: string
      command: string
      cwd?: string
      resources?: Resources
      modules?: string[]
      container?: string
    },
    host: Host,
  ): string {
    const cwd = input.cwd || host.workdir || "."
    const job = `os-${input.id}`
    const folder = `.openscience/jobs`
    const log = `${folder}/${input.id}.log`
    const enter = `cd ${quote(cwd)} && mkdir -p ${quote(folder)}`
    const run = workload(input)
    if (host.scheduler === "slurm") {
      return [
        enter,
        [
          "sbatch --wait --parsable",
          `--job-name=${quote(job)}`,
          `--output=${quote(log)}`,
          `--error=${quote(log)}`,
          ...slurm(input),
          `--wrap=${quote(run)}`,
        ].join(" "),
        "code=$?",
        `test -f ${quote(log)} && cat ${quote(log)}`,
        "exit $code",
      ].join("; ")
    }
    if (host.scheduler === "pbs") {
      const script = `#!/usr/bin/env bash\nset -o pipefail\n${run}\n`
      return [
        enter,
        [
          `printf %s ${quote(script)} | qsub -W block=true`,
          `-N ${quote(name(job))}`,
          "-j oe",
          `-o ${quote(log)}`,
          ...pbs(input),
        ].join(" "),
        "code=$?",
        `test -f ${quote(log)} && cat ${quote(log)}`,
        "exit $code",
      ].join("; ")
    }
    return `${enter} && exec bash -lc ${quote(run)}`
  }

  function ssh(host: Host, script: string): string[] {
    const destination = host.user ? `${host.user}@${host.host}` : host.host
    if (destination.startsWith("-")) throw new Error("SSH destinations cannot begin with a hyphen")
    const port = host.port ? ["-p", String(host.port)] : []
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...port, "--", destination, script]
  }

  export function command(
    input: {
      id: string
      name: string
      command: string
      cwd?: string
      resources?: Resources
      modules?: string[]
      container?: string
    },
    host?: Host,
  ): { argv: string[]; scheduler: Scheduler; label: string } {
    if (!host) {
      return {
        argv: [Shell.acceptable(), "-lc", input.command],
        scheduler: "none",
        label: "This computer",
      }
    }
    return {
      argv: ssh(host, remote(input, host)),
      scheduler: host.scheduler,
      label: host.label,
    }
  }

  async function launch(
    job: Job,
    host: Host | undefined,
    scope: Scope,
    authority: ExecutionAuthority.Decision,
  ): Promise<Launch> {
    const spec = command(job, host)
    if (host) {
      const planned = Sandbox.wrapArgv({
        file: spec.argv[0]!,
        args: spec.argv.slice(1),
        workspace: authority.writable,
        unreadable: OpenScience.kernelSensitivePaths(),
        options: authority.sandbox,
      })
      return {
        argv: [planned.file, ...planned.args],
        sandbox: {
          requested: authority.sandbox.enabled,
          enforced: planned.sandboxed,
          backend: planned.backend,
          network: authority.sandbox.network,
          warning: planned.warning,
        },
      }
    }

    await fs.mkdir(logsOf(scope.root), { recursive: true })
    await fs.writeFile(exitOf(scope.root, job.id), "", { mode: 0o600 })
    const wrapped = `(${job.command}\n); code=$?; printf %s "$code" > ${quote(exitOf(scope.root, job.id))}; exit "$code"`
    const planned = Sandbox.wrapArgv({
      file: Shell.acceptable(),
      args: ["-lc", wrapped],
      workspace: authority.writable,
      extraWritable: [exitOf(scope.root, job.id)],
      unreadable: OpenScience.kernelSensitivePaths(),
      options: authority.sandbox,
    })
    return {
      argv: [planned.file, ...planned.args],
      sandbox: {
        requested: authority.sandbox.enabled,
        enforced: planned.sandboxed,
        backend: planned.backend,
        network: authority.sandbox.network,
        warning: planned.warning,
      },
    }
  }

  async function output(
    argv: string[],
    cwd: string,
    authority: ExecutionAuthority.Decision,
  ): Promise<string | undefined> {
    const planned = Sandbox.wrapArgv({
      file: argv[0]!,
      args: argv.slice(1),
      workspace: authority.writable,
      unreadable: OpenScience.kernelSensitivePaths(),
      options: authority.sandbox,
    })
    const proc = Bun.spawn([planned.file, ...planned.args], {
      cwd,
      env: await OpenScience.subprocessEnv(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    if (code !== 0) return
    return text.trim() || undefined
  }

  function inside(root: string, file: string): string | undefined {
    const target = path.resolve(root, file)
    const relative = path.relative(root, target)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
    return relative
  }

  async function fingerprint(root: string, file: string): Promise<Artifact | undefined> {
    const relative = inside(root, file)
    if (!relative) return
    const target = path.join(root, relative)
    const canonical = await Filesystem.canonical(target)
    if (!canonical || !Filesystem.contains(root, canonical)) {
      throw new Error(`Artifact path escapes the project workspace: ${file}`)
    }
    const stat = await fs.stat(canonical).catch(() => undefined)
    if (!stat?.isFile()) return
    const hash = new Bun.CryptoHasher("sha256")
    for await (const chunk of createReadStream(canonical)) hash.update(chunk)
    return Artifact.parse({
      path: relative.split(path.sep).join("/"),
      size: stat.size,
      sha256: hash.digest("hex"),
      modified_at: stat.mtime.toISOString(),
    })
  }

  async function checksum(file: string) {
    const hash = new Bun.CryptoHasher("sha256")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest("hex")
  }

  async function artifacts(root: string, patterns: string[]): Promise<Artifact[]> {
    const files = new Set<string>()
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern)
      for await (const file of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
        files.add(file)
        if (files.size >= 200) break
      }
      if (files.size >= 200) break
    }
    const values = await Promise.all([...files].toSorted().map((file) => fingerprint(root, file)))
    return values.filter((item): item is Artifact => !!item)
  }

  function prefix(pattern: string): string {
    const index = pattern.search(/[*?[{]/)
    const head = index < 0 ? pattern : pattern.slice(0, index)
    return head.endsWith(path.sep) || head.endsWith("/") ? head.slice(0, -1) : path.dirname(head)
  }

  async function outputPath(root: string, file: string, label: string): Promise<void> {
    if (!inside(root, file)) throw new Error(`${label} must stay inside the project working directory: ${file}`)
    const canonical = await Filesystem.canonical(path.resolve(root, file))
    if (!canonical || !Filesystem.contains(root, canonical)) {
      throw new Error(`${label} escapes the project working directory through a symlink: ${file}`)
    }
  }

  async function outputs(root: string, patterns: string[], checkpoint?: string): Promise<void> {
    for (const pattern of patterns) {
      await outputPath(root, pattern.replace(/[*?[{].*$/, "output"), "Artifact pattern")
      const base = prefix(pattern)
      if (base === ".") continue
      await outputPath(root, base, "Artifact pattern")
    }
    if (checkpoint) await outputPath(root, checkpoint, "Checkpoint path")
  }

  async function modal(input: Request, cwd: string, context?: ModalAdapter.Config) {
    if (!context) throw new Error("Modal is not enabled or connected")
    if (!input.gpu) throw new Error("A Modal GPU type is required")
    if (input.modules?.length) throw new Error("Environment modules are only supported by SSH compute")
    if (input.container) throw new Error("Use the Modal image field instead of an Apptainer container")
    if (input.resources?.partition) throw new Error("Scheduler partitions are only supported by SSH compute")
    const timeout = input.resources?.time_minutes ?? context.timeoutMinutes
    if (timeout > 24 * 60) throw new Error("Modal jobs are limited to 24 hours")
    const patterns = [...(input.artifacts ?? []), ...(input.checkpoint ? [input.checkpoint] : [])]
    await outputs(cwd, input.artifacts ?? [], input.checkpoint)
    return ModalPlan.prepare({
      command: input.command,
      cwd,
      image: input.image ?? context.image,
      packages: input.packages ?? [],
      gpu: input.gpu,
      resources: input.resources
        ? {
            cpus: input.resources.cpus,
            gpus: input.resources.gpus,
            memory_gb: input.resources.memory_gb,
          }
        : undefined,
      timeoutMinutes: timeout,
      uploads: input.uploads ?? [],
      outputs: patterns,
      context,
    })
  }

  function modalSpec(job: Job, files: ModalAdapter.File[], scope: Scope): ModalAdapter.Spec {
    if (!job.modal || !job.cwd) throw new Error(`Modal job ${job.id} is missing its dispatch specification`)
    return {
      id: job.id,
      project: job.cwd,
      command: job.command,
      image: job.modal.image,
      packages: job.modal.packages,
      gpu: job.modal.gpu,
      gpus: job.resources?.gpus,
      cpus: job.resources?.cpus,
      memoryGb: job.resources?.memory_gb,
      timeoutMinutes: job.modal.timeout_minutes,
      uploads: files,
      outputs: [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])],
      staging: path.join(logsOf(scope.root), `${job.id}.modal`),
      volume: job.modal.volume ?? ModalAdapter.volume(job.cwd, job.id),
    }
  }

  async function deliver(
    root: string,
    found: ModalAdapter.Result["outputs"],
    expected: string[],
    required: boolean,
  ): Promise<void> {
    const missing = expected.filter((pattern) => {
      if (!required) return false
      const glob = new Bun.Glob(pattern.split(path.sep).join("/"))
      return !found.some((file) => glob.match(file.path.split(path.sep).join("/")))
    })
    if (missing.length)
      throw new Error(`Modal did not produce declared output${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`)
    for (const file of found) {
      await outputPath(root, file.path, "Modal output")
      const source = await Filesystem.canonical(file.staging)
      const staging = await Filesystem.canonical(path.dirname(file.staging))
      if (!source || !staging || !Filesystem.contains(staging, source)) {
        throw new Error(`Modal output staging file is unavailable: ${file.path}`)
      }
      const info = await fs.stat(source).catch(() => undefined)
      if (!info?.isFile() || info.size !== file.size) {
        throw new Error(`Modal output size changed during delivery: ${file.path}`)
      }
      if (file.sha256 && (await checksum(source)) !== file.sha256) {
        throw new Error(`Modal output checksum changed during delivery: ${file.path}`)
      }
      const target = path.resolve(root, file.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(source, target)
      const copied = await fs.stat(target)
      if (copied.size !== file.size || (file.sha256 && (await checksum(target)) !== file.sha256)) {
        throw new Error(`Modal output copy failed integrity verification: ${file.path}`)
      }
    }
  }

  const lockfiles = [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "requirements.txt",
    "environment.yml",
    "environment.yaml",
    "renv.lock",
    "Manifest.toml",
    "Cargo.lock",
  ]

  async function reproduce(job: Job, authority: ExecutionAuthority.Decision): Promise<Reproducibility> {
    const cwd = path.resolve(job.cwd ?? process.cwd())
    const [repository, branch, commit, status, python, capturedLocks] = await Promise.all([
      output(["git", "remote", "get-url", "origin"], cwd, authority),
      output(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd, authority),
      output(["git", "rev-parse", "HEAD"], cwd, authority),
      output(["git", "status", "--porcelain"], cwd, authority),
      output(["python3", "--version"], cwd, authority),
      Promise.all(lockfiles.map((file) => fingerprint(cwd, file))),
    ])
    const git =
      repository || branch || commit || status !== undefined
        ? { repository, branch, commit, dirty: !!status }
        : undefined
    return Reproducibility.parse({
      captured_at: new Date().toISOString(),
      command: job.command,
      cwd,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: process.version,
      python,
      git,
      lockfiles: capturedLocks.filter((item): item is Artifact => !!item),
      resources: job.resources,
    })
  }

  function provenance(job: Job): ProvenanceEnvelope.Schema {
    const outputs = [
      ...(job.artifacts ?? []).map((artifact) =>
        ProvenanceEnvelope.output({
          kind: "artifact",
          label: artifact.path,
          artifactID: artifact.path,
          path: artifact.path,
          sha256: artifact.sha256,
          size: artifact.size,
          createdAt: artifact.modified_at,
          versionReason: "not_versioned",
        }),
      ),
      ...(job.checkpoint
        ? [
            ProvenanceEnvelope.output({
              kind: "checkpoint",
              label: job.checkpoint.path,
              artifactID: job.checkpoint.path,
              path: job.checkpoint.path,
              sha256: job.checkpoint.sha256,
              size: job.checkpoint.size,
              createdAt: job.checkpoint.modified_at,
              versionReason: "not_versioned",
            }),
          ]
        : []),
    ]
    const status = job.status === "succeeded" ? "succeeded" : job.status === "failed" ? "failed" : job.status
    return ProvenanceEnvelope.create({
      kind: job.target.kind === "local" ? "local_compute" : "remote_compute",
      projectID: job.authority?.projectID ?? job.scope?.key,
      sessionID: job.session_id,
      runID: job.id,
      code: job.command,
      cwd: job.cwd,
      codeState: job.reproducibility?.git,
      codeReason: job.target.kind === "ssh" ? "remote_unverified" : "not_captured",
      host: job.reproducibility
        ? {
            platform: job.reproducibility.platform,
            arch: job.reproducibility.arch,
            runtimes: {
              bun: job.reproducibility.bun,
              node: job.reproducibility.node,
              ...(job.reproducibility.python ? { python: job.reproducibility.python } : {}),
            },
          }
        : undefined,
      hostReason: job.target.kind === "ssh" ? "remote_unverified" : "not_captured",
      status,
      outputs,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    })
  }

  async function capture(job: Job): Promise<Pick<Job, "artifacts" | "checkpoint">> {
    const cwd = path.resolve(job.cwd ?? process.cwd())
    const [found, checkpoint] = await Promise.all([
      artifacts(cwd, job.artifact_patterns ?? []),
      job.checkpoint_path ? fingerprint(cwd, job.checkpoint_path) : undefined,
    ])
    return {
      artifacts: found,
      checkpoint,
    }
  }

  async function captureModal(
    job: Job,
    files: ModalAdapter.Result["outputs"],
  ): Promise<Pick<Job, "artifacts" | "checkpoint">> {
    const cwd = path.resolve(job.cwd ?? process.cwd())
    const patterns = (job.artifact_patterns ?? []).map((pattern) => new Bun.Glob(pattern.split(path.sep).join("/")))
    const captured = await Promise.all(
      [...new Set(files.map((file) => file.path))].map((file) => fingerprint(cwd, file)),
    )
    const found = captured.filter((item): item is Artifact => !!item)
    const checkpoint = job.checkpoint_path
      ? found.find((item) => item.path === job.checkpoint_path!.split(path.sep).join("/"))
      : undefined
    return {
      artifacts: found.filter((item) => patterns.some((pattern) => pattern.match(item.path))),
      checkpoint,
    }
  }

  export async function probe(host: Host): Promise<Probe> {
    const parsed = Host.parse(host)
    const started = performance.now()
    const script = [
      "printf 'connected=1\\n'",
      "printf 'hostname='; hostname 2>/dev/null || true",
      "command -v python3 >/dev/null 2>&1 && printf 'python=1\\n' || true",
      "command -v nvidia-smi >/dev/null 2>&1 && printf 'gpu=1\\n' || true",
      "command -v sbatch >/dev/null 2>&1 && printf 'slurm=1\\n' || true",
      "command -v qsub >/dev/null 2>&1 && printf 'pbs=1\\n' || true",
    ].join("; ")
    const argv = ssh(parsed, script)
    const proc = spawn(argv[0]!, argv.slice(1), {
      env: await OpenScience.subprocessEnv(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    proc.stderr?.on("data", (chunk: Buffer) => errors.push(chunk))
    const done = new Promise<{ code: number | null; error?: string }>((resolve) => {
      proc.once("error", (error) => resolve({ code: null, error: error.message }))
      proc.once("exit", (code) => resolve({ code }))
    })
    const result = await Promise.race([
      done,
      Bun.sleep(12_000).then(() => ({ code: null, error: "Connection timed out" })),
    ])
    if (proc.exitCode === null) {
      await Shell.killTree(proc, {
        detached: false,
        exited: () => proc.exitCode !== null,
      })
    }
    const text = Buffer.concat(output).toString("utf8")
    const error = result.error || (result.code === 0 ? undefined : Buffer.concat(errors).toString("utf8").trim())
    return Probe.parse({
      ok: result.code === 0 && text.includes("connected=1"),
      host: parsed.label,
      latency_ms: Math.round(performance.now() - started),
      hostname: text.match(/^hostname=(.+)$/m)?.[1]?.trim(),
      python: text.includes("python=1"),
      gpu: text.includes("gpu=1"),
      slurm: text.includes("slurm=1"),
      pbs: text.includes("pbs=1"),
      error: error || undefined,
    })
  }

  async function execute(
    job: Job,
    host: Host | undefined,
    scope: Scope,
    authority: ExecutionAuthority.Decision,
    launch: Launch,
  ): Promise<void> {
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    const log = path.join(logsOf(scope.root), `${job.id}.log`)
    const output = await fs.open(log, "a", 0o600)
    const env = await OpenScience.subprocessEnv(process.env)
    const queued = (await read(scope.root)).find((item) => item.id === job.id)
    if (queued?.status === "cancelled") {
      await output.close()
      active.delete(keyOf(scope.root, job.id))
      return
    }
    const detached = process.platform !== "win32"
    const proc = spawn(launch.argv[0]!, launch.argv.slice(1), {
      cwd: host ? authority.workspace : job.cwd,
      env,
      detached,
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd],
    })
    const result = new Promise<{ code: number | null; error?: string }>((resolve) => {
      proc.once("error", (error) => resolve({ code: null, error: error.message }))
      proc.once("exit", (code) => resolve({ code }))
    })
    const key = keyOf(scope.root, job.id)
    active.set(key, {
      process: proc,
      detached,
      authority,
      root: scope.root,
      workspace: scope.workspace,
      id: job.id,
      host,
    })
    await output.close()
    const started = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return false
      const draft = move(
        jobs[index]!,
        { type: "run" },
        {
          started_at: new Date().toISOString(),
          pid: proc.pid,
        },
      )
      jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
      return true
    })
    if (!started) {
      await Shell.killTree(proc, {
        detached,
        exited: () => proc.exitCode !== null,
      })
      active.delete(key)
      return
    }
    const completed = await result
    const captureResult = host
      ? undefined
      : await capture(job)
          .then((value) => ({ ...value, capture_error: undefined }))
          .catch((error) => ({
            capture_error: error instanceof Error ? error.message : String(error),
          }))
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return
      const draft = move(
        jobs[index]!,
        {
          type: "finish",
          outcome: completed.code === 0 ? "succeeded" : "failed",
          ...(completed.error ? { message: completed.error } : {}),
        },
        {
          completed_at: new Date().toISOString(),
          exit_code: completed.code,
          error: completed.error,
          ...captureResult,
        },
      )
      const closed = move(draft, { type: "close" })
      jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
    }).finally(() => active.delete(key))
  }

  async function completeModal(
    job: Job,
    scope: Scope,
    context: ModalAdapter.Context,
    result: ModalAdapter.Result,
    provider: ModalProvider,
  ): Promise<void> {
    const timeout = result.timedOut
      ? `Modal job timed out after ${job.modal?.timeout_minutes ?? "the configured"} minutes`
      : undefined
    const finished = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) return
      if (terminal.has(jobs[index]!.status)) {
        return jobs[index]!.lifecycle?.delivery === "pending" ? jobs[index]! : undefined
      }
      const draft = move(
        jobs[index]!,
        {
          type: "finish",
          outcome: result.timedOut ? "timed_out" : result.code === 0 ? "succeeded" : "failed",
          ...(timeout ? { message: timeout } : {}),
        },
        { completed_at: new Date().toISOString(), exit_code: result.code, ...(timeout ? { error: timeout } : {}) },
      )
      const collecting = job.artifact_patterns?.length || job.checkpoint_path ? move(draft, { type: "collect" }) : draft
      jobs[index] = Job.parse({ ...collecting, provenance: provenance(collecting) })
      return collecting
    })
    if (!finished) return
    if (job.artifact_patterns?.length || job.checkpoint_path) {
      const expected = [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])]
      const received = await deliver(job.cwd!, result.outputs, expected, result.code === 0)
        .then(() => captureModal(job, result.outputs))
        .then((captured) => ({ ok: true as const, captured }))
        .catch((error) => ({ ok: false as const, error }))
      if (!received.ok) {
        const message = received.error instanceof Error ? received.error.message : String(received.error)
        await change(scope.root, (jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id)
          if (index < 0 || jobs[index]!.lifecycle?.delivery !== "pending") return
          const failed = move(jobs[index]!, { type: "delivery_fail", message }, { capture_error: message })
          const unknown = move(failed, { type: "lose" })
          jobs[index] = Job.parse({ ...unknown, provenance: provenance(unknown) })
        })
        return
      }
      await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0 || jobs[index]!.lifecycle?.delivery !== "pending") return
        const draft = move(jobs[index]!, { type: "deliver" })
        const delivered = Job.parse({ ...draft, ...received.captured })
        jobs[index] = Job.parse({ ...delivered, provenance: provenance(delivered) })
      })
    }
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || jobs[index]!.lifecycle?.delivery !== "pending") return
      const draft = move(jobs[index]!, { type: "deliver" })
      jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
    })
    const current = await get(job.id, { root: scope.root, workspace: scope.workspace })
    if (!current) return
    const spec = modalSpec(current, [], scope)
    const released = await provider.release(context, spec, current.remote_id).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    )
    if (released.ok && current.remote_id) await event(scope.root, job.id, `Closed Modal sandbox ${current.remote_id}`)
    if (released.ok) await event(scope.root, job.id, `Released Modal volume ${spec.volume}`)
    const warning = released.ok
      ? undefined
      : `Modal cleanup failed after the job finished. Its sandbox or durable volume may still be billing; retry cleanup. ${OpenScience.redactSecrets(
          released.error instanceof Error ? released.error.message : String(released.error),
        )}`
    if (warning) await event(scope.root, job.id, warning)
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || jobs[index]!.lifecycle?.resource === "closed") return
      const ended = released.ok ? move(jobs[index]!, { type: "close" }) : move(jobs[index]!, { type: "lose" })
      const updated = Job.parse({
        ...ended,
        cleanup_error: warning,
        provenance: provenance(ended),
      })
      jobs[index] = updated
    })
    await event(
      scope.root,
      job.id,
      `Modal job ${result.timedOut ? "timed out" : result.code === 0 ? "succeeded" : "failed"}`,
    )
    await fs.rm(path.join(logsOf(scope.root), `${job.id}.modal`), { recursive: true, force: true })
  }

  async function executeModal(
    job: Job,
    files: ModalAdapter.File[],
    scope: Scope,
    context: ModalAdapter.Context,
    provider: ModalProvider,
  ): Promise<void> {
    const log = path.join(logsOf(scope.root), `${job.id}.log`)
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    await event(scope.root, job.id, "Dispatching governed job to Modal")
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return
      const draft = move(jobs[index]!, { type: "start" }, { started_at: new Date().toISOString() })
      jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
    })
    const result = await provider.run(context, modalSpec(job, files, scope), {
      created: async (id) => {
        const started = await change(scope.root, (jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id)
          if (index < 0 || terminal.has(jobs[index]!.status)) return false
          const draft = move(jobs[index]!, { type: "run" }, { remote_id: id })
          jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
          return true
        })
        if (!started) throw new Error("Modal job was cancelled before its sandbox became ready")
      },
      log: async (value) => {
        await event(scope.root, job.id, value)
      },
      output: async (value) => {
        await snapshot(log, value)
      },
    })
    await completeModal(job, scope, context, result, provider)
  }

  async function recoverModal(
    job: Job,
    scope: Scope,
    context: ModalAdapter.Context,
    provider: ModalProvider,
    attached?: () => void,
  ): Promise<void> {
    const log = path.join(logsOf(scope.root), `${job.id}.log`)
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    await event(scope.root, job.id, "Recovering Modal job after OpenScience restart")
    const spec = modalSpec(job, [], scope)
    const id = job.remote_id ?? (await provider.find(context, job.id, spec.project))
    if (id && !job.remote_id) {
      await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0 || terminal.has(jobs[index]!.status)) return
        const current = jobs[index]!
        const draft =
          current.status === "queued"
            ? move(
                current,
                { type: "run" },
                { remote_id: id, started_at: current.started_at ?? new Date().toISOString() },
              )
            : Job.parse({ ...current, remote_id: id })
        jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
      })
    }
    attached?.()
    const result = await provider.recover(context, spec, id, {
      log: async (value) => {
        await event(scope.root, job.id, value)
      },
      output: async (value) => {
        await snapshot(log, value)
      },
    })
    await completeModal(Job.parse({ ...job, remote_id: id }), scope, context, result, provider)
  }

  async function cleanupModal(
    job: Job,
    scope: Scope,
    context: ModalAdapter.Context,
    provider: ModalProvider,
  ): Promise<void> {
    const current = await get(job.id, { root: scope.root, workspace: scope.workspace })
    if (!current || current.lifecycle?.resource === "closed") return
    const spec = modalSpec(current, [], scope)
    const released = await provider.release(context, spec, current.remote_id).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    )
    if (released.ok && current.remote_id) await event(scope.root, job.id, `Closed Modal sandbox ${current.remote_id}`)
    if (released.ok) await event(scope.root, job.id, `Released Modal volume ${spec.volume}`)
    const message = released.ok
      ? undefined
      : `Modal cleanup failed. Its sandbox or durable volume may still be billing; retry cleanup. ${OpenScience.redactSecrets(
          released.error instanceof Error ? released.error.message : String(released.error),
        )}`
    if (message) await event(scope.root, job.id, message)
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || jobs[index]!.lifecycle?.resource === "closed") return
      const ended = released.ok ? move(jobs[index]!, { type: "close" }) : move(jobs[index]!, { type: "lose" })
      jobs[index] = Job.parse({ ...ended, cleanup_error: message, provenance: provenance(ended) })
    })
    if (released.ok) await fs.rm(path.join(logsOf(scope.root), `${job.id}.modal`), { recursive: true, force: true })
  }

  async function failModal(
    job: Job,
    scope: Scope,
    context: ModalAdapter.Context,
    error: unknown,
    provider: ModalProvider,
    retain = false,
  ): Promise<void> {
    const message = OpenScience.redactSecrets(error instanceof Error ? error.message : String(error))
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    await event(scope.root, job.id, `Modal error: ${message}`)
    await fs.appendFile(path.join(logsOf(scope.root), `${job.id}.log`), `${message}\n`, { mode: 0o600 })
    const current = await get(job.id, { root: scope.root, workspace: scope.workspace })
    if (!current) return
    if (terminal.has(current.status)) {
      if (current.lifecycle?.delivery !== "pending") return
      await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0 || jobs[index]!.lifecycle?.delivery !== "pending") return
        const failed = move(
          jobs[index]!,
          { type: "delivery_fail", message },
          { capture_error: message, error: message },
        )
        const unknown = move(failed, { type: "lose" })
        jobs[index] = Job.parse({ ...unknown, provenance: provenance(unknown) })
      })
      return
    }
    if (current.remote_id && current.cwd)
      await provider.close(context, current.remote_id, job.id, current.cwd).catch(() => undefined)
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return
      const draft = move(
        jobs[index]!,
        { type: "finish", outcome: "failed", message },
        { completed_at: new Date().toISOString(), exit_code: null, error: message },
      )
      const ended = (() => {
        if (!retain) return move(draft, { type: "lose" })
        const collecting = move(draft, { type: "collect" })
        const failed = move(collecting, { type: "delivery_fail", message })
        return move(failed, { type: "lose" })
      })()
      jobs[index] = Job.parse({
        ...ended,
        ...(retain ? { capture_error: message } : {}),
        provenance: provenance(ended),
      })
    })
  }

  async function deferModal(job: Job, scope: Scope, error: ModalAdapter.HarvestError): Promise<void> {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    const message = OpenScience.redactSecrets(`${error.message}. ${cause}`)
    await event(scope.root, job.id, `Modal result recovery pending: ${message}`)
    await fs.appendFile(path.join(logsOf(scope.root), `${job.id}.log`), `${message}\n`, { mode: 0o600 })
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return
      const finished = move(
        jobs[index]!,
        { type: "finish", outcome: error.code === 124 ? "timed_out" : error.code === 0 ? "succeeded" : "failed" },
        { completed_at: new Date().toISOString(), exit_code: error.code },
      )
      const collecting = move(finished, { type: "collect" })
      const failed = move(collecting, { type: "delivery_fail", message }, { capture_error: message })
      const recoverable = move(failed, { type: "lose" })
      jobs[index] = Job.parse({ ...recoverable, provenance: provenance(recoverable) })
    })
  }

  export async function retry(id: string, options: Options = {}): Promise<Job> {
    const scope = await scoped(options)
    const key = keyOf(scope.root, id)
    if (active.has(key)) throw new Error(`Compute job ${id} already has an active recovery`)
    const provider = options.provider ?? ModalAdapter
    const job = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`Compute job ${id} was not found`)
      const current = jobs[index]!
      if (current.target.kind !== "modal" || !current.modal || !current.cwd || !current.authority) {
        throw new Error(`Compute job ${id} has no recoverable Modal output`)
      }
      if (!terminal.has(current.status) || !current.lifecycle?.recoverable) {
        throw new Error(`Compute job ${id} has no recoverable Modal output`)
      }
      const draft = move(current, { type: "retry_delivery" }, { error: undefined, capture_error: undefined })
      const updated = Job.parse({ ...draft, provenance: provenance(draft) })
      jobs[index] = updated
      return updated
    })
    const context = await modalContext(options, "Enable Modal before retrying output delivery")
    active.set(key, {
      detached: false,
      authority: job.authority!,
      root: scope.root,
      workspace: scope.workspace,
      id: job.id,
      modal: context,
      provider,
    })
    void recoverModal(job, scope, context, provider)
      .catch((error) => failModal(job, scope, context, error, provider))
      .finally(() => active.delete(key))
    return job
  }

  export async function release(id: string, options: Options = {}): Promise<Job> {
    const scope = await scoped(options)
    const key = keyOf(scope.root, id)
    if (active.has(key)) throw new Error(`Compute job ${id} still has an active recovery`)
    const job = await get(id, { root: scope.root, workspace: scope.workspace })
    if (!job) throw new Error(`Compute job ${id} was not found`)
    if (job.target.kind !== "modal" || !job.modal || !job.cwd) {
      throw new Error(`Compute job ${id} has no Modal resources to release`)
    }
    if (!terminal.has(job.status)) throw new Error(`Cancel compute job ${id} before releasing its resources`)
    if (job.lifecycle?.resource === "closed") return job
    const context = await modalContext(options, "Enable Modal before releasing retained job resources")
    const provider = options.provider ?? ModalAdapter
    const spec = modalSpec(job, [], scope)
    await provider.release(context, spec, job.remote_id)
    if (job.remote_id) await event(scope.root, job.id, `Closed Modal sandbox ${job.remote_id}`)
    await event(scope.root, job.id, `Released Modal volume ${spec.volume}`)
    const released = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`Compute job ${id} was not found`)
      const current = jobs[index]!
      if (current.lifecycle?.resource === "closed") return current
      const abandoned = current.lifecycle?.recoverable ? move(current, { type: "abandon" }) : current
      const closed = move(abandoned, { type: "close" })
      const updated = Job.parse({ ...closed, provenance: provenance(closed) })
      jobs[index] = updated
      return updated
    })
    await fs.rm(path.join(logsOf(scope.root), `${job.id}.modal`), { recursive: true, force: true })
    return released
  }

  export async function plan(input: Request, options: Options = {}): Promise<ModalPlan.Schema> {
    const parsed = Request.parse(input)
    if (parsed.target.kind !== "modal") throw new Error("Only Modal jobs require an approval plan")
    const scope = await scoped(options)
    const authority = await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: parsed.sessionID,
      capability: "remote_job",
    })
    const requested = parsed.cwd ? path.resolve(authority.workspace, parsed.cwd) : authority.workspace
    const cwd = await Filesystem.canonical(requested)
    const info = cwd ? await fs.stat(cwd).catch(() => undefined) : undefined
    if (!cwd || !info?.isDirectory() || !Filesystem.contains(authority.workspace, cwd)) {
      throw new Error(`Modal working directory must be inside the session workspace: ${parsed.cwd ?? requested}`)
    }
    if (scope.workspace !== authority.workspace) throw new Error("Compute project does not match the session workspace")
    return (await modal(parsed, cwd, options.modal)).plan
  }

  export async function start(input: Request, options: Options = {}): Promise<Job> {
    const parsed = Request.parse(input)
    const scope = await scoped(options)
    const hostId = parsed.target.kind === "ssh" ? parsed.target.host_id : undefined
    const host = hostId ? options.hosts?.find((item) => item.id === hostId) : undefined
    if (parsed.target.kind === "ssh" && !host) throw new Error("The selected SSH compute profile was not found")
    const authority = await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: parsed.sessionID,
      capability: host || parsed.target.kind === "modal" ? "remote_job" : "local_job",
    })
    if (scope.workspace !== authority.workspace) throw new Error("Compute project does not match the session workspace")
    const requested = parsed.cwd ? path.resolve(authority.workspace, parsed.cwd) : authority.workspace
    const cwd = host ? parsed.cwd || host.workdir : await Filesystem.canonical(requested)
    const info = !host && cwd ? await fs.stat(cwd).catch(() => undefined) : undefined
    if (!host && (!cwd || !info?.isDirectory() || !Filesystem.contains(authority.workspace, cwd))) {
      throw new Error(
        `Local compute working directory must be inside the session workspace: ${parsed.cwd ?? requested}`,
      )
    }
    const prepared = parsed.target.kind === "modal" ? await modal(parsed, cwd!, options.modal) : undefined
    const provider = options.provider ?? ModalAdapter
    if (prepared && parsed.approval !== prepared.plan.digest) {
      throw new Error("The Modal run must be approved using its current plan digest")
    }
    if (!host && parsed.target.kind !== "modal") await outputs(cwd!, parsed.artifacts ?? [], parsed.checkpoint)
    const id = crypto.randomUUID().slice(0, 12)
    const spec =
      parsed.target.kind === "modal"
        ? { label: "Modal", scheduler: "none" as const }
        : command({ id, ...parsed, cwd }, host)
    const lifecycle = ComputeLifecycle.transition(ComputeLifecycle.initial(), { type: "queue" })
    const draft = Job.parse({
      id,
      name: parsed.name,
      command: parsed.command,
      cwd,
      target: parsed.target,
      target_label: spec.label,
      scheduler: spec.scheduler,
      status: ComputeLifecycle.legacy(lifecycle),
      lifecycle,
      remote_id: undefined,
      modal: prepared
        ? {
            app: prepared.plan.app,
            environment: prepared.plan.environment,
            image: prepared.plan.image,
            packages: prepared.plan.packages,
            gpu: prepared.plan.gpu,
            network: prepared.plan.network,
            timeout_minutes: prepared.plan.timeout_minutes,
            uploads: prepared.plan.uploads,
            upload_bytes: prepared.plan.upload_bytes,
            approval: prepared.plan.digest,
            sdk: ModalAdapter.VERSION,
            volume: provider.volume(cwd!, id),
          }
        : undefined,
      created_at: new Date().toISOString(),
      resources: parsed.resources,
      modules: parsed.modules,
      container: parsed.container,
      artifact_patterns: parsed.artifacts,
      checkpoint_path: parsed.checkpoint,
      session_id: parsed.sessionID,
      authority,
      scope: {
        directory: scope.workspace,
        key: scope.key,
      },
    })
    if (prepared) {
      const context = await modalContext(options, "Modal credentials were not resolved for dispatch")
      const key = keyOf(scope.root, draft.id)
      const busy =
        [...active.values()].filter((runtime) => runtime.root === scope.root && runtime.modal).length +
        [...slots.values()].filter((root) => root === scope.root).length
      if (busy >= context.concurrency) {
        throw new Error(`Modal concurrency limit reached for this project (${busy}/${context.concurrency})`)
      }
      slots.set(key, scope.root)
      return Promise.resolve()
        .then(async () => {
          const reproducibility = await reproduce(draft, authority)
          const base = Job.parse({ ...draft, reproducibility })
          const job = Job.parse({ ...base, provenance: provenance(base) })
          await change(scope.root, (jobs) => {
            jobs.push(job)
          })
          slots.delete(key)
          active.set(key, {
            detached: false,
            authority,
            root: scope.root,
            workspace: scope.workspace,
            id: job.id,
            modal: context,
            provider,
          })
          void executeModal(job, prepared.files, scope, context, provider)
            .catch((error) =>
              error instanceof ModalAdapter.HarvestError
                ? deferModal(job, scope, error)
                : failModal(job, scope, context, error, provider),
            )
            .finally(() => active.delete(key))
          return job
        })
        .finally(() => slots.delete(key))
    }
    const reproducibility = host ? undefined : await reproduce(draft, authority)
    const planned = await launch(draft, host, scope, authority).catch(async (error) => {
      if (!host) await fs.rm(exitOf(scope.root, id), { force: true })
      throw error
    })
    const base = Job.parse({ ...draft, sandbox: planned.sandbox, reproducibility })
    const job = Job.parse({ ...base, provenance: provenance(base) })
    await change(scope.root, (jobs) => {
      jobs.push(job)
    }).catch(async (error) => {
      if (!host) await fs.rm(exitOf(scope.root, id), { force: true }).catch(() => undefined)
      throw error
    })
    const key = keyOf(scope.root, job.id)
    active.set(key, {
      detached: false,
      authority,
      root: scope.root,
      workspace: scope.workspace,
      id: job.id,
      host,
    })
    void execute(job, host, scope, authority, planned)
      .catch(async (error) => {
        await fs.mkdir(logsOf(scope.root), { recursive: true })
        await fs
          .appendFile(
            path.join(logsOf(scope.root), `${job.id}.log`),
            `${error instanceof Error ? error.message : String(error)}\n`,
          )
          .catch(() => {})
        await change(scope.root, (jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id)
          if (index < 0 || terminal.has(jobs[index]!.status)) return
          const message = error instanceof Error ? error.message : String(error)
          const draft = move(
            jobs[index]!,
            { type: "finish", outcome: "failed", message },
            {
              completed_at: new Date().toISOString(),
              exit_code: null,
              error: message,
            },
          )
          const closed = move(draft, { type: "close" })
          jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
        }).catch(() => {})
      })
      .finally(() => active.delete(key))
    return job
  }

  export async function list(options: Options = {}): Promise<Job[]> {
    const scope = await scoped(options)
    await sync(scope, options)
    return (await read(scope.root)).toSorted(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id),
    )
  }

  export async function get(id: string, options: Options = {}): Promise<Job | undefined> {
    const scope = await scoped(options)
    return (await read(scope.root)).find((job) => job.id === id)
  }

  export async function log(id: string, options: Options & { bytes?: number } = {}): Promise<string> {
    const scope = await scoped(options)
    const job = await get(id, options)
    if (!job) throw new Error(`Compute job ${id} was not found`)
    const text = await Bun.file(path.join(logsOf(scope.root), `${job.id}.log`))
      .text()
      .catch(() => "")
    return text.slice(-Math.max(1, options.bytes ?? 256_000))
  }

  export async function events(id: string, options: Options & { bytes?: number } = {}): Promise<string> {
    const scope = await scoped(options)
    const job = await get(id, options)
    if (!job) throw new Error(`Compute job ${id} was not found`)
    const text = await Bun.file(eventsOf(scope.root, job.id))
      .text()
      .catch(() => "")
    return text.slice(-Math.max(1, options.bytes ?? 256_000))
  }

  export async function cancel(id: string, options: Options = {}): Promise<Job> {
    const scope = await scoped(options)
    const runtime = active.get(keyOf(scope.root, id))
    const current = (await read(scope.root).catch((error) => preserve(scope.root, error))).find((job) => job.id === id)
    if (!current) throw new Error(`Compute job ${id} was not found`)
    const needs =
      current.target.kind === "modal" && (!terminal.has(current.status) || current.lifecycle?.resource === "unknown")
    const context =
      runtime?.modal ??
      (needs ? await modalContext(options, "Enable Modal before cancelling this recovered job") : undefined)
    const result = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`Compute job ${id} was not found`)
      if (terminal.has(jobs[index]!.status)) {
        const job = jobs[index]!
        const cleanup = job.target.kind === "modal" && job.lifecycle?.resource === "unknown" && !!context
        return { job, changed: false, cleanup }
      }
      if (jobs[index]!.target.kind === "modal" && !context) {
        throw new Error("Enable Modal before cancelling this recovered job")
      }
      const draft = move(
        jobs[index]!,
        { type: "cancel" },
        {
          completed_at: new Date().toISOString(),
          exit_code: null,
        },
      )
      const cancelled = Job.parse({ ...draft, provenance: provenance(draft) })
      jobs[index] = cancelled
      return { job: cancelled, changed: true, cleanup: false }
    })
    const job = result.job
    if (!result.changed && !result.cleanup) return job
    if (job.target.kind === "modal") {
      await event(scope.root, job.id, result.cleanup ? "Retrying Modal cleanup" : "Cancellation requested")
    }
    const proc = runtime?.process
    const modalClosed =
      job.target.kind === "modal"
        ? context
          ? await (options.provider ?? runtime?.provider ?? ModalAdapter)
              .release(context, modalSpec(job, [], scope), job.remote_id)
              .then(
                () => true,
                () => false,
              )
          : false
        : true
    if (job.target.kind === "modal" && job.remote_id && modalClosed) {
      await event(scope.root, job.id, `Closed Modal sandbox ${job.remote_id}`)
    }
    if (job.target.kind === "modal" && !modalClosed) {
      await event(scope.root, job.id, "Modal did not confirm cancellation; the remote resource may still be billing")
    }
    if (proc) {
      await Shell.killTree(proc, {
        detached: runtime.detached,
        exited: () => proc.exitCode !== null,
      })
    } else if (job.pid) {
      try {
        if (process.platform === "win32") process.kill(job.pid, "SIGTERM")
        else process.kill(-job.pid, "SIGTERM")
      } catch {}
    }
    if (runtime) active.delete(keyOf(scope.root, id))
    const hostId = job.target.kind === "ssh" ? job.target.host_id : undefined
    const host = hostId ? options.hosts?.find((item) => item.id === hostId) : undefined
    if (host && host.scheduler !== "none") {
      const action =
        host.scheduler === "slurm"
          ? `scancel --name ${quote(`os-${job.id}`)}`
          : `qselect -N ${quote(name(`os-${job.id}`))} | xargs -r qdel`
      const spec = command(
        { id: job.id, name: job.name, command: action, cwd: host.workdir },
        { ...host, scheduler: "none" },
      )
      const planned = job.authority
        ? Sandbox.wrapArgv({
            file: spec.argv[0]!,
            args: spec.argv.slice(1),
            workspace: job.authority.writable,
            unreadable: OpenScience.kernelSensitivePaths(),
            options: job.authority.sandbox,
          })
        : { file: spec.argv[0]!, args: spec.argv.slice(1) }
      const proc = spawn(planned.file, planned.args, {
        cwd: job.authority?.workspace,
        env: await OpenScience.subprocessEnv(process.env),
        windowsHide: true,
        stdio: "ignore",
      })
      await new Promise<void>((resolve) => {
        proc.once("error", () => resolve())
        proc.once("exit", () => resolve())
      })
    }
    return change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`Compute job ${id} was not found`)
      const current = jobs[index]!
      const abandoned = modalClosed && current.lifecycle?.recoverable ? move(current, { type: "abandon" }) : current
      const closed = modalClosed ? move(abandoned, { type: "close" }) : move(abandoned, { type: "lose" })
      const warning =
        job.target.kind === "modal" && !modalClosed
          ? "Cancellation was recorded, but Modal did not confirm that the sandbox and durable volume stopped. It may still be billing; retry cancellation or check Modal."
          : undefined
      const legacy =
        !current.cleanup_error &&
        (current.error?.startsWith("Cancellation was recorded") || current.error?.startsWith("Modal cleanup failed"))
      const updated = Job.parse({
        ...closed,
        error: legacy ? undefined : current.error,
        cleanup_error: warning,
        provenance: provenance(closed),
      })
      jobs[index] = updated
      return jobs[index]!
    })
  }

  async function cancelActive(match: (runtime: Runtime) => boolean): Promise<number> {
    const runtimes = [...active.values()].filter(match)
    await Promise.allSettled(
      runtimes.map((runtime) =>
        cancel(runtime.id, {
          root: runtime.root,
          workspace: runtime.workspace,
          hosts: runtime.host ? [runtime.host] : undefined,
          credentials: runtime.modal,
          provider: runtime.provider,
        }),
      ),
    )
    return runtimes.length
  }

  export function cancelSession(sessionID: string): Promise<number> {
    return cancelActive((runtime) => runtime.authority.sessionID === sessionID)
  }

  export function cancelProject(projectID: string): Promise<number> {
    return cancelActive((runtime) => runtime.authority.projectID === projectID)
  }

  export async function clear(options: Options = {}): Promise<number> {
    const scope = await scoped(options)
    const removed = await change(scope.root, (jobs) => {
      const clearable = (job: Job) =>
        terminal.has(job.status) &&
        !(
          job.target.kind === "modal" &&
          job.lifecycle &&
          (job.lifecycle.recoverable || job.lifecycle.resource !== "closed")
        )
      const done = jobs.filter(clearable).map((job) => job.id)
      const keep = jobs.filter((job) => !clearable(job))
      jobs.splice(0, jobs.length, ...keep)
      return done
    })
    await Promise.all(
      removed.flatMap((id) => [
        fs.rm(path.join(logsOf(scope.root), `${id}.log`), { force: true }),
        fs.rm(eventsOf(scope.root, id), { force: true }),
        fs.rm(exitOf(scope.root, id), { force: true }),
      ]),
    )
    return removed.length
  }

  export async function wait(id: string, options: Options & { timeout?: number } = {}): Promise<Job> {
    const started = Date.now()
    const timeout = options.timeout ?? 30_000
    const scope = await scoped(options)
    for (;;) {
      const job = (await list({ ...options, root: scope.root, workspace: scope.workspace })).find(
        (item) => item.id === id,
      )
      if (!job) throw new Error(`Compute job ${id} was not found`)
      const lifecycle = job.lifecycle ?? ComputeLifecycle.from(job.status)
      const pending =
        lifecycle.delivery === "pending" || lifecycle.resource === "starting" || lifecycle.resource === "active"
      if (terminal.has(job.status) && !pending && !active.has(keyOf(scope.root, id))) return job
      if (Date.now() - started >= timeout) throw new Error(`Timed out waiting for compute job ${id}`)
      await Bun.sleep(25)
    }
  }
}
