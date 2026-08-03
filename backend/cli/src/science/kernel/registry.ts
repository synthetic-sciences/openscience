import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import { ProvenanceEnvelope } from "@/science/provenance/envelope"
import { ExecutionAuthority } from "@/project/execution"
import { Storage } from "@/storage/storage"
import z from "zod"
import { KernelEnvironment } from "./types"
import type { ExecuteOptions, ExecuteResult, Kernel, KernelLanguage, KernelManager, KernelStartOptions } from "./types"

export type KernelIdentity = {
  projectID: string
  sessionID: string
  name: string
  language: KernelLanguage
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
    readonly provenanceID: string,
  ) {
    const cause = error instanceof Error ? error : new Error(String(error))
    super(cause.message, { cause })
    this.name = "KernelExecutionError"
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
}

type Pending = {
  identity: KernelIdentity
  key: string
  manager: KernelManager
  ticket: { cancelled: boolean }
  promise: Promise<Entry>
  generation: string
}

const Persisted = z.object({
  version: z.literal(1),
  identity: z.object({
    projectID: z.string(),
    sessionID: z.string(),
    name: z.string(),
    language: z.string(),
  }),
  state: z.enum(["lazy", "stopped", "crashed"]),
  incarnation: z.number().int().nullable(),
  execution_count: z.number().int().nonnegative(),
  last_activity_at: z.number().nullable(),
})

export const KernelStatus = z.object({
  id: z.string(),
  active: z.boolean(),
  state: z.enum(["lazy", "starting", "idle", "running", "stopped", "crashed"]),
  projectID: z.string(),
  sessionID: z.string(),
  name: z.string(),
  language: z.string(),
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
const records = Instance.state(
  () => ({
    entries: new Map<string, Entry>(),
    starts: new Map<string, Pending>(),
  }),
  async (value) => {
    for (const pending of value.starts.values()) pending.ticket.cancelled = true
    await Promise.allSettled([...value.starts.values()].map((pending) => pending.manager.release(pending.key)))
    await Promise.allSettled([...value.starts.values()].map((pending) => pending.promise))
    await Promise.allSettled(
      [...value.entries.values()].map(async (entry) => {
        await entry.manager.release(entry.key)
        entry.kernel = undefined
        entry.state = entry.state === "crashed" ? "crashed" : "stopped"
        entry.executionCount = 0
        entry.environment = null
        entry.startedAt = null
        entry.lastActivityAt = Date.now()
        entry.authority = null
        await persist(entry)
      }),
    )
    value.entries.clear()
    value.starts.clear()
  },
)

const key = (identity: KernelIdentity) =>
  `kernel-${Bun.hash(`${identity.projectID}\0${identity.sessionID}\0${identity.name}\0${identity.language}`).toString(
    36,
  )}`

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

async function persist(value: Entry) {
  await Storage.write(storageKey(value.identity), {
    version: 1,
    identity: value.identity,
    state:
      value.kernel?.crashed || value.state === "crashed" ? "crashed" : value.incarnation === null ? "lazy" : "stopped",
    incarnation: value.incarnation,
    execution_count: value.executionCount,
    last_activity_at: value.lastActivityAt,
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
  }
  records().entries.set(id, value)
  return value
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
) {
  const notebook = identity.name.startsWith("notebook:")
  const target = notebook ? identity.name.slice("notebook:".length) : identity.name
  const output = result?.outputs.find((item) => item.type === "result")?.data?.["text/plain"] ?? ""
  const fault = result?.outputs.find((item) => item.type === "error")?.error
  const error =
    fault?.traceback?.join("\n") ??
    (fault ? `${fault.name}: ${fault.message}` : cause instanceof Error ? cause.message : cause ? String(cause) : "")
  const outputs =
    result?.outputs.map((item, index) =>
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
      : [])
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
      incarnation: value.incarnation ?? undefined,
      processID: process?.pid,
      processStartedAt: process?.startedAt,
    },
    status: result?.ok ? "succeeded" : "failed",
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
      label: `${identity.language} cell · ${target}`.slice(0, 140),
      tool: identity.language === "r" ? "rkernel" : "notebook",
      sessionID: identity.sessionID,
      inputs: {
        ...(notebook ? { path: target } : { kernel: target }),
        language: identity.language,
        code,
      },
      status: result?.ok ? "ok" : "error",
      provenance: envelope,
      meta: {
        directory: Instance.directory,
        projectID: identity.projectID,
        ...(origin?.messageID !== undefined ? { messageID: origin.messageID } : {}),
        ...(origin?.callID !== undefined ? { callID: origin.callID } : {}),
        kernelID: value.key,
        kernelName: identity.name,
        kernelIncarnation: value.incarnation,
        executionCount: result?.executionCount ?? value.executionCount,
        outputTypes: result?.outputs.map((item) => item.type) ?? [],
        stdout: clip(result?.stdout ?? ""),
        stderr: clip(result?.stderr ?? ""),
        result: clip(output),
        error: clip(error),
      },
    } as Parameters<typeof Provenance.record>[0],
  )
}

const entry = async (identity: KernelIdentity, _options?: KernelStartOptions) => {
  const authority = await ExecutionAuthority.require({
    projectID: identity.projectID,
    sessionID: identity.sessionID,
    capability: "kernel",
  })
  const value = await hydrate(identity)
  if (value.kernel?.ready && value.authority?.generation === authority.generation) return value
  if (value.kernel?.ready) {
    await value.manager.release(value.key)
    value.kernel = undefined
    value.state = "stopped"
    value.environment = null
    value.startedAt = null
  }
  if (value.kernel?.crashed) value.state = "crashed"
  const pending = records().starts.get(value.key)
  if (pending?.generation === authority.generation) return pending.promise
  if (pending) {
    pending.ticket.cancelled = true
    await pending.manager.release(pending.key)
    await pending.promise.catch(() => undefined)
    records().starts.delete(value.key)
  }

  const incarnation = (value.incarnation ?? 0) + 1
  const ticket = { cancelled: false }
  value.state = "stopped"
  value.kernel = undefined
  value.environment = null
  value.incarnation = incarnation
  value.executionCount = 0
  value.startedAt = null
  value.lastActivityAt = Date.now()
  value.authority = authority
  const drop = () => {
    if (records().starts.get(value.key)?.ticket === ticket) records().starts.delete(value.key)
  }
  const stale = () => ticket.cancelled || records().entries.get(value.key) !== value
  const abort = async () => {
    drop()
    await value.manager.release(value.key)
    throw new KernelStartupCancelled()
  }
  // Booting runs inside a call so the pending-start record below is claimed in
  // this same synchronous block. The boot awaits (persist, then the process
  // spawn), and a cell that arrives during one of them has to find the in-flight
  // start to queue behind — publishing the record after those awaits let it
  // instead see an entry with no start and boot a second incarnation of its own.
  const start = (async () => {
    await persist(value)
    return value.manager.get(value.key, {
      sessionID: identity.sessionID,
      cwd: authority.workspace,
    })
  })().then(
    async (kernel) => {
      if (stale()) return abort()
      value.environment = kernel.environment ?? null
      value.authority = authority
      value.startedAt = kernel.process?.startedAt ?? Date.now()
      value.lastActivityAt = value.startedAt
      await persist(value)
      if (stale()) return abort()
      // Handing the kernel over is the last, synchronous step of the boot.
      // `/status` and the ready fast path above both read `value.kernel`, so
      // publishing it before the persist above advertised an idle, ready kernel
      // while the cell whose request booted it had not reached the execution
      // queue yet — a cell arriving in that window took the free slot first.
      drop()
      value.kernel = kernel
      return value
    },
    async (error) => {
      drop()
      value.kernel = undefined
      value.authority = authority
      value.state = ticket.cancelled ? "stopped" : "crashed"
      await persist(value)
      if (ticket.cancelled) throw new KernelStartupCancelled()
      throw error
    },
  )
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
    const value = await entry(identity, start)
    const kernel = value.kernel
    if (!kernel) throw new Error("Kernel startup completed without a process")
    const codeState = ProvenanceEnvelope.code(value.environment?.cwd ?? Instance.directory)
    const startedAt = Date.now()
    value.lastActivityAt = startedAt
    return kernel.execute(code, options).then(
      async (result) => {
        // The count belongs to this cell, so capture it before the awaits below.
        // `value.executionCount` is the kernel's running total and every cell
        // queued behind this one advances it — reading it back after the persist
        // reported the count of whichever cell had most recently finished.
        const count = result.executionCount ?? value.executionCount + 1
        value.executionCount = count
        const completedAt = Date.now()
        value.lastActivityAt = completedAt
        await persist(value)
        const complete = { ...result, executionCount: count }
        const node = await provenance(
          identity,
          value,
          code,
          startedAt,
          completedAt,
          codeState,
          options?.origin,
          complete,
        )
        return { ...complete, provenanceID: node.id }
      },
      async (error) => {
        const completedAt = Date.now()
        value.lastActivityAt = completedAt
        if (kernel.crashed) value.state = "crashed"
        await persist(value)
        const node = await provenance(
          identity,
          value,
          code,
          startedAt,
          completedAt,
          codeState,
          options?.origin,
          undefined,
          error,
        )
        throw new KernelExecutionError(error, node.id)
      },
    )
  }

  export function active(identity: KernelIdentity) {
    return status(identity).active
  }

  export function status(identity: KernelIdentity): KernelStatus {
    const value = record(identity)
    const starting = records().starts.get(value.key)?.ticket.cancelled === false
    const active = value.kernel?.ready ?? false
    if (!starting && value.kernel && !active) {
      value.state = value.kernel.crashed ? "crashed" : "stopped"
    }
    const process = active ? value.kernel?.process : undefined
    return {
      id: value.key,
      active,
      state: starting ? "starting" : active ? (value.kernel?.busy ? "running" : "idle") : value.state,
      projectID: identity.projectID,
      sessionID: identity.sessionID,
      name: identity.name,
      language: identity.language,
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
    const pending = records().starts.get(value.key)
    if (pending) pending.ticket.cancelled = true
    await value.manager.release(value.key)
    await pending?.promise.catch(() => undefined)
    records().starts.delete(value.key)
    value.kernel = undefined
    value.state = "stopped"
    value.executionCount = 0
    value.environment = null
    value.startedAt = null
    value.lastActivityAt = Date.now()
    value.authority = null
    await persist(value)
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
    const pending = [...records().starts.values()].filter((value) => value.identity.sessionID === sessionID)
    for (const value of pending) value.ticket.cancelled = true
    await Promise.allSettled(pending.map((value) => value.manager.release(value.key)))
    await Promise.allSettled(pending.map((value) => value.promise))
    const entries = [...records().entries.values()].filter((value) => value.identity.sessionID === sessionID)
    await Promise.allSettled(entries.map((value) => release(value.identity)))
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
