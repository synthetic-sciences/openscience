import z from "zod"
import { Provenance, type Artifact, type Edge, type Node, type Run } from "@/science/provenance/store"
import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import type { KernelEnvironment } from "@/science/kernel/types"
import type { KernelMetrics } from "@/science/kernel/metrics"
import type { ProvenanceEnvelope } from "@/science/provenance/envelope"
import { KernelProcessIdentity } from "@/science/kernel/process"

const Unavailable = z.object({
  status: z.literal("unavailable"),
  reason: z.enum(["not_captured", "not_applicable"]),
})
const available = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("status", [z.object({ status: z.literal("available"), value }), Unavailable])

const FileRecord = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
})

const ArtifactRecord = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  sha256: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  artifact_id: z.string().optional(),
  version_id: z.string().optional(),
})

export const ExecutionRecord = z.object({
  id: z.string(),
  session_id: z.string(),
  sequence: z.number().int().positive(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "inconclusive"]),
  language: z.string(),
  code: available(z.string()),
  environment: z.object({
    name: available(z.string()),
    interpreter: available(
      z.object({
        name: z.string(),
        binary: z.string(),
        version: available(z.string()),
      }),
    ),
    kernel_id: available(z.string()),
    incarnation: available(z.number().int().positive()),
    restart_boundary: z.boolean(),
  }),
  timing: z.object({
    created_at: available(z.string()),
    started_at: available(z.string()),
    completed_at: available(z.string()),
    duration_ms: available(z.number().int().nonnegative()),
  }),
  result: z.object({
    summary: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    error: z.string(),
    output_count: z.number().int().nonnegative(),
  }),
  resources: available(
    z.object({
      cpu_percent: z.number().optional(),
      memory_bytes: z.number().int().nonnegative().optional(),
      gpu_percent: z.number().optional(),
      vram_bytes: z.number().int().nonnegative().optional(),
    }),
  ),
  files: FileRecord.array(),
  artifacts: ArtifactRecord.array(),
  provenance_id: z.string().nullable(),
  message_id: z.string().optional(),
  call_id: z.string().optional(),
})
export type ExecutionRecord = z.infer<typeof ExecutionRecord>

type Scope = { projectID: string; directory: string }
type Field<T> = { status: "available"; value: T } | { status: "unavailable"; reason: string }

const value = <T>(field: Field<T> | undefined) => (field?.status === "available" ? field.value : undefined)
const present = <T>(input: T | undefined) =>
  input === undefined
    ? ({ status: "unavailable", reason: "not_captured" } as const)
    : ({ status: "available", value: input } as const)

function text(input: unknown) {
  return typeof input === "string" ? input : ""
}

function resource(input: unknown) {
  const parsed = z
    .object({
      cpu_percent: z.number().optional(),
      memory_bytes: z.number().int().nonnegative().optional(),
      gpu_percent: z.number().optional(),
      vram_bytes: z.number().int().nonnegative().optional(),
    })
    .safeParse(input)
  return parsed.success && Object.keys(parsed.data).length
    ? ({ status: "available", value: parsed.data } as const)
    : ({ status: "unavailable", reason: "not_captured" } as const)
}

function artifacts(run: Run, nodes: Map<string, Node>, edges: Edge[]) {
  return edges
    .filter((edge) => edge.from === run.id && edge.relation === "produced")
    .flatMap((edge) => {
      const node = nodes.get(edge.to)
      if (!node || node.kind !== "artifact") return []
      const artifact = node as Artifact
      return [
        {
          id: artifact.id,
          label: artifact.label,
          kind: artifact.artifactType,
          ...(artifact.contentHash ? { sha256: artifact.contentHash } : {}),
          ...(artifact.size !== undefined ? { size: artifact.size } : {}),
          ...(typeof artifact.meta?.artifactID === "string" ? { artifact_id: artifact.meta.artifactID } : {}),
          ...(typeof artifact.meta?.versionID === "string" ? { version_id: artifact.meta.versionID } : {}),
        },
      ]
    })
}

function time(field: Field<string> | undefined) {
  const raw = value(field)
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

const JournalRecord = z.object({
  version: z.literal(1),
  id: z.string(),
  project_id: z.string(),
  session_id: z.string(),
  sequence: z.number().int().positive(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "inconclusive"]),
  language: z.string(),
  code: z.string(),
  environment_name: z.string(),
  kernel_name: z.string(),
  kernel_id: z.string().optional(),
  incarnation: z.number().int().positive().optional(),
  interpreter: z.object({ name: z.string(), binary: z.string(), version: z.string().optional() }).optional(),
  created_at: z.string(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  result: z
    .object({
      summary: z.string(),
      stdout: z.string(),
      stderr: z.string(),
      error: z.string(),
      output_count: z.number().int().nonnegative(),
    })
    .optional(),
  resources: z
    .object({
      cpu_percent: z.number().optional(),
      memory_bytes: z.number().int().nonnegative().optional(),
      gpu_percent: z.number().optional(),
      vram_bytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
  files: FileRecord.array().default([]),
  provenance_id: z.string().optional(),
  message_id: z.string().optional(),
  call_id: z.string().optional(),
  owner: z.object({ pid: z.number().int().positive(), boot: z.string(), token: z.string().optional() }),
})
type JournalRecord = z.infer<typeof JournalRecord>

const owner = { ...KernelProcessIdentity.current(), boot: crypto.randomUUID() }
const journalPrefix = (projectID: string, sessionID?: string) => [
  "execution_history",
  projectID,
  ...(sessionID ? [sessionID] : []),
]
const journalKey = (projectID: string, sessionID: string, sequence: number) => [
  ...journalPrefix(projectID, sessionID),
  sequence.toString().padStart(12, "0"),
]

async function journal(projectID: string, sessionID?: string) {
  const paths = await Storage.list(journalPrefix(projectID, sessionID))
  const records = await Promise.all(
    paths.map((key) =>
      Storage.read<unknown>(key)
        .then((raw) => JournalRecord.safeParse(raw))
        .then((parsed) => (parsed.success ? parsed.data : undefined))
        .catch(() => undefined),
    ),
  )
  return records
    .filter((record): record is JournalRecord => Boolean(record))
    .filter((record) => record.project_id === projectID && (!sessionID || record.session_id === sessionID))
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function orphaned(record: JournalRecord) {
  if (record.owner.boot === owner.boot) return false
  if (record.owner.pid === process.pid) return true
  if (record.owner.token) {
    return !KernelProcessIdentity.matchesRecorded({
      pid: record.owner.pid,
      startedAt: 0,
      token: record.owner.token,
    })
  }
  return !processAlive(record.owner.pid)
}

function fileRecords(files: ProvenanceEnvelope.Output[]) {
  return files.flatMap((file) =>
    file.path.status === "available" ? [{ path: file.path.value, sha256: file.sha256, size: file.size }] : [],
  )
}

function fromJournal(record: JournalRecord): ExecutionRecord {
  const started = record.started_at ? Date.parse(record.started_at) : undefined
  const completed = record.completed_at ? Date.parse(record.completed_at) : undefined
  return ExecutionRecord.parse({
    id: record.id,
    session_id: record.session_id,
    sequence: record.sequence,
    status: record.status,
    language: record.language,
    code: present(record.code),
    environment: {
      name: present(record.environment_name),
      interpreter: record.interpreter
        ? present({
            name: record.interpreter.name,
            binary: record.interpreter.binary,
            version: present(record.interpreter.version),
          })
        : present(undefined),
      kernel_id: present(record.kernel_id),
      incarnation: present(record.incarnation),
      restart_boundary: false,
    },
    timing: {
      created_at: present(record.created_at),
      started_at: present(record.started_at),
      completed_at: present(record.completed_at),
      duration_ms: present(
        started !== undefined && completed !== undefined && Number.isFinite(started) && Number.isFinite(completed)
          ? Math.max(0, completed - started)
          : undefined,
      ),
    },
    result: record.result ?? { summary: "", stdout: "", stderr: "", error: "", output_count: 0 },
    resources: record.resources ? present(record.resources) : present(undefined),
    files: record.files,
    artifacts: [],
    provenance_id: record.provenance_id ?? null,
    ...(record.message_id ? { message_id: record.message_id } : {}),
    ...(record.call_id ? { call_id: record.call_id } : {}),
  })
}

export namespace ExecutionHistory {
  const Sequence = z.number().int().positive()

  /** Persist the exact submission before interpreter startup or queue entry.
   * Separate Python/R queues can share timestamps, so time cannot be the
   * durable source of truth for order; this journal also survives a backend
   * crash before terminal provenance can be written. */
  export async function submit(input: {
    sessionID: string
    language: string
    environmentName: string
    kernelName: string
    code: string
    messageID?: string
    callID?: string
  }) {
    const sequence = await Storage.upsert<{ next: number }>(
      ["execution_sequence", Instance.project.id, input.sessionID],
      (current) => ({ next: (current?.next ?? 0) + 1 }),
    ).then((current) => Sequence.parse(current.next))
    const record = JournalRecord.parse({
      version: 1,
      id: `execution-${crypto.randomUUID()}`,
      project_id: Instance.project.id,
      session_id: input.sessionID,
      sequence,
      status: "queued",
      language: input.language,
      code: OpenScience.redactSecrets(input.code),
      environment_name: input.environmentName,
      kernel_name: input.kernelName,
      created_at: new Date().toISOString(),
      files: [],
      ...(input.messageID ? { message_id: input.messageID } : {}),
      ...(input.callID ? { call_id: input.callID } : {}),
      owner,
    })
    await Storage.write(journalKey(record.project_id, record.session_id, record.sequence), record)
    return record
  }

  /** Mark the exact queue-start boundary. The language runtime awaits this
   * write before it sends submitted code to the interpreter process. */
  export async function start(
    record: Pick<JournalRecord, "project_id" | "session_id" | "sequence">,
    input: {
      startedAt: number
      kernelID: string
      incarnation?: number | null
      environment?: KernelEnvironment | null
    },
  ) {
    return Storage.upsert<JournalRecord>(
      journalKey(record.project_id, record.session_id, record.sequence),
      (current) => {
        const value = JournalRecord.parse(current)
        if (value.status !== "queued" && value.status !== "running") return value
        return JournalRecord.parse({
          ...value,
          status: "running",
          started_at: new Date(input.startedAt).toISOString(),
          kernel_id: input.kernelID,
          ...(input.incarnation ? { incarnation: input.incarnation } : {}),
          ...(input.environment?.interpreter ? { interpreter: input.environment.interpreter } : {}),
          owner,
        })
      },
    )
  }

  /** Persist terminal state before provenance graph construction. A later
   * link() attaches the graph id, so graph failure cannot erase the result. */
  export async function complete(
    record: Pick<JournalRecord, "project_id" | "session_id" | "sequence">,
    input: {
      status: "succeeded" | "failed" | "cancelled" | "interrupted" | "inconclusive"
      completedAt: number
      summary?: string
      stdout?: string
      stderr?: string
      error?: string
      outputCount?: number
      resources?: KernelMetrics.Sample
      files?: ProvenanceEnvelope.Output[]
    },
  ) {
    return Storage.upsert<JournalRecord>(
      journalKey(record.project_id, record.session_id, record.sequence),
      (current) => {
        const value = JournalRecord.parse(current)
        return JournalRecord.parse({
          ...value,
          status: input.status,
          completed_at: new Date(input.completedAt).toISOString(),
          result: {
            summary: OpenScience.redactSecrets(input.summary ?? ""),
            stdout: OpenScience.redactSecrets(input.stdout ?? ""),
            stderr: OpenScience.redactSecrets(input.stderr ?? ""),
            error: OpenScience.redactSecrets(input.error ?? ""),
            output_count: input.outputCount ?? 0,
          },
          ...(input.resources && Object.keys(input.resources).length ? { resources: input.resources } : {}),
          files: fileRecords(input.files ?? []),
          owner,
        })
      },
    )
  }

  export async function link(
    record: Pick<JournalRecord, "project_id" | "session_id" | "sequence">,
    provenanceID: string,
  ) {
    return Storage.upsert<JournalRecord>(journalKey(record.project_id, record.session_id, record.sequence), (current) =>
      JournalRecord.parse({ ...JournalRecord.parse(current), provenance_id: provenanceID }),
    )
  }

  /** Convert records owned by a dead backend into explicit interrupted
   * terminals. Restore and history reads both call this idempotently. */
  export async function recover(projectID: string, sessionID?: string) {
    const records = await journal(projectID, sessionID)
    let recovered = 0
    for (const record of records) {
      if ((record.status !== "queued" && record.status !== "running") || !orphaned(record)) continue
      await Storage.write(
        journalKey(record.project_id, record.session_id, record.sequence),
        JournalRecord.parse({
          ...record,
          status: "interrupted",
          completed_at: new Date().toISOString(),
          result: {
            summary: "Execution interrupted during backend recovery",
            stdout: "",
            stderr: "",
            error: "The OpenScience backend stopped before this execution recorded a terminal result.",
            output_count: 0,
          },
          owner,
        }),
      )
      recovered += 1
    }
    return recovered
  }

  /** Test-only crash injection without weakening production recovery rules. */
  export async function orphanForTests(sessionID: string, sequence: number) {
    const key = journalKey(Instance.project.id, sessionID, sequence)
    await Storage.upsert<JournalRecord>(key, (current) =>
      JournalRecord.parse({ ...JournalRecord.parse(current), owner: { pid: 2_147_483_647, boot: "dead-backend" } }),
    )
  }

  export async function list(scope: Scope, sessionID?: string): Promise<ExecutionRecord[]> {
    await recover(scope.projectID, sessionID)
    const durable = await journal(scope.projectID, sessionID)
    const graph = await Provenance.project(scope)
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
    const runs = graph.nodes
      .filter((node): node is Run => node.kind === "run" && "tool" in node && Boolean(node.provenance))
      .filter((run) => !sessionID || run.sessionID === sessionID)
      .sort((a, b) => {
        const leftSequence = Sequence.safeParse(a.meta?.executionSequence)
        const rightSequence = Sequence.safeParse(b.meta?.executionSequence)
        if (leftSequence.success && rightSequence.success && a.sessionID === b.sessionID) {
          return leftSequence.data - rightSequence.data
        }
        const left = time(a.provenance?.timestamps.started_at) ?? Date.parse(a.recordedAt)
        const right = time(b.provenance?.timestamps.started_at) ?? Date.parse(b.recordedAt)
        return left - right || a.id.localeCompare(b.id)
      })

    const count = new Map<string, number>()
    const completed = runs.map((run) => {
      const envelope = run.provenance!
      const kernel = value(envelope.environment.kernel)
      const kernelID = kernel?.id
      const session = run.sessionID ?? value(envelope.identity.session_id) ?? "unknown"
      const storedSequence = Sequence.safeParse(run.meta?.executionSequence)
      const sequence = storedSequence.success ? storedSequence.data : (count.get(session) ?? 0) + 1
      count.set(session, sequence)
      const started = time(envelope.timestamps.started_at)
      const completed = time(envelope.timestamps.completed_at)
      const files = envelope.outputs.items.flatMap((item) => {
        const filepath = value(item.path)
        return filepath ? [{ path: filepath, sha256: item.sha256, size: item.size }] : []
      })
      return ExecutionRecord.parse({
        id: value(envelope.identity.run_id) ?? run.id,
        session_id: session,
        sequence,
        status: envelope.outputs.status,
        language: kernel?.language ?? (typeof run.inputs?.language === "string" ? run.inputs.language : run.tool),
        code: envelope.input.code,
        environment: {
          name: kernel?.environment_name ?? present(undefined),
          interpreter: kernel?.interpreter ?? present(undefined),
          kernel_id: present(kernelID),
          incarnation: kernel?.incarnation ?? present(undefined),
          restart_boundary: false,
        },
        timing: {
          created_at: envelope.timestamps.created_at,
          started_at: envelope.timestamps.started_at,
          completed_at: envelope.timestamps.completed_at,
          duration_ms: present(
            started !== undefined && completed !== undefined ? Math.max(0, completed - started) : undefined,
          ),
        },
        result: {
          summary: text(run.meta?.result),
          stdout: text(run.meta?.stdout),
          stderr: text(run.meta?.stderr),
          error: text(run.meta?.error),
          output_count: envelope.outputs.items.length,
        },
        resources: resource(run.meta?.resources),
        files,
        artifacts: artifacts(run, nodes, graph.edges),
        provenance_id: run.id,
        ...(typeof run.meta?.messageID === "string" ? { message_id: run.meta.messageID } : {}),
        ...(typeof run.meta?.callID === "string" ? { call_id: run.meta.callID } : {}),
      })
    })

    // A terminal provenance node supersedes its journal snapshot. Nonterminal
    // and provenance-failure records stay visible from the durable journal.
    const merged = new Map(durable.map((record) => [`${record.session_id}\0${record.sequence}`, fromJournal(record)]))
    const legacy: ExecutionRecord[] = []
    for (const [index, record] of completed.entries()) {
      const run = runs[index]!
      const sequence = Sequence.safeParse(run.meta?.executionSequence)
      if (!sequence.success) {
        legacy.push(record)
        continue
      }
      merged.set(`${record.session_id}\0${sequence.data}`, record)
    }

    const ordered = [...legacy, ...merged.values()].sort((left, right) => {
      if (left.session_id === right.session_id) return left.sequence - right.sequence || left.id.localeCompare(right.id)
      const leftTime = time(left.timing.created_at) ?? 0
      const rightTime = time(right.timing.created_at) ?? 0
      return leftTime - rightTime || left.id.localeCompare(right.id)
    })

    const previous = new Map<string, number | undefined>()
    return ordered.map((record) => {
      const kernelID = value(record.environment.kernel_id)
      const incarnation = value(record.environment.incarnation)
      const key = kernelID ?? `execution:${record.id}`
      const seen = previous.has(key)
      const restart = seen && previous.get(key) !== incarnation
      previous.set(key, incarnation)
      return { ...record, environment: { ...record.environment, restart_boundary: restart } }
    })
  }
}
