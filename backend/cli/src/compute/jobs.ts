import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import z from "zod"
import { Global } from "../global"
import { OpenScience } from "../openscience"
import { Shell } from "../shell/shell"
import { Instance } from "../project/instance"
import { Sandbox } from "../sandbox/sandbox"
import { Filesystem } from "../util/filesystem"
import { FileLease } from "../util/file-lease"
import { ProvenanceEnvelope } from "../science/provenance/envelope"
import { ExecutionAuthority } from "../project/execution"
import { ComputeLifecycle } from "./lifecycle"
import { ModalAdapter } from "./modal/adapter"
import { ModalPlan } from "./modal/plan"
import { ArtifactStore } from "../artifact/store"
import { CredentialProcessLedger } from "../credentials/process-ledger"
import { AuthoritySignal } from "../project/authority-signal"
import { SshAdapter } from "./ssh/adapter"
import { SshPlan } from "./ssh/plan"
import { WindowsJobLauncher } from "../process/windows-job-launcher"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "../process/darwin-responsibility-launcher"
import { DataRootBarrier } from "../global/data-root-barrier"
import { SecretFile } from "../util/secret-file"
import { ProcessOutput } from "../util/process-output"
import { ComputeSecrets } from "./secrets"

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
    label: z.string().trim().min(1).max(120),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^\S+$/, "SSH hosts cannot contain whitespace")
      .refine((value) => !value.startsWith("-"), "SSH hosts cannot begin with a hyphen"),
    user: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^\S+$/, "SSH users cannot contain whitespace")
      .refine((value) => !value.includes("@"), "SSH users cannot contain @")
      .refine((value) => !value.startsWith("-"), "SSH users cannot begin with a hyphen")
      .optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    scheduler: Scheduler.default("none"),
    workdir: z.string().optional(),
    notes: z
      .string()
      .trim()
      .max(4_000)
      .optional()
      .describe("Operator notes about modules, partitions, scratch paths, and installation rules."),
    fingerprint: z.string().startsWith("SHA256:").optional(),
    host_key: z
      .string()
      .trim()
      .min(1)
      .max(16_000)
      .refine((value) => !value.includes("\n"), "SSH host keys must contain one line")
      .optional(),
    concurrency: z.number().int().min(1).max(100).default(4),
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
    fingerprint: z.string().startsWith("SHA256:").optional(),
    host_key: z.string().optional(),
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

  export const SecretRef = ComputeSecrets.Ref
  export type SecretRef = ComputeSecrets.Ref

  export const Artifact = z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    modified_at: z.string(),
    artifact_id: z.string().optional(),
    version_id: z.string().optional(),
    version: z.number().int().positive().optional(),
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

  export const LocalPlan = z.object({
    digest: z.string().length(64),
    provider: z.literal("local"),
    name: z.string(),
    purpose: z.string(),
    command: z.string(),
    cwd: z.string(),
    resources: Resources.optional(),
    artifact_patterns: z.string().array(),
    checkpoint: z.string().optional(),
    warning: z.string(),
  })
  export type LocalPlan = z.infer<typeof LocalPlan>

  export const Input = z.object({
    name: z.string().trim().min(1).max(120),
    purpose: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Why this detached job is needed and what result it should produce."),
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
    secret_refs: SecretRef.array().max(8).optional(),
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
    purpose: z.string().optional(),
    command: z.string(),
    cwd: z.string().optional(),
    target: Target,
    target_label: z.string(),
    scheduler: Scheduler,
    status: Status,
    created_at: z.string(),
    started_at: z.string().optional(),
    last_activity_at: z.string().optional(),
    completed_at: z.string().optional(),
    exit_code: z.number().int().nullable().optional(),
    pid: z.number().int().positive().optional(),
    process_identity: z.string().length(64).optional(),
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
        secret_refs: SecretRef.array().default([]),
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
    ssh: z
      .object({
        protocol: z.literal(1),
        host: Host,
        root: z.string(),
        cwd: z.string(),
        fingerprint: z.string().startsWith("SHA256:"),
        uploads: SshPlan.Upload.array(),
        upload_bytes: z.number().int().nonnegative(),
        approval: z.string().length(64),
      })
      .optional(),
  })
  export type Job = z.infer<typeof Job>

  export const Plan = z.union([LocalPlan, ModalPlan.Schema, SshPlan.Schema])
  export type Plan = z.infer<typeof Plan>

  export type ModalProvider = Pick<typeof ModalAdapter, "run" | "recover" | "find" | "close" | "release" | "volume">

  export type Options = {
    data?: string
    root?: string
    /** Canonical project directory used only to select the shared durable
     * inventory when execution itself runs in an isolated session workspace. */
    projectDirectory?: string
    workspace?: string
    hosts?: Host[]
    modal?: ModalAdapter.Config
    credentials?: ModalAdapter.Context
    resolveCredentials?: () => Promise<ModalAdapter.Context>
    resolveSecrets?: (refs: SecretRef[]) => Promise<Record<string, string>>
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
    dataRoot: DataRootBarrier.Operation
    dataRootOwner?: DataRootBarrier.Owner
  }

  type Scope = {
    root: string
    workspace: string
    key: string
  }

  type Launch = {
    argv: string[]
    sandbox?: Job["sandbox"]
    temporary?: string
  }

  const active = new Map<string, Runtime>()
  const claims = new Set<string>()
  const locks = new Map<string, Promise<void>>()
  const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])
  const recoveryLimit = 3
  const recoveryDelay = 15_000

  async function activate(key: string, runtime: Omit<Runtime, "dataRoot">): Promise<void> {
    const current = active.get(key)
    if (current) {
      const changedOwner =
        !!runtime.dataRootOwner &&
        (runtime.dataRootOwner.pid !== current.dataRootOwner?.pid ||
          runtime.dataRootOwner.identity !== current.dataRootOwner?.identity)
      if (changedOwner) await current.dataRoot.reassign(runtime.dataRootOwner!)
      active.set(key, { ...runtime, dataRoot: current.dataRoot })
      return
    }
    const dataRoot = await DataRootBarrier.enter(logsOf(runtime.root), 120_000, runtime.dataRootOwner)
    const collision = active.get(key)
    if (collision) {
      await dataRoot[Symbol.asyncDispose]()
      const changedOwner =
        !!runtime.dataRootOwner &&
        (runtime.dataRootOwner.pid !== collision.dataRootOwner?.pid ||
          runtime.dataRootOwner.identity !== collision.dataRootOwner?.identity)
      if (changedOwner) await collision.dataRoot.reassign(runtime.dataRootOwner!)
      active.set(key, { ...runtime, dataRoot: collision.dataRoot })
      return
    }
    active.set(key, { ...runtime, dataRoot })
  }

  async function deactivate(key: string): Promise<void> {
    const runtime = active.get(key)
    if (!runtime || !active.delete(key)) return
    await runtime.dataRoot[Symbol.asyncDispose]()
  }

  async function currentAuthority(authority: ExecutionAuthority.Decision) {
    const current = await Instance.provide({
      directory: authority.directory ?? authority.workspace,
      fn: () =>
        ExecutionAuthority.require({
          projectID: authority.projectID,
          sessionID: authority.sessionID,
          capability: authority.capability,
        }),
    })
    if (current.generation !== authority.generation) {
      throw new Error("Execution authority changed while compute was being prepared; retry the job")
    }
    return current
  }

  async function bindScopeWorkspace(scope: Scope, authority: ExecutionAuthority.Decision): Promise<Scope> {
    const workspace = await Filesystem.canonical(authority.workspace)
    if (!workspace) throw new Error(`Compute session workspace does not exist: ${authority.workspace}`)
    const directory = authority.directory ? await Filesystem.canonical(authority.directory) : undefined
    if (scope.workspace !== workspace && scope.workspace !== directory) {
      throw new Error("Compute project does not match the session workspace")
    }
    if (scope.workspace === workspace) return scope
    return { ...scope, workspace, key: scopeKey(workspace) }
  }

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
    options.root ??
    path.join(options.data ?? Global.Path.data, "compute", "projects", scopeKey(options.projectDirectory ?? workspace))
  const metaOf = (root: string) => path.join(root, "jobs.json")
  const modalAdmissionOf = (root: string) => path.join(root, "modal-admission.lock")
  const modalLeaseOf = (root: string, id: string) => path.join(root, "modal-leases", `${id}.lock`)
  const modalOperationOf = (root: string, id: string) => path.join(root, "modal-operations", `${id}.lock`)
  const localLeaseOf = (root: string, id: string) => path.join(root, "local-leases", `${id}.lock`)
  const sshAdmissionOf = (root: string, host: string) =>
    path.join(root, "ssh-admission", `${crypto.createHash("sha256").update(host).digest("hex")}.lock`)
  const sshLeaseOf = (root: string, id: string) => path.join(root, "ssh-leases", `${id}.lock`)
  const sshOperationOf = (root: string, id: string) => path.join(root, "ssh-operations", `${id}.lock`)

  function reservesModal(job: Job) {
    if (job.target.kind !== "modal") return false
    const lifecycle = job.lifecycle ?? ComputeLifecycle.from(job.status)
    return !terminal.has(job.status) || lifecycle.resource !== "closed"
  }

  function reservesSsh(job: Job, host: string) {
    if (job.target.kind !== "ssh" || job.target.host_id !== host) return false
    const lifecycle = job.lifecycle ?? ComputeLifecycle.from(job.status)
    return !terminal.has(job.status) || lifecycle.recoverable || lifecycle.resource !== "closed"
  }

  async function releaseLease(lease: AsyncDisposable) {
    await lease[Symbol.asyncDispose]()
  }

  function leaseBusy(error: unknown) {
    return error instanceof Error && error.message.startsWith("Timed out waiting for another OpenScience process")
  }
  const logsOf = (root: string) => path.join(root, "jobs")
  const eventsOf = (root: string, id: string) => path.join(logsOf(root), `${id}.events.log`)
  const exitOf = (root: string, id: string) => path.join(logsOf(root), `${id}.exit`)
  const keyOf = (root: string, id: string) => `${root}\0${id}`
  const credentialProcessID = (root: string, id: string) =>
    `compute-${crypto.createHash("sha256").update(`${root}\0${id}`).digest("hex")}`

  async function completeCredentialProcess(id: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await CredentialProcessLedger.complete(id)) return
      await Bun.sleep(20)
    }
    throw new Error(`Credential-bearing compute process ${id} did not become safely reapable`)
  }

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
    await using operation = await DataRootBarrier.enter(filepath)
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

  async function observe(root: string, job: Job): Promise<Job> {
    const stat = await fs.stat(path.join(logsOf(root), `${job.id}.log`)).catch(() => undefined)
    const activity = stat?.mtime.toISOString() ?? job.completed_at ?? job.started_at ?? job.created_at
    return Job.parse({ ...job, last_activity_at: activity })
  }

  async function event(root: string, id: string, value: string) {
    await using operation = await DataRootBarrier.enter(eventsOf(root, id))
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
    await using operation = await DataRootBarrier.enter(filepath)
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
        await using lease = await FileLease.acquire(`${metaOf(root)}.lock`)
        return await lease.during(async () => {
          const jobs = await read(root).catch((error) => preserve(root, error))
          const result = await edit(jobs)
          await write(root, jobs)
          return result
        })
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

  async function processIdentity(pid: number): Promise<string | undefined> {
    return CredentialProcessLedger.identity(pid)
  }

  async function owns(pid: number, identity: string | undefined) {
    return CredentialProcessLedger.owns(pid, identity)
  }

  async function localExit(root: string, id: string) {
    const marker = await Bun.file(exitOf(root, id))
      .text()
      .catch(() => undefined)
    return marker?.trim().match(/^-?\d+$/) ? Number(marker.trim()) : undefined
  }

  async function recoverLocal(job: Job, scope: Scope): Promise<void> {
    if (!job.pid) return
    for (;;) {
      const exit = await localExit(scope.root, job.id)
      if (exit !== undefined) {
        const captured = await capture(job)
          .then((value) => ({ ...value, capture_error: undefined }))
          .catch((error) => ({ capture_error: error instanceof Error ? error.message : String(error) }))
        await change(scope.root, (jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id)
          if (index < 0 || terminal.has(jobs[index]!.status)) return
          const finished = move(
            jobs[index]!,
            { type: "finish", outcome: exit === 0 ? "succeeded" : "failed" },
            {
              completed_at: new Date().toISOString(),
              exit_code: exit,
              pid: undefined,
              process_identity: undefined,
              ...captured,
            },
          )
          const closed = move(finished, { type: "close" })
          jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
        })
        return
      }
      if (await owns(job.pid, job.process_identity)) {
        await Bun.sleep(50)
        continue
      }
      const reported = await localExit(scope.root, job.id)
      if (reported !== undefined) continue
      await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0 || terminal.has(jobs[index]!.status)) return
        const interrupted = move(
          jobs[index]!,
          { type: "interrupt" },
          {
            completed_at: new Date().toISOString(),
            exit_code: null,
            pid: undefined,
            process_identity: undefined,
          },
        )
        const closed = move(interrupted, { type: "close" })
        jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
      })
      return
    }
  }

  const SSH_STDOUT_BYTES = 256 * 1024
  const SSH_STDERR_BYTES = 64 * 1024
  const SSH_DRAIN_TIMEOUT = 1_000

  function boundedChild(proc: ChildProcess, stdout = SSH_STDOUT_BYTES, stderr = SSH_STDERR_BYTES) {
    const output = { chunks: [] as Buffer[], size: 0 }
    const errors = { chunks: [] as Buffer[], size: 0 }
    const failed = Promise.withResolvers<Error>()
    const state = { error: undefined as Error | undefined }
    const fail = (error: Error) => {
      if (state.error) return
      state.error = error
      proc.stdout?.pause()
      proc.stderr?.pause()
      failed.resolve(error)
    }
    const watch = (stream: ChildProcess["stdout"], label: "stdout" | "stderr", limit: number) => {
      const done = Promise.withResolvers<void>()
      if (!stream) {
        done.resolve()
        return { done: done.promise, close: () => undefined, dispose: () => undefined }
      }
      const target = label === "stdout" ? output : errors
      const data = (value: Buffer) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        const remaining = limit - target.size
        const accepted = chunk.subarray(0, Math.max(0, remaining))
        if (accepted.byteLength) {
          target.chunks.push(accepted.slice())
          target.size += accepted.byteLength
        }
        if (accepted.byteLength === chunk.byteLength) return
        fail(new Error(`SSH operation ${label} exceeded ${limit} bytes`))
      }
      const finish = () => done.resolve()
      const error = (cause: Error) => fail(cause)
      stream.on("data", data)
      stream.once("end", finish)
      stream.once("close", finish)
      stream.once("error", error)
      return {
        done: done.promise,
        close: () => stream.destroy(),
        dispose: () => {
          stream.off("data", data)
          stream.off("end", finish)
          stream.off("close", finish)
          stream.off("error", error)
        },
      }
    }
    const out = watch(proc.stdout, "stdout", stdout)
    const err = watch(proc.stderr, "stderr", stderr)
    return {
      output,
      errors,
      failed: failed.promise,
      state,
      fail,
      finished: Promise.all([out.done, err.done]),
      close: () => {
        out.close()
        err.close()
      },
      dispose: () => {
        out.dispose()
        err.dispose()
      },
    }
  }

  async function sshRun(
    scope: Scope,
    job: Job,
    host: Host,
    authority: ExecutionAuthority.Decision,
    script: string,
    options: {
      stdin?: string
      stdout?: string
      timeout?: number
      authorize?: boolean
      signal?: AbortSignal
      /** Resolves the caller's launch handoff once this control process is
       * durably registered and its pre-exec ownership gate has opened. */
      ready?: () => void
      /** Persists a known launch failure before potentially slow process-tree
       * revocation. Cleanup still remains owned by this operation. */
      failed?: (error: Error) => Promise<void> | void
    } = {},
  ) {
    if (options.authorize !== false) await currentAuthority(authority)
    const known = await SshAdapter.known(host, scope.root)
    const spec = SshAdapter.argv(host, known, script)
    const input = options.stdin ? await fs.open(options.stdin, "r") : undefined
    const output = options.stdout ? await fs.open(options.stdout, "w", 0o600) : undefined
    const detached = process.platform !== "win32"
    const ledger = `${credentialProcessID(scope.root, job.id)}-${crypto.randomUUID()}`
    const cleanupGate = async (release?: string) => {
      if (!release) return
      await Promise.all([
        fs.rm(release, { force: true }).catch(() => undefined),
        fs.rm(`${release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, { force: true }).catch(() => undefined),
      ])
    }
    try {
      const launched = await AuthoritySignal.exclusive(() =>
        OpenScience.withSubprocessEnv(process.env, async (env) => {
          if (options.authorize !== false) await currentAuthority(authority)
          const transport = Object.fromEntries(
            [
              "PATH",
              "HOME",
              "USER",
              "LOGNAME",
              "SHELL",
              "LANG",
              "LC_ALL",
              "LC_CTYPE",
              "TMPDIR",
              "SSH_AUTH_SOCK",
              "SYSTEMROOT",
              "WINDIR",
              "COMSPEC",
              "PATHEXT",
              "USERPROFILE",
            ].flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
          )
          // This is OpenScience's fixed, host-key-pinned broker transport, not
          // project-authored code. Session sandboxes intentionally deny all
          // network access, so applying them here would make every approved
          // remote job impossible under the default policy. The exact child is
          // still bound to both the current authority and credential ledgers.
          const linuxIdentity = process.platform === "linux" ? await processIdentity(process.pid) : undefined
          if (process.platform === "linux" && !linuxIdentity) {
            throw new Error("Could not establish the compute server identity for durable SSH transport ownership")
          }
          const wrapped = WindowsJobLauncher.wrap({
            file: spec[0]!,
            args: spec.slice(1),
            linuxOwner: linuxIdentity ? { pid: process.pid, identity: linuxIdentity } : undefined,
          })
          let proc: ChildProcess
          try {
            proc = spawn(wrapped.file, wrapped.args, {
              cwd: authority.workspace,
              env: transport,
              detached,
              windowsHide: true,
              stdio: [input?.fd ?? "ignore", output?.fd ?? "pipe", "pipe"],
            })
            WindowsJobLauncher.bind(proc, wrapped.release)
          } catch (error) {
            await cleanupGate(wrapped.release)
            throw error
          }
          const streams = boundedChild(proc)
          // Output can exceed its bound before Linux finishes establishing
          // durable process ownership. Start failure publication at the
          // stream boundary itself so slow registration or reaping can never
          // leave the durable job queued after the transport has already
          // failed.
          const reported = streams.failed.then(async (error) => {
            const failure = await Promise.resolve(options.failed?.(error)).then(
              () => undefined,
              (cause) => cause,
            )
            return { error, failure }
          })
          const done = new Promise<{ code: number | null; error?: string }>((resolve) => {
            proc.once("error", (error) => resolve({ code: null, error: error.message }))
            proc.once("exit", (code) => resolve({ code }))
          })
          let identity: string | undefined
          try {
            identity = proc.pid ? await processIdentity(proc.pid) : undefined
            if (!proc.pid || !identity) {
              throw new Error("Could not establish durable ownership of the SSH control process")
            }
            // Deterministic regression hook for the pre-registration window.
            // The Linux launcher must remain at its owner gate throughout this
            // pause, so no connection reaches sshd before the injected failure.
            if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_SSH_TEST_REGISTRATION_FAILURE) {
              await Bun.sleep(1_500)
              throw new Error("Injected SSH control registration failure")
            }
            const registered = await CredentialProcessLedger.register({
              id: ledger,
              kind: "compute",
              pid: proc.pid,
              detached,
              identity,
              projectID: authority.projectID,
              sessionID: authority.sessionID,
              authorityGeneration: authority.generation,
              windowsRelease: wrapped.release,
            })
            if (!registered) throw new Error("SSH control process exited before durable ownership was established")
            // Windows and macOS release from inside durable registration after
            // kernel ownership exists. Linux's owner-watching launcher stays at
            // the pre-exec gate until the persisted process-group entry exists.
            if (process.platform === "linux" && wrapped.release) {
              await WindowsJobLauncher.release(wrapped.release, proc.pid)
            }
            options.ready?.()
          } catch (error) {
            const failures: unknown[] = []
            await CredentialProcessLedger.revoke({ id: ledger, kind: "compute" }).catch((failure) =>
              failures.push(failure),
            )
            const stillOwned = proc.pid && identity ? await owns(proc.pid, identity) : true
            if (stillOwned && proc.exitCode === null && proc.signalCode === null) {
              await Shell.killTree(proc, {
                detached,
                exited: () => proc.exitCode !== null || proc.signalCode !== null,
              }).catch((failure) => failures.push(failure))
            }
            streams.close()
            await Promise.race([streams.finished, Bun.sleep(SSH_DRAIN_TIMEOUT)])
            streams.dispose()
            await cleanupGate(wrapped.release)
            if (failures.length) {
              throw new AggregateError([error, ...failures], "SSH control launch ownership cleanup failed")
            }
            throw error
          }
          return { proc, streams, reported, done, release: wrapped.release }
        }),
      )
      const { proc, streams, reported, done, release } = launched
      const abort = () => {
        const reason = options.signal?.reason
        streams.fail(reason instanceof Error ? reason : new Error("SSH operation was aborted"))
      }
      const timer = setTimeout(() => streams.fail(new Error("SSH operation timed out")), options.timeout ?? 30_000)
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
      try {
        const outcome = await Promise.race([
          done.then((result) => ({ result, error: undefined, publication: undefined })),
          reported.then((result) => ({ result: undefined, error: result.error, publication: result.failure })),
        ])
        if (outcome.error) {
          const failures: unknown[] = outcome.publication ? [outcome.publication] : []
          await CredentialProcessLedger.revoke({ id: ledger, kind: "compute" }).catch((error) => failures.push(error))
          await Promise.race([done, Bun.sleep(SSH_DRAIN_TIMEOUT)])
          streams.close()
          await Promise.race([streams.finished, Bun.sleep(SSH_DRAIN_TIMEOUT)])
          if (failures.length) {
            throw new AggregateError(
              [outcome.error, ...failures],
              "SSH operation failed and its owned process group could not be reaped",
            )
          }
          if (options.signal?.aborted) options.signal.throwIfAborted()
          throw outcome.error
        }
        await completeCredentialProcess(ledger).catch(async (error) => {
          const failures: unknown[] = []
          await CredentialProcessLedger.revoke({ id: ledger, kind: "compute" }).catch((failure) =>
            failures.push(failure),
          )
          streams.close()
          await Promise.race([streams.finished, Bun.sleep(SSH_DRAIN_TIMEOUT)])
          if (failures.length) {
            throw new AggregateError(
              [error, ...failures],
              "SSH control process did not complete and its owned process group could not be reaped",
            )
          }
          throw error
        })
        const drained = await Promise.race([
          streams.finished.then(() => true),
          streams.failed.then(() => false),
          Bun.sleep(SSH_DRAIN_TIMEOUT).then(() => false),
        ])
        if (!drained || streams.state.error) {
          streams.close()
          const publication = streams.state.error ? await reported : undefined
          if (publication?.failure) {
            throw new AggregateError(
              [streams.state.error, publication.failure],
              "SSH operation output failed and its durable failure could not be published",
            )
          }
          throw streams.state.error ?? new Error("SSH operation output streams did not close after process exit")
        }
        const result = outcome.result
        const stderr = OpenScience.redactSecrets(
          Buffer.concat(streams.errors.chunks, streams.errors.size).toString("utf8").trim(),
        )
        if (result.code !== 0) throw new Error(result.error || stderr || `SSH operation exited with ${result.code}`)
        return {
          stdout: Buffer.concat(streams.output.chunks, streams.output.size),
          stderr,
        }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        streams.dispose()
        await cleanupGate(release)
      }
    } finally {
      await input?.close().catch(() => undefined)
      await output?.close().catch(() => undefined)
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
              (job.target.kind === "local" ||
                lifecycle.recoverable ||
                (lifecycle.delivery !== "pending" && lifecycle.resource === "closed"))
            if (settled || active.has(key) || claims.has(key)) return
            if (job.status === "queued" && Date.now() - Date.parse(job.created_at) < 5_000) return
            if (job.target.kind === "modal") {
              claims.add(key)
              let lease: FileLease.Lease | undefined
              let handedOff = false
              try {
                lease = await FileLease.acquire(modalLeaseOf(root, job.id), 25).catch((error) => {
                  if (leaseBusy(error)) return undefined
                  throw error
                })
                if (!lease) return
                const setup = Promise.withResolvers<void>()
                const ready = Promise.withResolvers<void>()
                let cleanup = false
                let activated = false
                const managed = lease
                  .during(async () => {
                    try {
                      const prior = await recovery(root, job)
                      if (prior.retry > Date.now()) return
                      const credentials =
                        options.credentials ?? (await options.resolveCredentials?.().catch(() => undefined))
                      if (!credentials || !job.authority) return
                      const provider = options.provider ?? ModalAdapter
                      const authorized = await currentAuthority(job.authority).then(
                        () => true,
                        async () => {
                          await cancel(job.id, {
                            ...options,
                            root,
                            workspace: scope.workspace,
                            credentials,
                            provider,
                          }).catch(() => undefined)
                          return false
                        },
                      )
                      if (!authorized) return
                      const current = await get(job.id, { root, workspace: scope.workspace })
                      if (!current || current.status === "cancelled") return
                      await activate(key, {
                        detached: false,
                        authority: job.authority,
                        root,
                        workspace: scope.workspace,
                        id: job.id,
                        modal: credentials,
                        provider: options.provider,
                      })
                      activated = true
                      cleanup = terminal.has(job.status) && lifecycle.delivery !== "pending"
                      setup.resolve()
                      return await (
                        cleanup
                          ? cleanupModal(job, scope, credentials, provider)
                          : recoverModal(job, scope, credentials, provider, ready.resolve)
                      ).catch(async (error) => {
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
                        const message = OpenScience.redactSecrets(
                          error instanceof Error ? error.message : String(error),
                        )
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
                    } catch (error) {
                      setup.reject(error)
                      throw error
                    } finally {
                      setup.resolve()
                      if (activated) await deactivate(key)
                    }
                  })
                  .finally(() => releaseLease(lease!))
                handedOff = true
                void managed.catch(() => undefined)
                await setup.promise
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
                if (lease && !handedOff) await releaseLease(lease)
                claims.delete(key)
              }
              return
            }
            if (job.target.kind === "ssh") {
              claims.add(key)
              let lease: FileLease.Lease | undefined
              let handedOff = false
              try {
                lease = await FileLease.acquire(sshLeaseOf(root, job.id), 25).catch((error) => {
                  if (leaseBusy(error)) return undefined
                  throw error
                })
                if (!lease) return
                const setup = Promise.withResolvers<void>()
                let activated = false
                const managed = lease
                  .during(async () => {
                    try {
                      const prior = await recovery(root, job)
                      if (prior.retry > Date.now()) return
                      await activate(key, {
                        detached: false,
                        authority: job.authority!,
                        root,
                        workspace: scope.workspace,
                        id: job.id,
                        host: job.ssh?.host,
                      })
                      activated = true
                      setup.resolve()
                      return await recoverSsh(job, scope)
                        .then(async () => {
                          if (!job.recovery_attempts && !job.recovery_retry_at) return
                          await change(root, (jobs) => {
                            const stored = jobs.find((item) => item.id === job.id)
                            if (!stored) return
                            stored.recovery_attempts = undefined
                            stored.recovery_retry_at = undefined
                          })
                        })
                        .catch(async (error) => {
                          const attempt = prior.attempt + 1
                          const delay = Math.min(5 * 60_000, recoveryDelay * 2 ** Math.min(attempt - 1, 5))
                          await change(root, (jobs) => {
                            const stored = jobs.find((item) => item.id === job.id)
                            if (!stored) return
                            stored.recovery_attempts = attempt
                            stored.recovery_retry_at = new Date(Date.now() + delay).toISOString()
                          })
                          await event(
                            root,
                            job.id,
                            `SSH recovery attempt ${attempt} deferred for ${delay / 1000} seconds: ${error instanceof Error ? error.message : String(error)}`,
                          )
                        })
                    } catch (error) {
                      setup.reject(error)
                      throw error
                    } finally {
                      setup.resolve()
                      if (activated) await deactivate(key)
                    }
                  })
                  .finally(() => releaseLease(lease!))
                handedOff = true
                void managed.catch(() => undefined)
                await setup.promise
              } finally {
                if (lease && !handedOff) await releaseLease(lease)
                claims.delete(key)
              }
              return
            }
            if (job.target.kind === "local") {
              claims.add(key)
              let lease: FileLease.Lease | undefined
              let handedOff = false
              try {
                lease = await FileLease.acquire(localLeaseOf(root, job.id), 25).catch((error) => {
                  if (leaseBusy(error)) return undefined
                  throw error
                })
                if (!lease) return
                const setup = Promise.withResolvers<void>()
                let activated = false
                const managed = lease
                  .during(async () => {
                    try {
                      const current = await get(job.id, { root, workspace: scope.workspace })
                      if (!current || terminal.has(current.status)) return
                      const exit = await localExit(root, current.id)
                      if (exit !== undefined) {
                        await change(root, (jobs) => {
                          const index = jobs.findIndex((item) => item.id === current.id)
                          if (index < 0 || terminal.has(jobs[index]!.status)) return
                          const finished = move(
                            jobs[index]!,
                            { type: "finish", outcome: exit === 0 ? "succeeded" : "failed" },
                            {
                              completed_at: new Date().toISOString(),
                              exit_code: exit,
                              pid: undefined,
                              process_identity: undefined,
                            },
                          )
                          const closed = move(finished, { type: "close" })
                          jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
                        })
                        return
                      }
                      if (!current.pid || !(await owns(current.pid, current.process_identity))) {
                        // A normal wrapper writes its exit marker before the owned
                        // supervisor disappears. Re-read after the identity check,
                        // then classify a genuinely markerless death while still
                        // holding the one durable local lifecycle lease.
                        const reported = await localExit(root, current.id)
                        await change(root, (jobs) => {
                          const index = jobs.findIndex((item) => item.id === current.id)
                          if (index < 0 || terminal.has(jobs[index]!.status)) return
                          const draft =
                            reported === undefined
                              ? move(
                                  jobs[index]!,
                                  { type: "interrupt" },
                                  {
                                    completed_at: new Date().toISOString(),
                                    exit_code: null,
                                    pid: undefined,
                                    process_identity: undefined,
                                    error: "The job process ended before it could report a result.",
                                  },
                                )
                              : move(
                                  jobs[index]!,
                                  { type: "finish", outcome: reported === 0 ? "succeeded" : "failed" },
                                  {
                                    completed_at: new Date().toISOString(),
                                    exit_code: reported,
                                    pid: undefined,
                                    process_identity: undefined,
                                  },
                                )
                          const closed = reported === undefined ? draft : move(draft, { type: "close" })
                          jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
                        })
                        return
                      }
                      if (!current.authority) return
                      await activate(key, {
                        dataRootOwner:
                          process.platform === "win32"
                            ? undefined
                            : { pid: current.pid, identity: current.process_identity! },
                        detached: process.platform !== "win32",
                        authority: current.authority,
                        root,
                        workspace: scope.workspace,
                        id: current.id,
                      })
                      activated = true
                      setup.resolve()
                      await recoverLocal(current, scope)
                    } catch (error) {
                      setup.reject(error)
                      throw error
                    } finally {
                      setup.resolve()
                      if (activated) await deactivate(key)
                    }
                  })
                  .finally(() => releaseLease(lease!))
                handedOff = true
                void managed.catch(() => undefined)
                await setup.promise
              } finally {
                claims.delete(key)
                if (lease && !handedOff) await releaseLease(lease)
              }
              return
            }
            return
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
        readable: authority.readable,
        unreadable: OpenScience.kernelSensitivePaths(),
        options: authority.sandbox,
      })
      return {
        argv: [planned.file, ...planned.args],
        temporary: planned.temporary,
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
      readable: authority.readable,
      extraWritable: [exitOf(scope.root, job.id)],
      unreadable: OpenScience.kernelSensitivePaths(),
      options: authority.sandbox,
    })
    return {
      argv: [planned.file, ...planned.args],
      temporary: planned.temporary,
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
    partial = false,
  ): Promise<string | undefined> {
    await currentAuthority(authority)
    const planned = Sandbox.wrapArgv({
      file: argv[0]!,
      args: argv.slice(1),
      workspace: authority.writable,
      readable: authority.readable,
      unreadable: OpenScience.kernelSensitivePaths(),
      options: authority.sandbox,
    })
    try {
      const proc = Bun.spawn([planned.file, ...planned.args], {
        cwd,
        env: OpenScience.kernelEnv(process.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
      const result = await ProcessOutput.collect(proc, { maxBytes: 64 * 1024, timeoutMs: 10_000 })
      if (result.timedOut || (!partial && result.truncated) || (result.code !== 0 && !result.truncated)) return
      return result.bytes.toString().trim() || undefined
    } finally {
      Sandbox.cleanup(planned)
    }
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
      purpose: input.purpose ?? input.name,
      command: input.command,
      cwd,
      workspaceCwd: input.cwd,
      image: input.image ?? context.image,
      packages: input.packages ?? [],
      secretRefs: input.secret_refs ?? [],
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

  function modalSpec(
    job: Job,
    files: ModalAdapter.File[],
    scope: Scope,
    secrets?: Record<string, string>,
  ): ModalAdapter.Spec {
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
      secrets,
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
      output(["git", "-c", "core.fsmonitor=false", "status", "--porcelain"], cwd, authority, true),
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
          artifactID: artifact.artifact_id,
          path: artifact.path,
          sha256: artifact.sha256,
          size: artifact.size,
          versionID: artifact.version_id,
          version: artifact.version,
          createdAt: artifact.modified_at,
          versionReason: artifact.version_id ? undefined : "not_versioned",
        }),
      ),
      ...(job.checkpoint
        ? [
            ProvenanceEnvelope.output({
              kind: "checkpoint",
              label: job.checkpoint.path,
              artifactID: job.checkpoint.artifact_id,
              path: job.checkpoint.path,
              sha256: job.checkpoint.sha256,
              size: job.checkpoint.size,
              versionID: job.checkpoint.version_id,
              version: job.checkpoint.version,
              createdAt: job.checkpoint.modified_at,
              versionReason: job.checkpoint.version_id ? undefined : "not_versioned",
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

  async function versionCapture(
    job: Job,
    value: Pick<Job, "artifacts" | "checkpoint">,
  ): Promise<Pick<Job, "artifacts" | "checkpoint">> {
    const sessionID = job.session_id
    const projectID = job.authority?.projectID
    if (!sessionID || !projectID || !job.cwd) return value

    const unique = new Map<string, Artifact>()
    for (const item of [...(value.artifacts ?? []), ...(value.checkpoint ? [value.checkpoint] : [])]) {
      unique.set(item.path, item)
    }
    const saved = new Map<string, Artifact>()
    await Promise.all(
      [...unique.values()].map(async (item) => {
        const source = path.resolve(job.cwd!, item.path)
        const version = await ArtifactStore.save({
          projectID,
          sessionID,
          sourcePath: item.path,
          filename: path.basename(item.path),
          kind: item.path === value.checkpoint?.path ? "compute-checkpoint" : "compute-output",
          content: Bun.file(source),
          captureQuality: "exact",
          title: path.basename(item.path),
        })
        if (version.current.sha256 !== item.sha256 || version.current.size !== item.size) {
          throw new Error(`Immutable artifact verification failed for ${item.path}`)
        }
        saved.set(item.path, {
          ...item,
          artifact_id: version.id,
          version_id: version.current.id,
          version: version.current.version,
        })
      }),
    )
    return {
      artifacts: value.artifacts?.map((item) => saved.get(item.path) ?? item),
      checkpoint: value.checkpoint ? (saved.get(value.checkpoint.path) ?? value.checkpoint) : undefined,
    }
  }

  async function capture(job: Job): Promise<Pick<Job, "artifacts" | "checkpoint">> {
    const cwd = path.resolve(job.cwd ?? process.cwd())
    const [found, checkpoint] = await Promise.all([
      artifacts(cwd, job.artifact_patterns ?? []),
      job.checkpoint_path ? fingerprint(cwd, job.checkpoint_path) : undefined,
    ])
    return versionCapture(job, {
      artifacts: found,
      checkpoint,
    })
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
    return versionCapture(job, {
      artifacts: found.filter((item) => patterns.some((pattern) => pattern.match(item.path))),
      checkpoint,
    })
  }

  async function sshSpec(job: Job, scope: Scope, files?: SshAdapter.Upload[]): Promise<SshAdapter.Spec> {
    if (!job.ssh || !job.cwd) throw new Error(`SSH job ${job.id} is missing its durable dispatch specification`)
    const key = await SecretFile.key(path.join(scope.root, "ssh-control.key"))
    return {
      id: job.id,
      owner: crypto.createHmac("sha256", key).update(`openscience-ssh-v1\0${job.id}\0${job.ssh.root}`).digest("hex"),
      root: job.ssh.root,
      cwd: job.ssh.cwd,
      command: job.command,
      scheduler: job.scheduler,
      resources: job.resources,
      modules: job.modules,
      container: job.container,
      outputs: [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])],
      uploads:
        files ??
        job.ssh.uploads.map((file) => ({
          ...file,
          canonical: path.resolve(job.cwd!, file.path),
        })),
    }
  }

  async function stageSsh(
    job: Job,
    scope: Scope,
    files?: SshAdapter.Upload[],
    ready?: () => void,
    failed?: (error: Error) => Promise<void> | void,
  ) {
    if (!job.ssh || !job.authority) throw new Error(`SSH job ${job.id} has no staging authority`)
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    const spec = await sshSpec(job, scope, files)
    const archive = await SshAdapter.archive(spec, logsOf(scope.root))
    try {
      await event(
        scope.root,
        job.id,
        `Staging ${spec.uploads.length} verified input file${spec.uploads.length === 1 ? "" : "s"} on ${job.target_label}`,
      )
      await sshRun(scope, job, job.ssh.host, job.authority, SshAdapter.receive(spec), {
        stdin: archive,
        timeout: 120_000,
        ready,
        failed,
      })
    } finally {
      await fs.rm(archive, { force: true })
    }
  }

  async function submitSsh(job: Job, scope: Scope, failed?: (error: Error) => Promise<void> | void) {
    if (!job.ssh || !job.authority) throw new Error(`SSH job ${job.id} has no submission authority`)
    const result = await sshRun(
      scope,
      job,
      job.ssh.host,
      job.authority,
      SshAdapter.invoke(await sshSpec(job, scope), "submit"),
      { timeout: 30_000, failed },
    )
    // Test-only crash point: emulate the local owner disappearing after the
    // remote scheduler accepted and durably named the resource, but before
    // this process can publish remote_id into jobs.json. A fresh process must
    // recover through the remote idempotency record without a second launch.
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_SSH_TEST_KILLPOINT === "after-accept")
      process.exit(86)
    const submitted = SshAdapter.parse<{ remote_id: string; reattached: boolean }>(result.stdout)
    if (!/^(?:pid|slurm|pbs):[^\s]+$/.test(submitted.remote_id)) {
      throw new Error("SSH scheduler returned an invalid remote job id")
    }
    const current = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
      if (terminal.has(jobs[index]!.status)) return jobs[index]!
      const starting =
        jobs[index]!.lifecycle?.execution === "queued" ? move(jobs[index]!, { type: "start" }) : jobs[index]!
      const running = starting.lifecycle?.execution === "starting" ? move(starting, { type: "run" }) : starting
      jobs[index] = Job.parse({
        ...running,
        remote_id: submitted.remote_id,
        started_at: running.started_at ?? new Date().toISOString(),
        provenance: provenance(running),
      })
      return jobs[index]!
    })
    await event(
      scope.root,
      job.id,
      submitted.reattached
        ? `Reattached to ${submitted.remote_id}`
        : `Submitted ${submitted.remote_id} to ${job.target_label}`,
    )
    return current
  }

  async function startSsh(job: Job, scope: Scope, files: SshAdapter.Upload[], ready?: () => void) {
    const failed = async (error: Error) => {
      await recordSshFailure(job, scope, error)
    }
    await stageSsh(job, scope, files, ready, failed)
    return submitSsh(job, scope, failed)
  }

  async function recordSshFailure(job: Job, scope: Scope, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
      if (terminal.has(jobs[index]!.status)) return jobs[index]!
      const lifecycle = jobs[index]!.lifecycle ?? ComputeLifecycle.from(jobs[index]!.status)
      const starting = lifecycle.execution === "queued" ? move(jobs[index]!, { type: "start" }) : jobs[index]!
      const stopped = move(
        starting,
        { type: "finish", outcome: "failed", message },
        { completed_at: new Date().toISOString(), exit_code: null, error: message },
      )
      jobs[index] = Job.parse({ ...stopped, provenance: provenance(stopped) })
      return jobs[index]!
    })
  }

  async function failSshStart(job: Job, scope: Scope, error: unknown) {
    const failed = await recordSshFailure(job, scope, error)
    const released = await releaseSsh(failed, scope, false).then(
      () => true,
      async (failure) => {
        await event(
          scope.root,
          job.id,
          `Remote workspace cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        )
        return false
      },
    )
    return change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
      const settled = released ? move(jobs[index]!, { type: "close" }) : move(jobs[index]!, { type: "lose" })
      jobs[index] = Job.parse({ ...settled, provenance: provenance(settled) })
      return jobs[index]!
    })
  }

  async function sshLog(job: Job, scope: Scope) {
    if (!job.ssh || !job.authority || !job.remote_id) return
    const value = await sshRun(
      scope,
      job,
      job.ssh.host,
      job.authority,
      SshAdapter.invoke(await sshSpec(job, scope), "log", "262144"),
    )
    await snapshot(path.join(logsOf(scope.root), `${job.id}.log`), value.stdout.toString("utf8"))
  }

  function missingSshOutputs(job: Job, found: Artifact[]) {
    const expected = [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])]
    return expected.filter((pattern) => {
      const glob = new Bun.Glob(pattern.split(path.sep).join("/"))
      return !found.some((file) => glob.match(file.path.split(path.sep).join("/")))
    })
  }

  async function releaseSsh(job: Job, scope: Scope, authorize = true) {
    if (!job.ssh || !job.authority) throw new Error(`SSH job ${job.id} has no releasable remote workspace`)
    await sshRun(scope, job, job.ssh.host, job.authority, SshAdapter.invoke(await sshSpec(job, scope), "release"), {
      timeout: 30_000,
      authorize,
    })
    await event(scope.root, job.id, `Released remote workspace ${job.ssh.root}`)
  }

  async function harvestSsh(job: Job, scope: Scope) {
    if (!job.ssh || !job.authority || !job.cwd) throw new Error(`SSH job ${job.id} has no recoverable output`)
    const archive = path.join(logsOf(scope.root), `${job.id}.${crypto.randomUUID()}.outputs.tar`)
    try {
      await sshRun(scope, job, job.ssh.host, job.authority, SshAdapter.invoke(await sshSpec(job, scope), "harvest"), {
        stdout: archive,
        timeout: 300_000,
      })
      const delivered = Artifact.array().parse(await SshAdapter.deliver(archive, job.cwd))
      const missing = missingSshOutputs(job, delivered)
      if (missing.length) {
        throw new Error(
          `SSH job did not produce declared output${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        )
      }
      const checkpoint = job.checkpoint_path
        ? delivered.find((item) => item.path === job.checkpoint_path!.split(path.sep).join("/"))
        : undefined
      return versionCapture(job, {
        artifacts: delivered.filter((item) =>
          (job.artifact_patterns ?? []).some((pattern) => new Bun.Glob(pattern).match(item.path)),
        ),
        checkpoint,
      })
    } finally {
      await fs.rm(archive, { force: true })
    }
  }

  async function finishSsh(job: Job, scope: Scope, code: number) {
    const collecting = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
      const current = jobs[index]!
      if (terminal.has(current.status)) return current
      const finished = move(
        current,
        { type: "finish", outcome: code === 0 ? "succeeded" : "failed" },
        {
          completed_at: new Date().toISOString(),
          exit_code: code,
        },
      )
      const expected = (finished.artifact_patterns?.length ?? 0) > 0 || !!finished.checkpoint_path
      const next = expected ? move(finished, { type: "collect" }) : finished
      jobs[index] = Job.parse({ ...next, provenance: provenance(next) })
      return jobs[index]!
    })
    const expected = (collecting.artifact_patterns?.length ?? 0) > 0 || !!collecting.checkpoint_path
    if (!expected) {
      const released = await releaseSsh(collecting, scope).then(
        () => true,
        async (error) => {
          await event(
            scope.root,
            job.id,
            `Remote workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          return false
        },
      )
      return await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
        const current = jobs[index]!
        const lifecycle = released ? move(current, { type: "close" }) : move(current, { type: "lose" })
        jobs[index] = Job.parse({ ...lifecycle, provenance: provenance(lifecycle) })
        return jobs[index]!
      })
    }
    const captured = await harvestSsh(collecting, scope).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      await event(scope.root, job.id, `SSH output recovery failed: ${message}`)
      await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0) return
        const current = jobs[index]!
        if (current.lifecycle?.delivery !== "pending") return
        const failed = move(current, { type: "delivery_fail", message }, { capture_error: message })
        const retained = move(failed, { type: "lose" })
        jobs[index] = Job.parse({ ...retained, provenance: provenance(retained) })
      })
      return undefined
    })
    if (!captured) return get(job.id, { root: scope.root, workspace: scope.workspace })
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
      const current = jobs[index]!
      if (current.lifecycle?.delivery !== "pending") return
      const delivered = move(current, { type: "deliver" })
      jobs[index] = Job.parse({
        ...delivered,
        ...captured,
        capture_error: undefined,
        provenance: provenance(delivered),
      })
    })
    const delivered = await get(job.id, { root: scope.root, workspace: scope.workspace })
    if (!delivered) throw new Error(`Compute job ${job.id} was not found`)
    const released = await releaseSsh(delivered, scope).then(
      () => true,
      async (error) => {
        await event(
          scope.root,
          job.id,
          `Remote workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      },
    )
    return await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
      const current = jobs[index]!
      const next = released ? move(current, { type: "close" }) : move(current, { type: "lose" })
      jobs[index] = Job.parse({ ...next, provenance: provenance(next) })
      return jobs[index]!
    })
  }

  async function recoverSsh(job: Job, scope: Scope) {
    if (!job.ssh || !job.authority) return
    const allowed = await currentAuthority(job.authority).then(
      () => true,
      () => false,
    )
    if (!allowed) {
      await cancelSsh(job, scope)
      return
    }
    if (!job.remote_id) {
      await submitSsh(job, scope).catch(async () => {
        await stageSsh(job, scope)
        await submitSsh(job, scope)
      })
      return
    }
    const lifecycle = job.lifecycle ?? ComputeLifecycle.from(job.status)
    if (terminal.has(job.status) && lifecycle.delivery !== "pending") {
      const checked = await sshRun(
        scope,
        job,
        job.ssh.host,
        job.authority,
        SshAdapter.inspect(await sshSpec(job, scope)),
      )
      const exists = SshAdapter.parse<{ exists: boolean }>(checked.stdout).exists
      if (!exists) {
        await change(scope.root, (jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id)
          if (index < 0) return
          const current = jobs[index]!
          const abandoned = current.lifecycle?.recoverable ? move(current, { type: "abandon" }) : current
          const closed = abandoned.lifecycle?.resource === "closed" ? abandoned : move(abandoned, { type: "close" })
          jobs[index] = Job.parse({ ...closed, cleanup_error: undefined, provenance: provenance(closed) })
        })
        await event(scope.root, job.id, "Confirmed that the remote workspace was already released")
        return
      }
    }
    await sshLog(job, scope).catch(() => undefined)
    const response = await sshRun(
      scope,
      job,
      job.ssh.host,
      job.authority,
      SshAdapter.invoke(await sshSpec(job, scope), "status", job.remote_id),
    )
    const state = SshAdapter.parse<SshAdapter.Result>(response.stdout)
    if (state.state === "queued" || state.state === "running") return
    if (state.state === "unknown") {
      await event(scope.root, job.id, state.detail ?? "Remote scheduler state is temporarily unavailable")
      return
    }
    if (state.state === "cancelled") {
      await cancelSsh(job, scope)
      return
    }
    if (state.code === undefined) throw new Error("SSH job completed without an exit code")
    await finishSsh(job, scope, state.code)
  }

  async function cancelSsh(job: Job, scope: Scope) {
    if (!job.ssh || !job.authority) throw new Error(`SSH job ${job.id} has no cancellable remote resource`)
    await using operation = await FileLease.acquire(sshOperationOf(scope.root, job.id))
    return await operation.during(async () => {
      const current = await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id)
        if (index < 0) throw new Error(`Compute job ${job.id} was not found`)
        const stored = jobs[index]!
        if (terminal.has(stored.status)) return stored
        const cancelled = move(stored, { type: "cancel" }, { completed_at: new Date().toISOString(), exit_code: null })
        jobs[index] = Job.parse({ ...cancelled, provenance: provenance(cancelled) })
        return jobs[index]!
      })
      const remote = await (async () => {
        if (!current.remote_id) return { closed: true, error: undefined }
        const spec = await sshSpec(current, scope)
        const checked = await sshRun(scope, current, current.ssh!.host, current.authority!, SshAdapter.inspect(spec), {
          timeout: 30_000,
          authorize: false,
        })
        if (!SshAdapter.parse<{ exists: boolean }>(checked.stdout).exists) return { closed: true, error: undefined }
        const cancelled = await sshRun(
          scope,
          current,
          current.ssh!.host,
          current.authority!,
          SshAdapter.invoke(spec, "cancel", current.remote_id),
          { timeout: 30_000, authorize: false },
        ).then((value) => SshAdapter.parse<{ cancelled: boolean }>(value.stdout).cancelled)
        if (!cancelled) return { closed: false, error: "Remote scheduler did not confirm cancellation" }
        await releaseSsh(current, scope, false)
        return { closed: true, error: undefined }
      })().catch((error) => ({ closed: false, error: error instanceof Error ? error.message : String(error) }))
      if (remote.error) await event(scope.root, current.id, `Remote cancellation pending: ${remote.error}`)
      return await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === current.id)
        if (index < 0) throw new Error(`Compute job ${current.id} was not found`)
        const stored = jobs[index]!
        const abandoned = stored.lifecycle?.recoverable ? move(stored, { type: "abandon" }) : stored
        const lifecycle = remote.closed ? move(abandoned, { type: "close" }) : move(abandoned, { type: "lose" })
        jobs[index] = Job.parse({
          ...lifecycle,
          cleanup_error: remote.closed
            ? undefined
            : `Remote cancellation was not confirmed. ${remote.error ?? "Retry cancellation."}`,
          provenance: provenance(lifecycle),
        })
        return jobs[index]!
      })
    })
  }

  export async function probe(host: Host): Promise<Probe> {
    const parsed = Host.parse(host)
    const started = performance.now()
    const scanned = await SshAdapter.scan(parsed).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    if ("error" in scanned) {
      return Probe.parse({
        ok: false,
        host: parsed.label,
        latency_ms: Math.round(performance.now() - started),
        python: false,
        gpu: false,
        slurm: false,
        pbs: false,
        error: scanned.error,
      })
    }
    if (parsed.fingerprint && parsed.fingerprint !== scanned.fingerprint) {
      return Probe.parse({
        ok: false,
        host: parsed.label,
        latency_ms: Math.round(performance.now() - started),
        python: false,
        gpu: false,
        slurm: false,
        pbs: false,
        fingerprint: scanned.fingerprint,
        host_key: scanned.host_key,
        error: `SSH host key changed: expected ${parsed.fingerprint}, received ${scanned.fingerprint}`,
      })
    }
    const script = [
      "printf 'connected=1\\n'",
      "printf 'hostname='; hostname 2>/dev/null || true",
      "command -v python3 >/dev/null 2>&1 && printf 'python=1\\n' || true",
      "command -v bash >/dev/null 2>&1 && printf 'bash=1\\n' || true",
      "command -v nvidia-smi >/dev/null 2>&1 && printf 'gpu=1\\n' || true",
      "command -v sbatch >/dev/null 2>&1 && command -v squeue >/dev/null 2>&1 && command -v sacct >/dev/null 2>&1 && command -v scancel >/dev/null 2>&1 && printf 'slurm=1\\n' || true",
      "command -v qsub >/dev/null 2>&1 && command -v qstat >/dev/null 2>&1 && command -v qdel >/dev/null 2>&1 && printf 'pbs=1\\n' || true",
    ].join("; ")
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-probe-"))
    try {
      const known = await SshAdapter.known({ ...parsed, ...scanned }, temporary)
      const argv = SshAdapter.argv({ ...parsed, ...scanned }, known, script)
      const agent = process.env.SSH_AUTH_SOCK
      const detached = process.platform !== "win32"
      const proc = spawn(argv[0]!, argv.slice(1), {
        // The broker owns SSH authentication, so it passes only the agent
        // socket—not private-key files or arbitrary shell credentials.
        env: agent
          ? { ...OpenScience.kernelEnv(process.env), SSH_AUTH_SOCK: agent }
          : OpenScience.kernelEnv(process.env),
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const streams = boundedChild(proc, 64 * 1024, 64 * 1024)
      const done = new Promise<{ code: number | null; error?: string }>((resolve) => {
        proc.once("error", (error) => resolve({ code: null, error: error.message }))
        proc.once("exit", (code) => resolve({ code }))
      })
      const timer = setTimeout(() => streams.fail(new Error("Connection timed out")), 12_000)
      try {
        const outcome = await Promise.race([
          done.then((result) => ({ result, error: undefined })),
          streams.failed.then((error) => ({ result: undefined, error })),
        ])
        if (outcome.error) {
          await Shell.killTree(proc, {
            detached,
            exited: () => proc.exitCode !== null || proc.signalCode !== null,
          })
          await Promise.race([done, Bun.sleep(SSH_DRAIN_TIMEOUT)])
          streams.close()
        }
        const drained = await Promise.race([
          streams.finished.then(() => true),
          streams.failed.then(() => false),
          Bun.sleep(SSH_DRAIN_TIMEOUT).then(() => false),
        ])
        if (!drained) {
          streams.fail(new Error("SSH probe output streams did not close after process exit"))
          await Shell.killTree(proc, {
            detached,
            exited: () => proc.exitCode !== null || proc.signalCode !== null,
          })
          streams.close()
          await Promise.race([streams.finished, Bun.sleep(SSH_DRAIN_TIMEOUT)])
        }
        const failure = outcome.error ?? streams.state.error
        const result = failure ? { code: null, error: failure.message } : outcome.result!
        const text = Buffer.concat(streams.output.chunks, streams.output.size).toString("utf8")
        const connected = result.code === 0 && text.includes("connected=1")
        const python = text.includes("python=1")
        const bash = text.includes("bash=1")
        const slurm = text.includes("slurm=1")
        const pbs = text.includes("pbs=1")
        const missing = [
          !python ? "Python 3" : undefined,
          !bash ? "Bash" : undefined,
          parsed.scheduler === "slurm" && !slurm ? "Slurm (sbatch, squeue, sacct, scancel)" : undefined,
          parsed.scheduler === "pbs" && !pbs ? "PBS (qsub, qstat, qdel)" : undefined,
        ].filter((value): value is string => !!value)
        const transportError =
          result.error ||
          (result.code === 0
            ? undefined
            : Buffer.concat(streams.errors.chunks, streams.errors.size).toString("utf8").trim())
        const error =
          transportError ||
          (connected && missing.length
            ? `Dispatch prerequisites missing on ${parsed.label}: ${missing.join(", ")}`
            : undefined)
        return Probe.parse({
          ok: connected && missing.length === 0,
          host: parsed.label,
          latency_ms: Math.round(performance.now() - started),
          hostname: text.match(/^hostname=(.+)$/m)?.[1]?.trim(),
          python,
          gpu: text.includes("gpu=1"),
          slurm,
          pbs,
          fingerprint: scanned.fingerprint,
          host_key: scanned.host_key,
          error: error || undefined,
        })
      } finally {
        clearTimeout(timer)
        streams.dispose()
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }

  async function execute(
    job: Job,
    host: Host | undefined,
    scope: Scope,
    authority: ExecutionAuthority.Decision,
    launch: Launch,
    ready?: () => void,
  ): Promise<void> {
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    const log = path.join(logsOf(scope.root), `${job.id}.log`)
    const output = await fs.open(log, "a", 0o600)
    const detached = process.platform !== "win32"
    const ledgerID = credentialProcessID(scope.root, job.id)
    let launched:
      | {
          proc: ChildProcess
          result: Promise<{ code: number | null; error?: string }>
          key: string
        }
      | undefined
    try {
      launched = await AuthoritySignal.exclusive(() =>
        OpenScience.withSubprocessEnv(process.env, async (env) => {
          await currentAuthority(authority)
          const queued = (await read(scope.root)).find((item) => item.id === job.id)
          if (!queued || terminal.has(queued.status)) return
          const linuxIdentity = process.platform === "linux" ? await processIdentity(process.pid) : undefined
          if (process.platform === "linux" && !linuxIdentity) {
            throw new Error(`Could not establish the compute server identity for durable launch registration`)
          }
          const wrapped = WindowsJobLauncher.wrap({
            file: launch.argv[0]!,
            args: launch.argv.slice(1),
            linuxOwner: linuxIdentity ? { pid: process.pid, identity: linuxIdentity } : undefined,
          })
          const proc = spawn(wrapped.file, wrapped.args, {
            cwd: host ? authority.workspace : job.cwd,
            env,
            detached,
            windowsHide: true,
            stdio: ["ignore", output.fd, output.fd],
          })
          WindowsJobLauncher.bind(proc, wrapped.release)
          proc.once("exit", () => Sandbox.cleanup(launch))
          proc.once("error", () => Sandbox.cleanup(launch))
          const result = new Promise<{ code: number | null; error?: string }>((resolve) => {
            proc.once("error", (error) => resolve({ code: null, error: error.message }))
            proc.once("exit", (code) => resolve({ code }))
          })
          const identity = proc.pid ? await processIdentity(proc.pid) : undefined
          try {
            if (!proc.pid || !identity) {
              if (proc.exitCode !== null || proc.signalCode !== null) {
                throw new Error("Compute child exited before durable process-group ownership could be established")
              }
              throw new Error("Could not establish a safe identity for the credential-bearing compute child")
            } else {
              const registered = await CredentialProcessLedger.register({
                id: ledgerID,
                kind: "compute",
                pid: proc.pid,
                detached,
                identity,
                projectID: authority.projectID,
                sessionID: authority.sessionID,
                authorityGeneration: authority.generation,
                windowsRelease: wrapped.release,
              })
              if (!registered) {
                throw new Error("Compute child exited before durable process-group ownership could be established")
              }
            }
            const key = keyOf(scope.root, job.id)
            await activate(key, {
              process: proc,
              dataRootOwner: process.platform === "win32" ? undefined : { pid: proc.pid, identity },
              detached,
              authority,
              root: scope.root,
              workspace: scope.workspace,
              id: job.id,
              host,
            })
            const started = await change(scope.root, (jobs) => {
              const index = jobs.findIndex((item) => item.id === job.id)
              if (index < 0 || terminal.has(jobs[index]!.status)) return false
              const draft = move(
                jobs[index]!,
                { type: "run" },
                {
                  started_at: new Date().toISOString(),
                  pid: proc.pid,
                  process_identity: identity,
                },
              )
              jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
              return true
            })
            if (!started) {
              await Shell.killTree(proc, { detached, exited: () => proc.exitCode !== null })
              await deactivate(key)
              await completeCredentialProcess(ledgerID)
              ready?.()
              return
            }
            if (process.platform === "linux" && wrapped.release) {
              await WindowsJobLauncher.release(wrapped.release, proc.pid)
            }
            ready?.()
            return { proc, result, key }
          } catch (error) {
            await Shell.killTree(proc, { detached, exited: () => proc.exitCode !== null })
            await completeCredentialProcess(ledgerID)
            throw error
          }
        }),
      )
    } catch (error) {
      await output.close().catch(() => undefined)
      Sandbox.cleanup(launch)
      throw error
    }
    await output.close()
    if (!launched) {
      await deactivate(keyOf(scope.root, job.id))
      Sandbox.cleanup(launch)
      ready?.()
      return
    }
    const { proc, result, key } = launched
    const completed = await result
    await completeCredentialProcess(ledgerID)
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
          pid: undefined,
          process_identity: undefined,
          error: completed.error,
          ...captureResult,
        },
      )
      const closed = move(draft, { type: "close" })
      jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
    }).finally(() => deactivate(key))
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
    secrets?: Record<string, string>,
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
    const result = await provider.run(context, modalSpec(job, files, scope, secrets), {
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
    const stored = await get(id, { root: scope.root, workspace: scope.workspace })
    if (stored?.target.kind === "ssh") {
      if (active.has(key)) throw new Error(`Compute job ${id} already has an active recovery`)
      if (!stored.ssh || !stored.authority || !stored.lifecycle?.recoverable || !terminal.has(stored.status)) {
        throw new Error(`Compute job ${id} has no recoverable SSH output`)
      }
      await using operation = await FileLease.acquire(sshOperationOf(scope.root, id))
      return await operation.during(async () => {
        await using lease = await FileLease.acquire(sshLeaseOf(scope.root, id))
        return await lease.during(async () => {
          const retrying = await change(scope.root, (jobs) => {
            const index = jobs.findIndex((item) => item.id === id)
            if (index < 0) throw new Error(`Compute job ${id} was not found`)
            const draft = move(jobs[index]!, { type: "retry_delivery" }, { capture_error: undefined, error: undefined })
            jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
            return jobs[index]!
          })
          await finishSsh(retrying, scope, retrying.exit_code ?? 1)
          return (await get(id, { root: scope.root, workspace: scope.workspace }))!
        })
      })
    }
    // A Modal delivery failure can become visible just before its current
    // owner releases the in-memory runtime. The durable lease is the source of
    // truth across both this process and sibling servers: wait for that owner
    // instead of rejecting an explicit retry in the handoff window.
    await using operation = await FileLease.acquire(modalOperationOf(scope.root, id))
    return await operation.during(async () => {
      const lease = await FileLease.acquire(modalLeaseOf(scope.root, id))
      let handedOff = false
      try {
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
        await activate(key, {
          detached: false,
          authority: job.authority!,
          root: scope.root,
          workspace: scope.workspace,
          id: job.id,
          modal: context,
          provider,
        })
        const managed = lease
          .during(async () => {
            try {
              await recoverModal(job, scope, context, provider)
            } catch (error) {
              await failModal(job, scope, context, error, provider)
            } finally {
              await deactivate(key)
            }
          })
          .finally(() => releaseLease(lease))
        handedOff = true
        void managed.catch(() => undefined)
        return job
      } finally {
        if (!handedOff) {
          await deactivate(key)
          await releaseLease(lease)
        }
      }
    })
  }

  export async function release(id: string, options: Options = {}): Promise<Job> {
    const scope = await scoped(options)
    const key = keyOf(scope.root, id)
    if (active.has(key)) throw new Error(`Compute job ${id} still has an active recovery`)
    const stored = await get(id, { root: scope.root, workspace: scope.workspace })
    if (stored?.target.kind === "ssh") {
      if (!terminal.has(stored.status)) throw new Error(`Cancel compute job ${id} before releasing its resources`)
      if (stored.status === "cancelled" && stored.lifecycle?.resource !== "closed") return cancelSsh(stored, scope)
      await using operation = await FileLease.acquire(sshOperationOf(scope.root, id))
      return await operation.during(async () => {
        await using lease = await FileLease.acquire(sshLeaseOf(scope.root, id))
        return await lease.during(async () => {
          await releaseSsh(stored, scope)
          return await change(scope.root, (jobs) => {
            const index = jobs.findIndex((item) => item.id === id)
            if (index < 0) throw new Error(`Compute job ${id} was not found`)
            const current = jobs[index]!
            const abandoned = current.lifecycle?.recoverable ? move(current, { type: "abandon" }) : current
            const closed = current.lifecycle?.resource === "closed" ? abandoned : move(abandoned, { type: "close" })
            jobs[index] = Job.parse({ ...closed, cleanup_error: undefined, provenance: provenance(closed) })
            return jobs[index]!
          })
        })
      })
    }
    await using operation = await FileLease.acquire(modalOperationOf(scope.root, id))
    return await operation.during(async () => {
      await using lease = await FileLease.acquire(modalLeaseOf(scope.root, id))
      return await lease.during(async () => {
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
      })
    })
  }

  export async function plan(input: Request, options: Options = {}): Promise<Plan> {
    const parsed = Request.parse(input)
    if (parsed.secret_refs?.length && parsed.target.kind !== "modal") {
      throw new Error("Trusted compute secret references are currently supported only by Modal")
    }
    let scope = await scoped(options)
    const authority = await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: parsed.sessionID,
      capability: parsed.target.kind === "local" ? "local_job" : "remote_job",
    })
    scope = await bindScopeWorkspace(scope, authority)
    if (parsed.target.kind === "local") {
      const requested = parsed.cwd ? path.resolve(authority.workspace, parsed.cwd) : authority.workspace
      const cwd = await Filesystem.canonical(requested)
      const info = cwd ? await fs.stat(cwd).catch(() => undefined) : undefined
      if (!cwd || !info?.isDirectory() || !Filesystem.contains(authority.workspace, cwd)) {
        throw new Error(
          `Local compute working directory must be inside the session workspace: ${parsed.cwd ?? requested}`,
        )
      }
      await outputs(cwd, parsed.artifacts ?? [], parsed.checkpoint)
      const value = {
        provider: "local" as const,
        name: parsed.name,
        purpose: parsed.purpose ?? parsed.name,
        command: parsed.command,
        cwd,
        resources: parsed.resources,
        artifact_patterns: parsed.artifacts ?? [],
        checkpoint: parsed.checkpoint,
        warning: "This detached job runs on this computer inside the active session sandbox.",
      }
      const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
      return LocalPlan.parse({ digest, ...value })
    }
    const requested =
      parsed.target.kind === "ssh"
        ? authority.workspace
        : parsed.cwd
          ? path.resolve(authority.workspace, parsed.cwd)
          : authority.workspace
    const cwd = await Filesystem.canonical(requested)
    const info = cwd ? await fs.stat(cwd).catch(() => undefined) : undefined
    if (!cwd || !info?.isDirectory() || !Filesystem.contains(authority.workspace, cwd)) {
      throw new Error(`Remote staging directory must be inside the session workspace: ${requested}`)
    }
    if (parsed.target.kind === "modal") return (await modal(parsed, cwd, options.modal)).plan
    if (parsed.target.kind !== "ssh") throw new Error("Unsupported remote compute target")
    const hostID = parsed.target.host_id
    const host = options.hosts?.find((item) => item.id === hostID)
    if (!host) throw new Error("The selected SSH compute profile was not found")
    await outputs(cwd, parsed.artifacts ?? [], parsed.checkpoint)
    return (
      await SshPlan.prepare({
        id: "approved-job",
        purpose: parsed.purpose ?? parsed.name,
        command: parsed.command,
        resources: parsed.resources,
        modules: parsed.modules,
        container: parsed.container,
        cwd,
        remoteCwd: parsed.cwd,
        uploads: parsed.uploads ?? [],
        outputs: [...(parsed.artifacts ?? []), ...(parsed.checkpoint ? [parsed.checkpoint] : [])],
        host,
      })
    ).plan
  }

  export async function start(input: Request, options: Options = {}): Promise<Job> {
    const parsed = Request.parse(input)
    if (parsed.secret_refs?.length && parsed.target.kind !== "modal") {
      throw new Error("Trusted compute secret references are currently supported only by Modal")
    }
    let scope = await scoped(options)
    const hostId = parsed.target.kind === "ssh" ? parsed.target.host_id : undefined
    const host = hostId ? options.hosts?.find((item) => item.id === hostId) : undefined
    if (parsed.target.kind === "ssh" && !host) throw new Error("The selected SSH compute profile was not found")
    const authority = await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: parsed.sessionID,
      capability: host || parsed.target.kind === "modal" ? "remote_job" : "local_job",
    })
    scope = await bindScopeWorkspace(scope, authority)
    const requested = parsed.cwd ? path.resolve(authority.workspace, parsed.cwd) : authority.workspace
    const cwd = host ? authority.workspace : await Filesystem.canonical(requested)
    const info = !host && cwd ? await fs.stat(cwd).catch(() => undefined) : undefined
    if (!host && (!cwd || !info?.isDirectory() || !Filesystem.contains(authority.workspace, cwd))) {
      throw new Error(
        `Local compute working directory must be inside the session workspace: ${parsed.cwd ?? requested}`,
      )
    }
    const id = crypto.randomUUID().slice(0, 12)
    const prepared = parsed.target.kind === "modal" ? await modal(parsed, cwd!, options.modal) : undefined
    const remote = host
      ? await SshPlan.prepare({
          id,
          purpose: parsed.purpose ?? parsed.name,
          command: parsed.command,
          resources: parsed.resources,
          modules: parsed.modules,
          container: parsed.container,
          cwd: authority.workspace,
          remoteCwd: parsed.cwd,
          uploads: parsed.uploads ?? [],
          outputs: [...(parsed.artifacts ?? []), ...(parsed.checkpoint ? [parsed.checkpoint] : [])],
          host,
        })
      : undefined
    const provider = options.provider ?? ModalAdapter
    if (prepared && parsed.approval !== prepared.plan.digest) {
      throw new Error("The Modal run must be approved using its current plan digest")
    }
    if (remote && parsed.approval !== remote.plan.digest) {
      throw new Error("The SSH run must be approved using its current plan digest")
    }
    if (parsed.target.kind !== "modal") await outputs(cwd!, parsed.artifacts ?? [], parsed.checkpoint)
    await currentAuthority(authority)
    const spec =
      parsed.target.kind === "modal"
        ? { label: "Modal", scheduler: "none" as const }
        : command({ id, ...parsed, cwd }, host)
    const lifecycle = ComputeLifecycle.transition(ComputeLifecycle.initial(), { type: "queue" })
    const draft = Job.parse({
      id,
      name: parsed.name,
      purpose: parsed.purpose ?? parsed.name,
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
            secret_refs: prepared.plan.secret_refs,
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
      ssh: remote
        ? {
            protocol: 1,
            host,
            root: remote.plan.remote_root,
            cwd: remote.plan.remote_cwd,
            fingerprint: remote.plan.fingerprint,
            uploads: remote.plan.uploads,
            upload_bytes: remote.plan.upload_bytes,
            approval: remote.plan.digest,
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
      const secrets = parsed.secret_refs?.length ? await options.resolveSecrets?.(parsed.secret_refs) : undefined
      if (parsed.secret_refs?.length && !secrets) {
        throw new Error("Trusted compute secrets were not resolved for dispatch")
      }
      const key = keyOf(scope.root, draft.id)
      const reproducibility = await reproduce(draft, authority)
      await currentAuthority(authority)
      const base = Job.parse({ ...draft, reproducibility })
      const job = Job.parse({ ...base, provenance: provenance(base) })
      await using admission = await FileLease.acquire(modalAdmissionOf(scope.root))
      await admission.during(async () => {
        await currentAuthority(authority)
        await change(scope.root, (jobs) => {
          const busy = jobs.filter(reservesModal).length
          if (busy >= context.concurrency) {
            throw new Error(`Modal concurrency limit reached for this project (${busy}/${context.concurrency})`)
          }
          jobs.push(job)
        })
      })

      const lease = await FileLease.acquire(modalLeaseOf(scope.root, job.id))
      let handedOff = false
      try {
        const setup = Promise.withResolvers<void>()
        let activated = false
        const managed = lease
          .during(async () => {
            try {
              await currentAuthority(authority)
              await activate(key, {
                detached: false,
                authority,
                root: scope.root,
                workspace: scope.workspace,
                id: job.id,
                modal: context,
                provider,
              })
              activated = true
              setup.resolve()
              await executeModal(job, prepared.files, scope, context, provider, secrets).catch((error) =>
                error instanceof ModalAdapter.HarvestError
                  ? deferModal(job, scope, error)
                  : failModal(job, scope, context, error, provider),
              )
            } catch (error) {
              setup.reject(error)
              throw error
            } finally {
              setup.resolve()
              if (activated) await deactivate(key)
            }
          })
          .finally(() => releaseLease(lease))
        handedOff = true
        void managed.catch(() => undefined)
        await setup.promise
        return job
      } catch (error) {
        await change(scope.root, (jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id)
          if (index < 0 || terminal.has(jobs[index]!.status)) return
          const cancelled = move(jobs[index]!, { type: "cancel" }, { completed_at: new Date().toISOString() })
          const closed = move(cancelled, { type: "close" })
          jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
        }).catch(() => undefined)
        throw error
      } finally {
        if (!handedOff) {
          await deactivate(key)
          await releaseLease(lease)
        }
      }
    }
    if (remote && host) {
      const reproducibility = await reproduce(draft, authority)
      await currentAuthority(authority)
      const base = Job.parse({ ...draft, reproducibility })
      const job = Job.parse({ ...base, provenance: provenance(base) })
      await using admission = await FileLease.acquire(sshAdmissionOf(scope.root, host.id))
      await admission.during(async () => {
        await currentAuthority(authority)
        await change(scope.root, (jobs) => {
          const busy = jobs.filter((item) => reservesSsh(item, host.id)).length
          if (busy >= host.concurrency) {
            throw new Error(`SSH concurrency limit reached for ${host.label} (${busy}/${host.concurrency})`)
          }
          jobs.push(job)
        })
      })
      const lease = await FileLease.acquire(sshLeaseOf(scope.root, job.id))
      const key = keyOf(scope.root, job.id)
      let handedOff = false
      try {
        const setup = Promise.withResolvers<void>()
        const ready = Promise.withResolvers<void>()
        let activated = false
        const managed = lease
          .during(async () => {
            try {
              await activate(key, {
                detached: false,
                authority,
                root: scope.root,
                workspace: scope.workspace,
                id: job.id,
                host,
              })
              activated = true
              setup.resolve()
              await startSsh(job, scope, remote.files, ready.resolve).catch((error) => {
                // A caller must never receive a successful handoff for a control
                // process that failed before durable registration. Persist the
                // terminal job in the background, but reject the launch now.
                ready.reject(error)
                return failSshStart(job, scope, error)
              })
            } catch (error) {
              setup.reject(error)
              throw error
            } finally {
              setup.resolve()
              if (activated) await deactivate(key)
            }
          })
          .finally(() => releaseLease(lease))
        handedOff = true
        void managed.catch(() => undefined)
        await setup.promise
        // Do not wait for network transfer or remote submission. This mirrors
        // local launch semantics: return as soon as the first credential-
        // bearing child is durably owned, while surfacing pre-registration
        // failures synchronously.
        await Promise.race([ready.promise, managed.then(() => undefined)])
        return job
      } catch (error) {
        // Before handoff, this scope owns rollback. After handoff, the managed
        // task owns failure persistence and lease/process cleanup.
        if (!handedOff) {
          await change(scope.root, (jobs) => {
            const index = jobs.findIndex((item) => item.id === job.id)
            if (index < 0 || terminal.has(jobs[index]!.status)) return
            const cancelled = move(jobs[index]!, { type: "cancel" }, { completed_at: new Date().toISOString() })
            const closed = move(cancelled, { type: "close" })
            jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
          }).catch(() => undefined)
        }
        throw error
      } finally {
        if (!handedOff) {
          await deactivate(key)
          await releaseLease(lease)
        }
      }
    }
    const reproducibility = host ? undefined : await reproduce(draft, authority)
    await currentAuthority(authority)
    const planned = await launch(draft, host, scope, authority).catch(async (error) => {
      if (!host) await fs.rm(exitOf(scope.root, id), { force: true })
      throw error
    })
    let job: Job
    try {
      await currentAuthority(authority)
      const base = Job.parse({ ...draft, sandbox: planned.sandbox, reproducibility })
      job = Job.parse({ ...base, provenance: provenance(base) })
      await change(scope.root, (jobs) => {
        jobs.push(job)
      })
    } catch (error) {
      Sandbox.cleanup(planned)
      if (!host) await fs.rm(exitOf(scope.root, id), { force: true }).catch(() => undefined)
      throw error
    }
    const key = keyOf(scope.root, job.id)
    const lease = await FileLease.acquire(localLeaseOf(scope.root, job.id))
    let handedOff = false
    try {
      const setup = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<void>()
      let activated = false
      const managed = lease
        .during(async () => {
          try {
            await activate(key, {
              detached: false,
              authority,
              root: scope.root,
              workspace: scope.workspace,
              id: job.id,
              host,
            })
            activated = true
            setup.resolve()
            await execute(job, host, scope, authority, planned, ready.resolve).catch(async (error) => {
              // `Sandbox.cleanup` is idempotent. This covers authority/env failures
              // that happen before a child is spawned; exit/error listeners own the
              // normal running-child path.
              Sandbox.cleanup(planned)
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
          } catch (error) {
            setup.reject(error)
            throw error
          } finally {
            setup.resolve()
            if (activated) await deactivate(key)
          }
        })
        .finally(() => releaseLease(lease))
      handedOff = true
      void managed.catch(() => undefined)
      await setup.promise
      await Promise.race([ready.promise, managed.then(() => undefined)])
      return job
    } finally {
      if (!handedOff) {
        try {
          await deactivate(key)
        } finally {
          await releaseLease(lease)
        }
      }
    }
  }

  export async function list(options: Options = {}): Promise<Job[]> {
    const scope = await scoped(options)
    await sync(scope, options)
    const jobs = await Promise.all((await read(scope.root)).map((job) => observe(scope.root, job)))
    return jobs.toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
  }

  export async function get(id: string, options: Options = {}): Promise<Job | undefined> {
    const scope = await scoped(options)
    const job = (await read(scope.root)).find((item) => item.id === id)
    return job ? observe(scope.root, job) : undefined
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
    const initial = (await read(scope.root).catch((error) => preserve(scope.root, error))).find((job) => job.id === id)
    if (!initial) throw new Error(`Compute job ${id} was not found`)
    let current: Job = initial
    if (current.target.kind === "ssh") return cancelSsh(current, scope)
    await using operation =
      current.target.kind === "modal" ? await FileLease.acquire(modalOperationOf(scope.root, id)) : undefined
    const action = async () => {
      if (current.target.kind === "modal") {
        const refreshed = (await read(scope.root).catch((error) => preserve(scope.root, error))).find(
          (job) => job.id === id,
        )
        if (!refreshed) throw new Error(`Compute job ${id} was not found`)
        current = refreshed
      }
      const needs =
        current.target.kind === "modal" && (!terminal.has(current.status) || current.lifecycle?.resource === "unknown")
      const context =
        runtime?.modal ??
        (needs ? await modalContext(options, "Enable Modal before cancelling this recovered job") : undefined)
      const localCancellation = current.target.kind !== "modal" && !terminal.has(current.status)
      if (localCancellation) {
        // Preserve the live descendant closure before a best-effort process
        // signal can kill the leader and reparent a setsid child.
        await CredentialProcessLedger.revoke({ id: credentialProcessID(scope.root, id), kind: "compute" })
      }
      const result = await change(scope.root, (jobs) => {
        const index = jobs.findIndex((item) => item.id === id)
        if (index < 0) throw new Error(`Compute job ${id} was not found`)
        if (terminal.has(jobs[index]!.status)) {
          const job = jobs[index]!
          if (localCancellation && job.status === "failed" && job.exit_code === null) {
            const lifecycle = ComputeLifecycle.State.parse({
              ...(job.lifecycle ?? ComputeLifecycle.from(job.status)),
              execution: "cancelled",
              resource: "closed",
              error_kind: undefined,
              system_hint: undefined,
            })
            const reconciled = Job.parse({
              ...job,
              status: "cancelled",
              lifecycle,
              completed_at: new Date().toISOString(),
              exit_code: null,
              pid: undefined,
              process_identity: undefined,
              error: undefined,
            })
            jobs[index] = Job.parse({ ...reconciled, provenance: provenance(reconciled) })
            return { job: jobs[index]!, changed: true, cleanup: false }
          }
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
      } else if (job.pid && (await owns(job.pid, job.process_identity))) {
        try {
          if (process.platform === "win32") process.kill(job.pid, "SIGTERM")
          else process.kill(-job.pid, "SIGTERM")
        } catch {}
      } else if (job.pid) {
        await event(
          scope.root,
          job.id,
          "Skipped process termination because the persisted PID no longer matched this job",
        )
      }
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
              readable: job.authority.readable,
              unreadable: OpenScience.kernelSensitivePaths(),
              options: job.authority.sandbox,
            })
          : { file: spec.argv[0]!, args: spec.argv.slice(1), temporary: undefined }
        let proc: ChildProcess
        try {
          proc = spawn(planned.file, planned.args, {
            cwd: job.authority?.workspace,
            env: OpenScience.kernelEnv(process.env),
            windowsHide: true,
            stdio: "ignore",
          })
          await new Promise<void>((resolve) => {
            proc.once("error", () => resolve())
            proc.once("exit", () => resolve())
          })
        } finally {
          Sandbox.cleanup(planned)
        }
      }
      return await change(scope.root, (jobs) => {
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
      }).finally(() => (runtime ? deactivate(keyOf(scope.root, id)) : undefined))
    }
    return await (operation ? operation.during(action) : action())
  }

  async function cancelActive(match: (runtime: Runtime) => boolean, failClosed = false): Promise<number> {
    const runtimes = [...active.values()].filter(match)
    const results = await Promise.allSettled(
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
    if (failClosed) {
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) throw new AggregateError(failures, "Credential-bearing compute jobs could not be revoked")
    }
    return runtimes.length
  }

  async function latchLocalCancellation(runtime: Runtime): Promise<void> {
    await change(runtime.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === runtime.id)
      if (index < 0 || terminal.has(jobs[index]!.status) || jobs[index]!.target.kind !== "local") return
      const cancelled = move(
        jobs[index]!,
        { type: "cancel" },
        {
          completed_at: new Date().toISOString(),
          exit_code: null,
          pid: undefined,
          process_identity: undefined,
        },
      )
      const closed = move(cancelled, { type: "close" })
      jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
    })
  }

  async function revokeActive(scope: { projectID?: string; sessionID?: string }): Promise<number> {
    const runtimes = [...active.values()].filter(
      (runtime) =>
        (!scope.projectID || runtime.authority.projectID === scope.projectID) &&
        (!scope.sessionID || runtime.authority.sessionID === scope.sessionID),
    )
    const local = new Map(
      runtimes
        .filter((runtime) => !runtime.modal && !runtime.host)
        .map((runtime) => [credentialProcessID(runtime.root, runtime.id), runtime]),
    )
    return CredentialProcessLedger.revoke(
      { kind: "compute", ...scope },
      {
        onPinned: async (id) => {
          const runtime = local.get(id)
          if (runtime) await latchLocalCancellation(runtime)
        },
      },
    )
  }

  export async function cancelSession(sessionID: string): Promise<number> {
    const recovered = await revokeActive({ sessionID })
    const current = await cancelActive((runtime) => runtime.authority.sessionID === sessionID, true)
    return Math.max(recovered, current)
  }

  export async function cancelProject(projectID: string): Promise<number> {
    const recovered = await revokeActive({ projectID })
    const current = await cancelActive((runtime) => runtime.authority.projectID === projectID, true)
    return Math.max(recovered, current)
  }

  async function credentialRoots(): Promise<string[]> {
    const roots = new Set([...active.values()].filter((runtime) => !runtime.modal).map((runtime) => runtime.root))
    const projects = path.join(Global.Path.data, "compute", "projects")
    const entries = await fs.readdir(projects, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries) if (entry.isDirectory()) roots.add(path.join(projects, entry.name))
    return [...roots]
  }

  /** Local and SSH job children inherit the credential snapshot that existed
   * when they were spawned. Revoke the durable, identity-verified child ledger
   * first, then cancel every queued/running non-Modal job on disk—including
   * children whose original server process died. Modal has its own isolated
   * provider credential lease and is intentionally unaffected. */
  export async function cancelCredentialProcesses(): Promise<number> {
    // Snapshot only the in-memory owners that can race their exit finalizer.
    // Durable dead-owner jobs have no competing finalizer. Revoke first so a
    // corrupt compute history can never prevent credential teardown.
    const activeBeforeRevocation = new Set(
      [...active.values()].filter((runtime) => !runtime.modal).map((runtime) => keyOf(runtime.root, runtime.id)),
    )
    const killed = await CredentialProcessLedger.revoke("compute")
    const roots = await credentialRoots()
    const cancelled = new Set<string>()
    for (const root of roots) {
      const stored = await read(root).catch((error) => preserve(root, error))
      for (const job of stored) {
        if (job.target.kind === "modal" || !job.pid || !job.process_identity) continue
        await CredentialProcessLedger.killExact({
          id: credentialProcessID(root, job.id),
          kind: "compute",
          pid: job.pid,
          identity: job.process_identity,
          detached: process.platform !== "win32",
        })
      }
      await change(root, (jobs) => {
        for (let index = 0; index < jobs.length; index++) {
          const job = jobs[index]!
          if (job.target.kind === "modal") continue
          if (terminal.has(job.status)) {
            // Revocation deliberately kills the child before publishing the
            // cancelled state. The owner finalizer can observe that SIGKILL
            // first and transiently record a null-exit failure. If this exact
            // process was identity-owned when revocation began, preserve the
            // intended cancellation outcome instead of exposing a race-shaped
            // failure to the user.
            if (job.status === "failed" && job.exit_code === null && activeBeforeRevocation.has(keyOf(root, job.id))) {
              const lifecycle = ComputeLifecycle.State.parse({
                ...(job.lifecycle ?? ComputeLifecycle.from(job.status)),
                execution: "cancelled",
                resource: "closed",
                error_kind: undefined,
                system_hint: undefined,
              })
              const reconciled = Job.parse({
                ...job,
                status: "cancelled",
                lifecycle,
                completed_at: new Date().toISOString(),
                exit_code: null,
                pid: undefined,
                process_identity: undefined,
                error: undefined,
              })
              jobs[index] = Job.parse({ ...reconciled, provenance: provenance(reconciled) })
              cancelled.add(keyOf(root, job.id))
              continue
            }
            if (job.pid || job.process_identity) {
              jobs[index] = Job.parse({ ...job, pid: undefined, process_identity: undefined })
            }
            continue
          }
          const draft = move(
            job,
            { type: "cancel" },
            {
              completed_at: new Date().toISOString(),
              exit_code: null,
              pid: undefined,
              process_identity: undefined,
            },
          )
          const closed = move(draft, { type: "close" })
          jobs[index] = Job.parse({ ...closed, provenance: provenance(closed) })
          cancelled.add(keyOf(root, job.id))
        }
      })
    }
    await Promise.all([...cancelled].map((key) => deactivate(key)))
    return Math.max(killed, cancelled.size)
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
