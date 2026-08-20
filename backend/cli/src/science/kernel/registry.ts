import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import { ProvenanceEnvelope } from "@/science/provenance/envelope"
import { ExecutionAuthority } from "@/project/execution"
import { Storage } from "@/storage/storage"
import path from "node:path"
import z from "zod"
import { KernelEnvironment } from "./types"
import { KernelProcessIdentity } from "./process"
import { Global } from "@/global"
import { FileLease } from "@/util/file-lease"
import { AuthoritySignal } from "@/project/authority-signal"
import { KernelMetrics } from "./metrics"
import { ProcessIdentity } from "@/process/process-identity"
import * as ExecutionFiles from "@/science/execution/files"
import { ExecutionHistory } from "@/science/execution/history"
import { Log } from "@/util/log"
import type {
  ExecuteOptions,
  ExecuteResult,
  Kernel,
  KernelLanguage,
  KernelManager,
  KernelProcess,
  KernelStartOptions,
} from "./types"

export type KernelIdentity = {
  projectID: string
  sessionID: string
  name: string
  language: KernelLanguage
  environmentName?: string
}

type KernelCell = {
  title: string | null
  source: string | null
  code: string
  status: "running" | "succeeded" | "failed"
  executionCount: number | null
  messageID: string | null
  callID: string | null
}

export class KernelStartupCancelled extends Error {
  constructor() {
    super("Kernel startup was cancelled before execution.")
    this.name = "KernelStartupCancelled"
  }
}

export class KernelExecutionError extends Error {
  constructor(
    error: unknown,
    readonly provenanceID?: string,
  ) {
    const cause = error instanceof Error ? error : new Error(String(error))
    super(cause.message, { cause })
    this.name = "KernelExecutionError"
  }
}

const log = Log.create({ service: "science.kernel.registry" })

/** Provenance enriches a completed execution but is never execution authority.
 * A corrupt/locked optional graph store must not erase a valid kernel result
 * or replace the kernel's original failure. The execution journal remains the
 * durable fallback and can be reconciled later. */
export async function saveOptionalProvenance<T>(save: () => Promise<T>): Promise<T | undefined> {
  try {
    return await save()
  } catch (error) {
    log.warn("optional provenance save failed", { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

type Entry = {
  identity: KernelIdentity
  key: string
  manager: KernelManager
  kernel?: Kernel
  state: "lazy" | "stopped" | "crashed"
  incarnation: number | null
  executionCount: number
  environment: KernelEnvironment | null
  startedAt: number | null
  lastActivityAt: number | null
  authority: ExecutionAuthority.Decision | null
  lastCell: KernelCell | null
  process: KernelProcess | null
  ownershipID: string | null
  lease?: FileLease.Lease
  claiming?: Promise<void>
  idle?: ReturnType<typeof setTimeout>
  expiring?: Promise<void>
}

type Pending = {
  identity: KernelIdentity
  key: string
  manager: KernelManager
  ticket: StartTicket
  promise: Promise<Entry>
  generation: string
}

type StartTicket = {
  cancelled: boolean
  minimumIncarnation: number
  ownershipID: string
  incarnation?: number
}

const Persisted = z.object({
  version: z.literal(1),
  identity: z.object({
    projectID: z.string(),
    sessionID: z.string(),
    name: z.string(),
    language: z.string(),
    environmentName: z.string().optional(),
  }),
  state: z.enum(["lazy", "stopped", "crashed"]),
  incarnation: z.number().int().nullable(),
  execution_count: z.number().int().nonnegative(),
  last_activity_at: z.number().nullable(),
  ownership_id: z.string().nullable().optional(),
  process: z
    .object({
      pid: z.number().int().positive(),
      startedAt: z.number().positive(),
      token: z.string().optional(),
      ownershipID: z.string().optional(),
    })
    .nullable()
    .optional(),
})

export const KernelStatus = z.object({
  id: z.string(),
  active: z.boolean(),
  state: z.enum(["lazy", "starting", "idle", "running", "stopped", "crashed"]),
  projectID: z.string(),
  sessionID: z.string(),
  name: z.string(),
  language: z.string(),
  environment_name: z.string(),
  target: z.object({
    kind: z.literal("local"),
  }),
  incarnation: z.number().int().nullable(),
  execution_count: z.number().int(),
  queue_depth: z.number().int(),
  environment: KernelEnvironment.nullable(),
  process_id: z.number().int().nullable(),
  process_started_at: z.number().nullable(),
  process_identity_verified: z.boolean().nullable(),
  started_at: z.number().nullable(),
  last_activity_at: z.number().nullable(),
  authority: ExecutionAuthority.Decision.nullable(),
  last_cell: z
    .object({
      title: z.string().nullable(),
      source: z.string().nullable(),
      code: z.string(),
      status: z.enum(["running", "succeeded", "failed"]),
      execution_count: z.number().int().positive().nullable(),
      message_id: z.string().nullable(),
      call_id: z.string().nullable(),
    })
    .nullable(),
  // Live usage sampled at request time for running processes. Absent fields
  // mean the platform could not report them — render as unavailable, not 0.
  resources: z
    .object({
      cpu_percent: z.number(),
      memory_bytes: z.number().int(),
      gpu_percent: z.number(),
      vram_bytes: z.number().int(),
    })
    .partial()
    .optional(),
})
export type KernelStatus = z.infer<typeof KernelStatus>

const managers = new Map<KernelLanguage, KernelManager>()
const DEFAULT_IDLE_MS = 30 * 60 * 1000

const idleMs = () => {
  const configured = Number(process.env.OPENSCIENCE_KERNEL_IDLE_MS)
  if (!Number.isFinite(configured) || configured < 1_000) return DEFAULT_IDLE_MS
  return configured
}

const records = Instance.state(
  () => ({
    entries: new Map<string, Entry>(),
    starts: new Map<string, Pending>(),
  }),
  async (value) => {
    for (const pending of value.starts.values()) pending.ticket.cancelled = true
    for (const entry of value.entries.values()) clearTimeout(entry.idle)
    const stopped = await Promise.allSettled([...value.entries.values()].map(releaseEntry))
    value.entries.clear()
    value.starts.clear()
    const failed = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed.length) {
      throw new AggregateError(
        failed.map((result) => result.reason),
        "One or more kernels could not be safely reclaimed while disposing the project instance.",
      )
    }
  },
)

const key = (identity: KernelIdentity) => {
  const environment = identity.environmentName ? `\0${identity.environmentName}` : ""
  return `kernel-${Bun.hash(
    `${identity.projectID}\0${identity.sessionID}\0${identity.name}\0${identity.language}${environment}`,
  ).toString(36)}`
}

const manager = (language: KernelLanguage) => {
  const value = managers.get(language)
  if (!value) throw new Error(`Kernel language '${language}' is not registered`)
  return value
}

const storageKey = (identity: KernelIdentity) => [
  "kernel_registry",
  identity.projectID,
  identity.sessionID,
  key(identity),
]

const leasePath = (id: string) => path.join(Global.Path.data, "kernel-registry", `${id}.lock`)

async function persist(value: Entry) {
  await Storage.write(storageKey(value.identity), {
    version: 1,
    identity: value.identity,
    state:
      value.kernel?.crashed || value.state === "crashed" ? "crashed" : value.incarnation === null ? "lazy" : "stopped",
    incarnation: value.incarnation,
    execution_count: value.executionCount,
    last_activity_at: value.lastActivityAt,
    ownership_id: value.ownershipID,
    process: value.kernel?.process ?? value.process,
  } satisfies z.infer<typeof Persisted>)
}

function restore(value: z.infer<typeof Persisted>) {
  const id = key(value.identity)
  const current = records().entries.get(id)
  if (current) return current
  const entry: Entry = {
    identity: value.identity,
    key: id,
    manager: manager(value.identity.language),
    state: value.state === "crashed" ? "crashed" : value.incarnation === null ? "lazy" : "stopped",
    incarnation: value.incarnation,
    executionCount: value.execution_count,
    environment: null,
    startedAt: null,
    lastActivityAt: value.last_activity_at,
    authority: null,
    lastCell: null,
    process: value.process ?? null,
    ownershipID: value.ownership_id ?? value.process?.ownershipID ?? null,
  }
  records().entries.set(id, entry)
  return entry
}

async function hydrate(identity: KernelIdentity) {
  const current = records().entries.get(key(identity))
  if (current) return current
  const stored = await Storage.read<unknown>(storageKey(identity)).catch((error) => {
    if (Storage.NotFoundError.isInstance(error)) return
    throw error
  })
  const parsed = Persisted.safeParse(stored)
  if (!parsed.success) return record(identity)
  if (
    parsed.data.identity.projectID !== identity.projectID ||
    parsed.data.identity.sessionID !== identity.sessionID ||
    parsed.data.identity.name !== identity.name ||
    parsed.data.identity.language !== identity.language
  ) {
    return record(identity)
  }
  return restore(parsed.data)
}

const clip = (value: string, max = 30_000) => (value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value)

const record = (identity: KernelIdentity) => {
  const id = key(identity)
  const current = records().entries.get(id)
  if (current) return current
  const value: Entry = {
    identity,
    key: id,
    manager: manager(identity.language),
    state: "lazy",
    incarnation: null,
    executionCount: 0,
    environment: null,
    startedAt: null,
    lastActivityAt: null,
    authority: null,
    lastCell: null,
    process: null,
    ownershipID: null,
  }
  records().entries.set(id, value)
  return value
}

async function releaseLease(value: Entry) {
  await value.lease?.[Symbol.asyncDispose]()
  value.lease = undefined
}

function withLease<T>(value: Entry, action: () => Promise<T>): Promise<T> {
  const lease = value.lease
  if (!lease) return Promise.reject(new Error(`Kernel ${value.key} is missing its durable lease`))
  return lease.during(action)
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

type ReapOptions = {
  ownershipID?: string
  preserveOwnership?: boolean
}

async function reap(value: Entry, options: ReapOptions = {}) {
  const identity = value.process
  const ownershipID = identity?.ownershipID ?? options.ownershipID ?? value.ownershipID ?? undefined
  if (!identity && !ownershipID) return
  if (!identity) {
    await KernelProcessIdentity.terminate(undefined, ownershipID)
    value.ownershipID = options.preserveOwnership ? (options.ownershipID ?? value.ownershipID) : null
    return
  }
  if (!identity.token && running(identity.pid)) {
    throw new Error(`Refusing to terminate unverified persisted kernel process ${identity.pid}.`)
  }
  await KernelProcessIdentity.terminate(identity, ownershipID)
  const stopped = async (attempt = 0): Promise<boolean> => {
    if (!KernelProcessIdentity.matchesRecorded(identity)) return true
    if (attempt >= 100) return false
    await Bun.sleep(10)
    return stopped(attempt + 1)
  }
  if (!(await stopped())) {
    throw new Error(`Kernel process ${identity.pid} is still running after an identity-verified termination attempt.`)
  }
  value.process = null
  value.ownershipID = options.preserveOwnership ? (options.ownershipID ?? value.ownershipID) : null
}

async function reapCurrent(value: Entry, options: ReapOptions = {}) {
  const identity = value.kernel?.process ?? value.process
  if (identity) value.process = identity
  await reap(value, options).catch(async (error) => {
    await persist(value).catch(() => undefined)
    throw error
  })
  return identity
}

function reserveIncarnation(value: Entry, ticket?: StartTicket) {
  if (!ticket) return
  if (ticket.incarnation === undefined) {
    ticket.incarnation = Math.max(ticket.minimumIncarnation, (value.incarnation ?? 0) + 1)
  }
  value.incarnation = Math.max(value.incarnation ?? 0, ticket.incarnation)
}

async function claim(value: Entry, ticket?: StartTicket, options: ReapOptions = {}) {
  if (value.lease) {
    reserveIncarnation(value, ticket)
    return
  }
  if (value.claiming) {
    await value.claiming
    reserveIncarnation(value, ticket)
    return
  }
  const pending = (async () => {
    const lease = await FileLease.acquire(leasePath(value.key), 1_000).catch(() => {
      throw new Error("This kernel is active in another OpenScience server. Stop it there before starting it here.")
    })
    value.lease = lease
    try {
      await lease.during(async () => {
        const stored = await Storage.read<unknown>(storageKey(value.identity)).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        })
        const parsed = Persisted.safeParse(stored)
        if (parsed.success) {
          value.incarnation = parsed.data.incarnation
          value.executionCount = parsed.data.execution_count
          value.lastActivityAt = parsed.data.last_activity_at
          value.process = parsed.data.process ?? null
          value.ownershipID = parsed.data.ownership_id ?? parsed.data.process?.ownershipID ?? null
        }
        await reap(value, options)
        reserveIncarnation(value, ticket)
      })
    } catch (error) {
      await releaseLease(value)
      throw error
    }
  })()
  value.claiming = pending
  await pending.finally(() => {
    if (value.claiming === pending) value.claiming = undefined
  })
}

async function reclaimEntry(value: Entry) {
  clearTimeout(value.idle)
  value.idle = undefined
  const pending = records().starts.get(value.key)
  if (pending) pending.ticket.cancelled = true
  // A start with no kernel claim is queued behind the authority mutation that
  // invoked this revoker. Waiting for that promise while the mutation still
  // owns AuthoritySignal.exclusive would deadlock. Its cancelled ticket makes
  // it abort before spawn when it eventually enters the exclusive section.
  const entered = !!pending && (!!value.lease || !!value.claiming)
  // Reserve the cancelled boot's generation while holding the kernel lease.
  // A restart may win the authority lease before this pending start enters its
  // own spawn section; without this reservation the replacement reused
  // incarnation 1 and looked indistinguishable from the boot it cancelled.
  const ownershipID = pending?.ticket.ownershipID
  const preserve = !!pending
  await claim(value, pending?.ticket, { ownershipID, preserveOwnership: preserve })
  // Reap through the durable ledger while the interpreter leader is still
  // alive. Its live descendant closure includes workers that called setsid()
  // and left the kernel's process group; killing the manager/leader first
  // would reparent those workers and erase the only safe ownership proof.
  const firstLease = value.lease!
  try {
    await firstLease.during(() =>
      reapCurrent(value, { ownershipID, preserveOwnership: preserve }).then(() => undefined),
    )
  } catch (error) {
    await releaseLease(value)
    throw error
  }
  if (entered) await pending?.promise.catch(() => undefined)
  else void pending?.promise.catch(() => undefined)
  records().starts.delete(value.key)
  // A cancelled startup releases its lease in the pending promise. Reclaim it
  // before touching the durable record so a different server cannot start the
  // same kernel between cancellation and the final stopped-state write.
  if (!value.lease) await claim(value, undefined, { ownershipID, preserveOwnership: preserve })
  // A cancelled startup may have crossed its spawn boundary after the first
  // pass. Keep the lexical ticket ID until this second pass has reclaimed any
  // late durable registration; only then may the pointer be cleared.
  const finalLease = value.lease!
  const failures: unknown[] = []
  try {
    await finalLease.during(async () => {
      await reapCurrent(value, { ownershipID })
      await value.manager.release(value.key).catch((error) => failures.push(error))
      value.kernel = undefined
      value.state = "stopped"
      value.executionCount = 0
      value.environment = null
      value.startedAt = null
      value.lastActivityAt = Date.now()
      value.authority = null
      value.lastCell = null
      value.process = null
      value.ownershipID = null
      await persist(value)
    })
  } catch (error) {
    await releaseLease(value)
    throw error
  }
  await releaseLease(value)
  if (failures.length) throw new AggregateError(failures, "Kernel manager cleanup failed after durable teardown")
}

function releaseEntry(value: Entry) {
  if (value.expiring) return value.expiring
  const pending = reclaimEntry(value)
  value.expiring = pending
  void pending.then(
    () => {
      if (value.expiring === pending) value.expiring = undefined
    },
    () => {
      if (value.expiring === pending) value.expiring = undefined
      scheduleIdle(value)
    },
  )
  return pending
}

function scheduleIdle(value: Entry) {
  clearTimeout(value.idle)
  value.idle = undefined
  const kernel = value.kernel
  if (!kernel?.ready || kernel.busy || value.expiring) return
  const activity = value.lastActivityAt ?? Date.now()
  const delay = Math.max(0, activity + idleMs() - Date.now())
  const timer = setTimeout(() => {
    if (value.idle !== timer) return
    value.idle = undefined
    if (value.kernel !== kernel || !kernel.ready || kernel.busy || value.lastActivityAt !== activity) {
      scheduleIdle(value)
      return
    }
    void releaseEntry(value).catch(() => undefined)
  }, delay)
  timer.unref?.()
  value.idle = timer
}

async function releaseEntries(entries: Entry[]) {
  const results = await Promise.allSettled(entries.map(releaseEntry))
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed.length) {
    throw new AggregateError(
      failed.map((result) => result.reason),
      "One or more kernels could not be safely reclaimed.",
    )
  }
}

async function provenance(
  identity: KernelIdentity,
  value: Entry,
  code: string,
  startedAt: number,
  completedAt: number,
  codeState: ReturnType<typeof ProvenanceEnvelope.code>,
  origin?: ExecuteOptions["origin"],
  result?: ExecuteResult,
  cause?: unknown,
  resources?: KernelMetrics.Sample,
  terminalStatus?: ProvenanceEnvelope.Schema["outputs"]["status"],
  files: ProvenanceEnvelope.Output[] = [],
  executionSequence?: number,
) {
  const notebook = identity.name.startsWith("notebook:")
  const target = notebook ? identity.name.slice("notebook:".length) : identity.name
  const output = result?.outputs.find((item) => item.type === "result")?.data?.["text/plain"] ?? ""
  const fault = result?.outputs.find((item) => item.type === "error")?.error
  const error =
    fault?.traceback?.join("\n") ??
    (fault ? `${fault.name}: ${fault.message}` : cause instanceof Error ? cause.message : cause ? String(cause) : "")
  const outcome = terminalStatus ?? (result?.ok ? "succeeded" : "failed")
  const outputs = [
    ...(result?.outputs.map((item, index) =>
      ProvenanceEnvelope.output({
        kind: item.type,
        label: item.name ?? item.error?.name ?? (Object.keys(item.data ?? {}).join(", ") || `output ${index + 1}`),
        content: JSON.stringify(item),
        createdAt: completedAt,
      }),
    ) ??
      (error
        ? [
            ProvenanceEnvelope.output({
              kind: "error",
              label: cause instanceof Error ? cause.name : "Execution error",
              content: error,
              createdAt: completedAt,
            }),
          ]
        : [])),
    ...files,
  ]
  const process = value.kernel?.process
  const envelope = ProvenanceEnvelope.create({
    kind: "kernel",
    projectID: identity.projectID,
    sessionID: identity.sessionID,
    runID: `run-${crypto.randomUUID()}`,
    code,
    cwd: value.environment?.cwd,
    codeState,
    host: {
      platform: value.environment?.sandbox.platform ?? globalThis.process.platform,
      arch: globalThis.process.arch,
      runtimes: {
        bun: Bun.version,
        node: globalThis.process.version,
      },
    },
    kernel: {
      id: value.key,
      language: identity.language,
      environmentName: identity.environmentName ?? value.environment?.interpreter.name ?? identity.language,
      interpreter: value.environment?.interpreter,
      incarnation: value.incarnation ?? undefined,
      processID: process?.pid,
      processStartedAt: process?.startedAt,
    },
    status: outcome,
    outputs,
    createdAt: startedAt,
    startedAt,
    completedAt,
  })
  return Provenance.recordOwned(
    {
      projectID: identity.projectID,
      directory: Instance.directory,
    },
    {
      kind: "run",
      label: `${identity.language} execution · ${target}`.slice(0, 140),
      tool: identity.language === "r" ? "r" : "python",
      sessionID: identity.sessionID,
      inputs: {
        ...(notebook ? { path: target } : { kernel: target }),
        language: identity.language,
        code,
      },
      status: outcome === "succeeded" ? "ok" : "error",
      provenance: envelope,
      meta: {
        directory: Instance.directory,
        projectID: identity.projectID,
        ...(origin?.messageID !== undefined ? { messageID: origin.messageID } : {}),
        ...(origin?.callID !== undefined ? { callID: origin.callID } : {}),
        kernelID: value.key,
        kernelName: identity.name,
        kernelEnvironment: identity.environmentName ?? value.environment?.interpreter.name ?? identity.language,
        interpreter: value.environment?.interpreter,
        kernelIncarnation: value.incarnation,
        executionCount: result?.executionCount ?? value.executionCount,
        ...(executionSequence !== undefined ? { executionSequence } : {}),
        outputTypes: result?.outputs.map((item) => item.type) ?? [],
        durationMs: Math.max(0, completedAt - startedAt),
        ...(resources && Object.keys(resources).length ? { resources } : {}),
        ...(outcome === "cancelled" ? { cancelled: true } : {}),
        ...(outcome === "interrupted" ? { interrupted: true } : {}),
        stdout: clip(result?.stdout ?? ""),
        stderr: clip(result?.stderr ?? ""),
        result: clip(output),
        error: clip(error),
      },
    } as Parameters<typeof Provenance.record>[0],
  )
}

type Handoff = (value: Entry, kernel: Kernel) => void

const entry = async (identity: KernelIdentity, options?: KernelStartOptions, handoff?: Handoff) => {
  const authority = await ExecutionAuthority.require({
    projectID: identity.projectID,
    sessionID: identity.sessionID,
    capability: "kernel",
  })
  const value = await hydrate(identity)
  if (value.expiring) {
    await value.expiring
    return entry(identity, options, handoff)
  }
  if (value.kernel?.ready && value.authority?.generation === authority.generation) {
    clearTimeout(value.idle)
    value.idle = undefined
    handoff?.(value, value.kernel)
    scheduleIdle(value)
    return value
  }
  if (value.kernel?.ready) {
    await reapCurrent(value)
    await value.manager.release(value.key)
    value.kernel = undefined
    value.state = "stopped"
    value.environment = null
    value.startedAt = null
  }
  if (value.kernel?.crashed) value.state = "crashed"
  const pending = records().starts.get(value.key)
  if (pending?.generation === authority.generation) {
    const active = await pending.promise
    if (!active.kernel) throw new Error("Kernel startup completed without a process")
    handoff?.(active, active.kernel)
    return active
  }
  if (pending) {
    pending.ticket.cancelled = true
    await KernelProcessIdentity.terminate(undefined, pending.ticket.ownershipID)
    await pending.promise.catch(() => undefined)
    await KernelProcessIdentity.terminate(undefined, pending.ticket.ownershipID)
    await pending.manager.release(pending.key)
    records().starts.delete(value.key)
  }

  const ticket: StartTicket = {
    cancelled: false,
    minimumIncarnation: (value.incarnation ?? 0) + 1,
    ownershipID: `kernel-${crypto.randomUUID()}`,
  }
  const drop = () => {
    if (records().starts.get(value.key)?.ticket === ticket) records().starts.delete(value.key)
  }
  const stale = () => ticket.cancelled || records().entries.get(value.key) !== value
  const abort = async () => {
    drop()
    const failures: unknown[] = []
    const terminated = await KernelProcessIdentity.terminate(undefined, ticket.ownershipID).then(
      () => {
        if (value.ownershipID === ticket.ownershipID) value.ownershipID = null
        return true
      },
      (error) => {
        failures.push(error)
        return false
      },
    )
    if (terminated) await value.manager.release(value.key).catch((error) => failures.push(error))
    await persist(value).catch((error) => failures.push(error))
    await releaseLease(value)
    if (failures.length) throw new AggregateError(failures, "Cancelled kernel startup could not be safely reclaimed")
    throw new KernelStartupCancelled()
  }
  // Publish the pending start before acquiring the cross-process authority
  // lease. The exclusive section then owns the final authority check, kernel
  // claim, child creation, durable process identity, and in-memory handoff as
  // one indivisible spawn boundary with trust/filesystem mutations.
  const start = AuthoritySignal.exclusive(async () => {
    await claim(value, ticket)
    const current = await ExecutionAuthority.require({
      projectID: identity.projectID,
      sessionID: identity.sessionID,
      capability: "kernel",
    }).catch(async (error) => {
      await releaseLease(value)
      throw error
    })
    if (current.generation !== authority.generation || stale()) {
      await abort()
    }

    value.state = "stopped"
    value.kernel = undefined
    value.environment = null
    value.executionCount = 0
    value.startedAt = null
    value.lastActivityAt = Date.now()
    value.authority = current
    value.lastCell = null
    const linuxIdentity = process.platform === "linux" ? await ProcessIdentity.capture(process.pid) : undefined
    if (process.platform === "linux" && !linuxIdentity) {
      throw new Error("Could not capture the Linux server identity for kernel launch")
    }
    const processOwnership: KernelProcessIdentity.Ownership = {
      id: ticket.ownershipID,
      projectID: identity.projectID,
      sessionID: identity.sessionID,
      authorityGeneration: current.generation,
      ...(linuxIdentity ? { linuxOwner: { pid: process.pid, identity: linuxIdentity } } : {}),
    }
    // Persist the durable ownership ID before spawn. If the server dies after
    // ledger registration but before the child pointer is published, a fresh
    // server can still revoke the exact containment group by this ID.
    value.ownershipID = processOwnership.id
    const sandboxPolicy = Object.freeze({
      enabled: current.sandbox.enabled,
      network: current.sandbox.network,
      allowWrite: Object.freeze([...current.sandbox.allowWrite]),
      onUnavailable: current.sandbox.onUnavailable,
    })
    return (async () => {
      await persist(value)
      const kernel = await value.manager.get(value.key, {
        ...options,
        sessionID: identity.sessionID,
        cwd: current.workspace,
        processOwnership,
        sandboxPolicy,
      })
      const registered = await KernelProcessIdentity.ensureRegistered(kernel.process, processOwnership)
      if (!registered) {
        throw new Error("Kernel manager did not expose a process for durable registration")
      }
      return kernel
    })().then(
      async (kernel) => {
        if (stale()) return abort()
        value.environment = kernel.environment ?? null
        value.process = kernel.process ?? null
        value.ownershipID = kernel.process?.ownershipID ?? processOwnership.id
        value.authority = current
        value.startedAt = kernel.process?.startedAt ?? Date.now()
        value.lastActivityAt = value.startedAt
        await persist(value)
        if (stale()) return abort()
        // A booting execute request synchronously reserves its kernel queue slot
        // before this ready process becomes visible through status. Otherwise a
        // client that reacts to `active` can overtake the cell that did the boot.
        handoff?.(value, kernel)
        drop()
        value.kernel = kernel
        scheduleIdle(value)
        return value
      },
      async (error) => {
        const failures: unknown[] = []
        const terminated = await KernelProcessIdentity.terminate(undefined, ticket.ownershipID).then(
          () => {
            if (value.ownershipID === ticket.ownershipID) value.ownershipID = null
            return true
          },
          (failure) => {
            failures.push(failure)
            return false
          },
        )
        if (terminated) await value.manager.release(value.key).catch((failure) => failures.push(failure))
        value.kernel = undefined
        value.authority = current
        value.state = ticket.cancelled ? "stopped" : "crashed"
        await persist(value)
        await releaseLease(value)
        if (failures.length) {
          throw new AggregateError([error, ...failures], "Kernel startup ownership cleanup failed")
        }
        if (ticket.cancelled) throw new KernelStartupCancelled()
        throw error
      },
    )
  }).finally(drop)
  records().starts.set(value.key, {
    identity,
    key: value.key,
    manager: value.manager,
    ticket,
    promise: start,
    generation: authority.generation,
  })
  return start
}

export namespace KernelRuntime {
  export function register(value: KernelManager) {
    managers.set(value.language, value)
  }

  export function ensure(identity: KernelIdentity) {
    return status(record(identity).identity)
  }

  export async function create(identity: KernelIdentity) {
    const value = await hydrate(identity)
    await persist(value)
    return status(value.identity)
  }

  export async function restoreSession(projectID: string, sessionID?: string) {
    await ExecutionHistory.recover(projectID, sessionID)
    const prefix = ["kernel_registry", projectID, ...(sessionID ? [sessionID] : [])]
    const paths = await Storage.list(prefix)
    await Promise.all(
      paths.map(async (path) => {
        const value = Persisted.safeParse(await Storage.read<unknown>(path))
        if (!value.success || value.data.identity.projectID !== projectID) return
        if (sessionID && value.data.identity.sessionID !== sessionID) return
        if (!managers.has(value.data.identity.language)) return
        restore(value.data)
      }),
    )
  }

  export async function get(identity: KernelIdentity, options?: KernelStartOptions): Promise<Kernel> {
    const value = await entry(identity, options)
    if (!value.kernel) throw new Error("Kernel startup completed without a process")
    return value.kernel
  }

  export async function execute(
    identity: KernelIdentity,
    code: string,
    options?: ExecuteOptions,
    start?: KernelStartOptions,
  ): Promise<ExecuteResult> {
    const source = options?.origin?.source ?? (identity.name.startsWith("notebook:") ? identity.name.slice(9) : null)
    const cell = (value: Entry): KernelCell => ({
      title: options?.origin?.title?.trim().slice(0, 100) || null,
      source,
      code: code.length > 12_000 ? `${code.slice(0, 12_000)}\n\n... (truncated)` : code,
      status: "running",
      executionCount: Math.max(value.executionCount, value.lastCell?.executionCount ?? 0) + 1,
      messageID: options?.origin?.messageID ?? null,
      callID: options?.origin?.callID ?? null,
    })
    const running: {
      cell?: KernelCell
      promise?: Promise<ExecuteResult>
      startedAt?: number
      codeState?: ReturnType<typeof ProvenanceEnvelope.code>
      metricScope?: string
      metricStart?: Promise<unknown>
      fileRoot?: string
      fileStart?: Promise<ExecutionFiles.Snapshot>
      sequence?: number
      journal?: Awaited<ReturnType<typeof ExecutionHistory.submit>>
    } = {}
    // Persist the exact submitted code before interpreter startup or queue
    // entry, so a backend crash cannot leave only a skipped ordinal.
    running.journal = await ExecutionHistory.submit({
      sessionID: identity.sessionID,
      language: identity.language,
      environmentName: identity.environmentName ?? identity.language,
      kernelName: identity.name,
      code,
      messageID: options?.origin?.messageID,
      callID: options?.origin?.callID,
    })
    running.sequence = running.journal.sequence
    let value: Entry
    try {
      value = await entry(identity, start, (current, kernel) => {
        // Reserve immediately so the registry can publish a queued execution;
        // onStart below replaces this with the actual queue-start boundary.
        running.startedAt = Date.now()
        current.lastActivityAt = running.startedAt
        running.fileRoot = current.environment?.cwd
        // KernelQueue increments synchronously, so status cannot expose an idle
        // process between the startup handoff and this request joining the queue.
        running.promise = kernel.execute(code, {
          ...options,
          onStart: async () => {
            running.startedAt = Date.now()
            current.lastActivityAt = running.startedAt
            await ExecutionHistory.start(running.journal!, {
              startedAt: running.startedAt,
              kernelID: current.key,
              incarnation: current.incarnation,
              environment: current.environment ?? kernel.environment ?? null,
            })
            // Baseline observation must finish after this cell reaches the head
            // of the persistent-kernel queue and before its code is sent. Taking
            // it at enqueue time lets adjacent cells claim each other's files.
            if (running.fileRoot) {
              const before = await ExecutionFiles.snapshot(running.fileRoot)
              running.fileStart = Promise.resolve(before)
            }
            const pid = kernel.process?.pid
            if (pid) {
              running.metricScope = `execution:${current.key}:${crypto.randomUUID()}`
              running.metricStart = KernelMetrics.sampleAll(running.metricScope, [pid]).catch(() => undefined)
            }
            running.cell = cell(current)
            current.lastCell = running.cell
            current.lastActivityAt = Date.now()
            await options?.onStart?.()
          },
        })
        // Capture after reserving the queue but before its promise continuation
        // can run. Best-effort git inspection therefore remains pre-execution.
        // Interpreter cwd may be the session's isolated scratch workspace. Git
        // state belongs to the owning project, not that transient directory.
        running.codeState = ProvenanceEnvelope.code(Instance.directory)
      })
    } catch (error) {
      await ExecutionHistory.complete(running.journal, {
        status: options?.signal?.aborted || error instanceof KernelStartupCancelled ? "cancelled" : "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const kernel = value.kernel
    const execution = running.promise
    if (!kernel || !execution || running.startedAt === undefined) {
      await ExecutionHistory.complete(running.journal, {
        status: "failed",
        completedAt: Date.now(),
        error: "Kernel startup completed without a queued execution",
      })
      throw new Error("Kernel startup completed without a queued execution")
    }
    return execution.then(
      (result) =>
        withLease(value, async () => {
          // The count belongs to this cell, so capture it before the awaits below.
          // `value.executionCount` is the kernel's running total and every cell
          // queued behind this one advances it — reading it back after the persist
          // reported the count of whichever cell had most recently finished.
          const count = result.executionCount ?? value.executionCount + 1
          value.executionCount = count
          const completedAt = Date.now()
          const startedAt = running.startedAt ?? completedAt
          value.lastActivityAt = completedAt
          const completeCell: KernelCell = {
            ...(running.cell ?? cell(value)),
            status: result.ok ? "succeeded" : "failed",
            executionCount: count,
          }
          if (!value.lastCell || value.lastCell === running.cell) value.lastCell = completeCell
          await persist(value)
          scheduleIdle(value)
          const complete = { ...result, executionCount: count }
          await running.metricStart
          const resources =
            running.metricScope && kernel.process?.pid
              ? await KernelMetrics.sampleAll(running.metricScope, [kernel.process.pid])
                  .then((samples) => samples.get(kernel.process!.pid))
                  .catch(() => undefined)
              : undefined
          const files =
            running.fileRoot && running.fileStart
              ? await running.fileStart
                  .then((before) => ExecutionFiles.changed(running.fileRoot!, before, completedAt))
                  .catch(() => [])
              : []
          const summary = complete.outputs.find((item) => item.type === "result")?.data?.["text/plain"] ?? ""
          const fault = complete.outputs.find((item) => item.type === "error")?.error
          await ExecutionHistory.complete(running.journal!, {
            status: complete.ok ? "succeeded" : "failed",
            completedAt,
            summary,
            stdout: complete.stdout,
            stderr: complete.stderr,
            error: fault?.traceback?.join("\n") ?? (fault ? `${fault.name}: ${fault.message}` : ""),
            outputCount: complete.outputs.length,
            resources,
            files,
          })
          const node = await saveOptionalProvenance(() =>
            provenance(
              identity,
              value,
              code,
              startedAt,
              completedAt,
              running.codeState,
              options?.origin,
              complete,
              undefined,
              resources,
              complete.ok ? "succeeded" : "failed",
              files,
              running.sequence,
            ),
          )
          if (node) await saveOptionalProvenance(() => ExecutionHistory.link(running.journal!, node.id))
          return { ...complete, ...(node ? { provenanceID: node.id } : {}) }
        }),
      (error) =>
        withLease(value, async () => {
          const completedAt = Date.now()
          const startedAt = running.startedAt ?? completedAt
          value.lastActivityAt = completedAt
          const failedCell: KernelCell = { ...(running.cell ?? cell(value)), status: "failed" }
          if (!value.lastCell || value.lastCell === running.cell) value.lastCell = failedCell
          if (kernel.crashed) value.state = "crashed"
          await persist(value)
          scheduleIdle(value)
          await running.metricStart
          const resources =
            running.metricScope && kernel.process?.pid
              ? await KernelMetrics.sampleAll(running.metricScope, [kernel.process.pid])
                  .then((samples) => samples.get(kernel.process!.pid))
                  .catch(() => undefined)
              : undefined
          const files =
            running.fileRoot && running.fileStart
              ? await running.fileStart
                  .then((before) => ExecutionFiles.changed(running.fileRoot!, before, completedAt))
                  .catch(() => [])
              : []
          const status = options?.signal?.aborted ? "cancelled" : kernel.crashed ? "interrupted" : "failed"
          await ExecutionHistory.complete(running.journal!, {
            status,
            completedAt,
            error: error instanceof Error ? error.message : String(error),
            resources,
            files,
          })
          const node = await saveOptionalProvenance(() =>
            provenance(
              identity,
              value,
              code,
              startedAt,
              completedAt,
              running.codeState,
              options?.origin,
              undefined,
              error,
              resources,
              status,
              files,
              running.sequence,
            ),
          )
          if (node) await saveOptionalProvenance(() => ExecutionHistory.link(running.journal!, node.id))
          throw new KernelExecutionError(error, node?.id)
        }),
    )
  }

  export function active(identity: KernelIdentity) {
    return status(identity).active
  }

  export function status(identity: KernelIdentity): KernelStatus {
    const value = record(identity)
    const starting = records().starts.get(value.key)?.ticket.cancelled === false
    const expiring = value.expiring !== undefined
    const active = !expiring && (value.kernel?.ready ?? false)
    if (!starting && !expiring && value.kernel && !active) {
      clearTimeout(value.idle)
      value.idle = undefined
      value.state = value.kernel.crashed ? "crashed" : "stopped"
    }
    const process = active ? value.kernel?.process : undefined
    return {
      id: value.key,
      active,
      state: starting
        ? "starting"
        : expiring
          ? "stopped"
          : active
            ? value.kernel?.busy
              ? "running"
              : "idle"
            : value.state,
      projectID: identity.projectID,
      sessionID: identity.sessionID,
      name: identity.name,
      language: identity.language,
      environment_name: identity.environmentName ?? identity.language,
      target: { kind: "local" },
      incarnation: value.incarnation,
      execution_count: value.executionCount,
      queue_depth: active ? (value.kernel?.queueDepth ?? 0) : 0,
      environment: active ? (value.kernel?.environment ?? value.environment) : null,
      process_id: process?.pid ?? null,
      process_started_at: process?.startedAt ?? null,
      process_identity_verified: process?.token ? true : null,
      started_at: active ? value.startedAt : null,
      last_activity_at: value.lastActivityAt,
      authority: value.authority,
      last_cell:
        active && value.lastCell
          ? {
              title: value.lastCell.title,
              source: value.lastCell.source,
              code: value.lastCell.code,
              status: value.lastCell.status,
              execution_count: value.lastCell.executionCount,
              message_id: value.lastCell.messageID,
              call_id: value.lastCell.callID,
            }
          : null,
    }
  }

  export function list(sessionID?: string) {
    return [...records().entries.values()]
      .filter((value) => !sessionID || value.identity.sessionID === sessionID)
      .map((value) => status(value.identity))
      .sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))
  }

  export function owned(id: string, projectID: string, sessionID: string) {
    const identity = records().entries.get(id)?.identity ?? records().starts.get(id)?.identity
    if (!identity || identity.projectID !== projectID || identity.sessionID !== sessionID) return
    return identity
  }

  export async function release(identity: KernelIdentity) {
    const value = records().entries.get(key(identity))
    if (!value) return
    await releaseEntry(value)
  }

  export async function restart(identity: KernelIdentity, options?: KernelStartOptions) {
    await release(identity)
    await entry(identity, options)
    return status(identity)
  }

  export async function forget(identity: KernelIdentity) {
    const id = key(identity)
    if (!records().entries.has(id) && !records().starts.has(id)) return false
    await release(identity)
    records().starts.delete(id)
    const removed = records().entries.delete(id)
    await Storage.remove(storageKey(identity))
    return removed
  }

  export async function interrupt(identity: KernelIdentity) {
    const value = records().entries.get(key(identity))
    if (!value?.kernel?.ready) return { ...status(identity), state_preserved: false }
    if (!value.kernel.busy) return { ...status(identity), state_preserved: true }

    const signaled = (await value.kernel.interrupt?.()) ?? false
    const wait = async (attempt = 0): Promise<boolean> => {
      if (!value.kernel?.ready) return false
      if (!value.kernel.busy) return true
      if (attempt >= 200) return false
      await Bun.sleep(10)
      return wait(attempt + 1)
    }
    const preserved = signaled && (await wait())
    if (preserved) return { ...status(identity), state_preserved: true }
    await release(identity)
    return { ...status(identity), state_preserved: false }
  }

  export async function releaseSession(sessionID: string) {
    cancelSession(sessionID)
    const entries = [...records().entries.values()].filter((value) => value.identity.sessionID === sessionID)
    await releaseEntries(entries)
  }

  /** Mark in-flight boots synchronously before a deletion waits on the shared
   * authority lease. The boot rechecks this ticket after its last awaited
   * startup step and cannot hand a deleted session a live interpreter. */
  export function cancelSession(sessionID: string) {
    const pending = [...records().starts.values()].filter((value) => value.identity.sessionID === sessionID)
    for (const value of pending) value.ticket.cancelled = true
  }

  export async function releaseProject(projectID: string) {
    await restoreSession(projectID)
    const pending = [...records().starts.values()].filter((value) => value.identity.projectID === projectID)
    for (const value of pending) value.ticket.cancelled = true
    const entries = [...records().entries.values()].filter((value) => value.identity.projectID === projectID)
    await releaseEntries(entries)
  }

  export async function removeSession(projectID: string, sessionID: string) {
    await restoreSession(projectID, sessionID)
    await releaseSession(sessionID)
    const entries = [...records().entries.values()].filter(
      (value) => value.identity.projectID === projectID && value.identity.sessionID === sessionID,
    )
    await Promise.allSettled(entries.map((value) => Storage.remove(storageKey(value.identity))))
    for (const value of entries) {
      records().starts.delete(value.key)
      records().entries.delete(value.key)
    }
  }
}
