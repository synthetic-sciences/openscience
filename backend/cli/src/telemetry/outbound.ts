import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import z from "zod"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { Installation } from "@/installation"
import { OpenScience, API_BASE } from "@/openscience"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import type { MessageV2 } from "@/session/message-v2"
import { FileLease } from "@/util/file-lease"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"

const log = Log.create({ service: "telemetry.outbound" })
const VERSION = 2 as const
export const CONSENT_VERSION = "openscience-trace-v3-2026-08-26"
const MAX_EVENTS = 4096
const MAX_QUEUE_BYTES = 64 * 1024 * 1024
const MAX_BATCH_EVENTS = 64
const MAX_BATCH_BYTES = 4 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 512 * 1024
const MAX_STRING_BYTES = 128 * 1024
const MAX_CONTAINER_ITEMS = 512
const MAX_NESTING_DEPTH = 32
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000
const DELETION_PROOF_DOMAIN = "openscience-telemetry-delete:v2"
const SUBJECT_DOMAIN = "openscience-telemetry-subject:v1"
const LEGACY_CONSENT_EPOCH = "0".repeat(32)
const consentPath = path.join(Global.Path.data, "telemetry-consent-v2.json")
const queuePath = path.join(Global.Path.data, "telemetry-queue-v2.jsonl")
const deadPath = path.join(Global.Path.data, "telemetry-dead-letter-v2.jsonl")
const stateLeasePath = path.join(Global.Path.data, "telemetry-state-v2.lock")
const consentSyncLeasePath = path.join(Global.Path.data, "telemetry-consent-sync-v2.lock")
const legacyConsentPath = path.join(Global.Path.data, "telemetry-consent-v1.json")
const legacyQueuePath = path.join(Global.Path.data, "telemetry-queue-v1.jsonl")

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const captureTasks = new Set<Promise<unknown>>()
const backgroundFlushes = new Map<string, Promise<void>>()
const backgroundFlushPending = new Set<string>()

function trackCapture<T>(task: Promise<T>): Promise<T> {
  captureTasks.add(task)
  void task.finally(() => captureTasks.delete(task)).catch(() => undefined)
  return task
}

function scheduleFlush(subject: string) {
  if (backgroundFlushes.has(subject)) {
    // The active pass selected its rows before this append. Remember exactly
    // one follow-up pass so a terminal event cannot remain queued until a
    // later append or process shutdown. A Set intentionally bounds retries:
    // an offline follow-up does not schedule itself again.
    backgroundFlushPending.add(subject)
    return
  }
  const task = OutboundTelemetry.flush(subject).catch(() => undefined)
  backgroundFlushes.set(subject, task)
  void task
    .finally(() => {
      if (backgroundFlushes.get(subject) !== task) return
      backgroundFlushes.delete(subject)
      if (backgroundFlushPending.delete(subject)) scheduleFlush(subject)
    })
    .catch(() => undefined)
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)
const Label = z.string().min(1).max(512)
const Hex = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`))
const Platform = z.enum(["macos", "windows", "linux", "unknown"])
const ModelRoute = z.enum(["managed", "byok", "chatgpt", "subscription", "local", "custom"])
const AtlasIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/)

export const EVENT_TYPES = [
  "session.started",
  "session.completed",
  "user.message",
  "model.request",
  "model.response",
  "model.usage",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "search.started",
  "search.completed",
  "search.failed",
  "artifact.completed",
  "error",
  "retry",
] as const

export const Event = z
  .object({
    event_id: z.string().uuid(),
    schema_version: z.literal(VERSION),
    event_type: z.enum(EVENT_TYPES),
    occurred_at: z.string().datetime(),
    trace_id: Hex(32),
    span_id: Hex(16),
    parent_span_id: Hex(16).optional(),
    app_version: Label.optional(),
    platform: Platform.optional(),
    architecture: Label.optional(),
    locale: Label.optional(),
    timezone: Label.optional(),
    installation_id: z.string().uuid(),
    session_id: Label.optional(),
    run_id: Label.optional(),
    model_route: ModelRoute.optional(),
    provider_id: AtlasIdentifier.optional(),
    model_id: AtlasIdentifier.optional(),
    payload: z.record(z.string(), JsonValueSchema),
  })
  .strict()

export type Event = z.infer<typeof Event>
export type EventType = Event["event_type"]

const ConsentEntry = z.object({
  analytics_enabled: z.boolean(),
  research_content_enabled: z.boolean(),
  user_owned_content_enabled: z.boolean().default(true),
  updated_at: z.string().datetime(),
  pending: z.boolean().optional(),
  generation: Hex(32).optional(),
  consent_epoch: Hex(32).optional(),
  deletion_proof: z
    .string()
    .regex(/^odp_v2\.[a-f0-9]{10,138}\.[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/)
    .optional(),
})

const ConsentFile = z.object({
  schema_version: z.literal(VERSION),
  consent_version: z.string(),
  installation_id: z.string().uuid(),
  active_subject: z.string().optional(),
  subjects: z.record(z.string(), ConsentEntry),
})
type ConsentFile = z.infer<typeof ConsentFile>

const LegacyConsentFile = z.object({
  schema_version: z.literal(1),
  installation_id: z.string().uuid().optional(),
  active_subject: z.string().optional(),
  subjects: z.record(
    z.string(),
    z.object({
      analytics_enabled: z.boolean(),
      updated_at: z.string().datetime().optional(),
    }),
  ),
})

const QueueRow = z.object({ subject: z.string(), queued_at: z.number().int(), event: Event })
type QueueRow = z.infer<typeof QueueRow>

const DeadRow = z.object({
  subject: z.string(),
  failed_at: z.number().int(),
  status: z.number().int(),
  reason: z.string(),
  event: Event,
})
type DeadRow = z.infer<typeof DeadRow>

const queueCache: { signature?: string; rows: number } = { rows: 0 }

export type Status = {
  analyticsEnabled: boolean
  researchContentEnabled: boolean
  userOwnedContentEnabled: boolean
  source: "default" | "account"
  signedIn: boolean
  consentVersion: string
  pending: boolean
  corrupt: boolean
  deletionAvailable: boolean
  queuedEvents: number
  quarantinedEvents: number
}

export type DrainResult = {
  captured: boolean
  flushed: boolean
  timedOut: boolean
  pendingEvents: number
}

export function coarsePlatform(value: string): z.infer<typeof Platform> {
  if (value === "darwin") return "macos"
  if (value === "win32") return "windows"
  if (value === "linux") return "linux"
  return "unknown"
}

export function coarseProviderFamily(value: string): string {
  return value.trim().toLowerCase() || "custom"
}

export function coarseModelFamily(value: string): string {
  return value.trim().toLowerCase() || "custom"
}

function fresh(): ConsentFile {
  return {
    schema_version: VERSION,
    consent_version: CONSENT_VERSION,
    installation_id: randomUUID(),
    subjects: {},
  }
}

function generation() {
  return randomBytes(16).toString("hex")
}

async function atomic(filepath: string, value: string): Promise<void> {
  await using operation = await DataRootBarrier.enter(filepath)
  using _ = await Lock.write(filepath)
  const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  try {
    const handle = await fs.open(temporary, "wx", 0o600)
    await handle
      .writeFile(value, "utf8")
      .then(() => handle.sync())
      .finally(() => handle.close())
    await fs.rename(temporary, filepath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function withStateLease<T>(operation: () => Promise<T>): Promise<T> {
  await using lease = await FileLease.acquire(stateLeasePath, 30_000)
  return lease.during(operation)
}

async function withConsentSyncLease<T>(operation: () => Promise<T>): Promise<T> {
  await using lease = await FileLease.acquire(consentSyncLeasePath, 30_000)
  return lease.during(operation)
}

async function readConsent(): Promise<{ value: ConsentFile; absent: boolean; corrupt: boolean }> {
  if (!(await Bun.file(consentPath).exists())) return { value: fresh(), absent: true, corrupt: false }
  try {
    return { value: ConsentFile.parse(await Bun.file(consentPath).json()), absent: false, corrupt: false }
  } catch (error) {
    log.warn("OpenScience data-use setting is unreadable; upload is disabled", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { value: fresh(), absent: false, corrupt: true }
  }
}

/** Return only the non-secret identifier embedded in a Gateway API key. */
export function telemetryKeyID(value: string): string | undefined {
  const match = /^(thk_[0-9a-f]{32})\.[A-Za-z0-9_-]{16,}$/i.exec(value)
  return match?.[1].toLowerCase()
}

/** Match the exact non-secret prefix persisted with both current and legacy
 * Gateway keys. The secret portion is never used as a locator. */
export function telemetryKeyPrefix(value: string): string | undefined {
  const current = /^thk_([0-9a-f]{32})\.[A-Za-z0-9_-]+$/i.exec(value)
  if (current) return `thk_${current[1].slice(0, 8).toLowerCase()}`
  return /^(thk_[A-Za-z0-9_-]{1,64})\.[A-Za-z0-9_-]+$/.exec(value)?.[1]
}

/** Create a deletion-only capability without retaining the raw credential or
 * Atlas's reusable API-key hash. Atlas verifies it against the stored hash and
 * consumes the key-bound capability exactly once. */
export function telemetryDeletionProof(
  value: string,
  consentEpoch = LEGACY_CONSENT_EPOCH,
  nonceHex = randomBytes(16).toString("hex"),
): string | undefined {
  const prefix = telemetryKeyPrefix(value)
  if (!prefix || !/^[a-f0-9]{32}$/.test(consentEpoch || "") || !/^[a-f0-9]{32}$/.test(nonceHex)) {
    return undefined
  }
  const prefixHex = Buffer.from(prefix, "utf8").toString("hex")
  // The input is an authenticated, server-issued random API credential, not a
  // human password. Atlas stores this exact SHA-256 verifier, so a password KDF
  // would break cross-repository proof verification.
  // codeql[js/insufficient-password-hash]
  const keyHash = createHash("sha256").update(value).digest()
  const message = `${DELETION_PROOF_DOMAIN}\n${prefixHex}\n${consentEpoch}\n${nonceHex}`
  // This HMAC is a domain-separated, one-shot deletion capability keyed by the
  // API-key verifier; it is never used as a password verifier or persisted raw.
  // codeql[js/insufficient-password-hash]
  const mac = createHmac("sha256", keyHash).update(message).digest("hex")
  return `odp_v2.${prefixHex}.${consentEpoch}.${nonceHex}.${mac}`
}

function subjectForSession(session: { api_key: string; user_id?: string }) {
  // Older pasted-key sessions did not persist a user_id. A domain-separated
  // HMAC gives each such login a stable local subject without persisting the
  // raw credential or Atlas's reusable SHA-256 authentication hash.
  const account =
    session.user_id ||
    telemetryKeyID(session.api_key) ||
    // The server-issued random API credential is pseudonymized for local queue
    // partitioning only. This is not password storage or authentication.
    // codeql[js/insufficient-password-hash]
    `key-subject-v1:${createHmac("sha256", SUBJECT_DOMAIN).update(session.api_key).digest("hex")}`
  return `account:${account}`
}

async function identity() {
  const session = await OpenScience.getSession().catch(() => null)
  if (!session) return { subject: "signed-out", signedIn: false, token: undefined as string | undefined }
  return {
    subject: subjectForSession(session),
    signedIn: true,
    token: session.api_key,
  }
}

async function identityIsCurrent(expected: Awaited<ReturnType<typeof identity>>) {
  const current = await identity()
  return (
    current.signedIn === expected.signedIn && current.subject === expected.subject && current.token === expected.token
  )
}

async function migrateLegacy(state: ConsentFile, subject: string): Promise<boolean> {
  if (!(await Bun.file(legacyConsentPath).exists())) return false
  const legacy = await Bun.file(legacyConsentPath)
    .json()
    .then((value) => LegacyConsentFile.parse(value))
    .catch(() => undefined)
  if (!legacy) return false
  const previous =
    legacy.subjects[subject] ?? (legacy.active_subject ? legacy.subjects[legacy.active_subject] : undefined)
  if (!previous) return false
  const enabled = previous.analytics_enabled === true
  state.subjects[subject] = {
    // Preserve an explicit legacy opt-out. Accounts that left the old default
    // enabled inherit the disclosed default-on trajectory setting; otherwise
    // nearly every upgrading user would silently become off despite the
    // account contract and Settings UI both saying the feature is on by
    // default.
    analytics_enabled: enabled,
    research_content_enabled: enabled,
    user_owned_content_enabled: true,
    updated_at: new Date().toISOString(),
    pending: false,
    generation: generation(),
  }
  return true
}

async function ensureSubject(state: ConsentFile, subject: string, token?: string) {
  let changed = false
  if (token) {
    // Recompute the retired local subject key solely to migrate and delete it.
    // Matching the legacy SHA-256 identifier is required; it is not an auth
    // verifier, and the value is removed rather than newly persisted.
    // codeql[js/insufficient-password-hash]
    const legacySubject = `account:key-sha256:${createHash("sha256").update(token).digest("hex")}`
    const legacy = state.subjects[legacySubject]
    if (legacy) {
      const current = state.subjects[subject]
      const legacyIsTombstone =
        legacy.pending === true && (!legacy.analytics_enabled || !legacy.research_content_enabled)
      if (!current || legacyIsTombstone) state.subjects[subject] = legacy
      delete state.subjects[legacySubject]
      if (state.active_subject === legacySubject) state.active_subject = subject
      changed = true
    }
  }
  const existing = state.subjects[subject]
  if (existing) {
    if (existing.generation) return changed
    existing.generation = generation()
    return true
  }
  const migrated = await migrateLegacy(state, subject)
  if (!migrated) {
    state.subjects[subject] = {
      analytics_enabled: true,
      research_content_enabled: true,
      user_owned_content_enabled: true,
      updated_at: new Date().toISOString(),
      // New authenticated accounts inherit the disclosed server default via
      // GET. Only an explicit switch action is persisted with PUT.
      pending: false,
      generation: generation(),
    }
  }
  return true
}

function parseRows(text: string): QueueRow[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [QueueRow.parse(JSON.parse(line))]
      } catch {
        return []
      }
    })
}

async function rawRows(): Promise<QueueRow[]> {
  return parseRows(await fs.readFile(queuePath, "utf8").catch(() => ""))
}

function queueSignature(stat: Awaited<ReturnType<typeof fs.stat>>) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function cacheQueue(stat: Awaited<ReturnType<typeof fs.stat>> | undefined, rows: number) {
  queueCache.signature = stat ? queueSignature(stat) : undefined
  queueCache.rows = rows
}

async function queueStateLocked() {
  const stat = await fs.stat(queuePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stat) {
    cacheQueue(undefined, 0)
    return { bytes: 0, rows: 0 }
  }
  const signature = queueSignature(stat)
  if (queueCache.signature === signature) return { bytes: stat.size, rows: queueCache.rows }
  const rows = await rawRows()
  cacheQueue(stat, rows.length)
  return { bytes: stat.size, rows: rows.length }
}

function boundedRows(input: QueueRow[]) {
  const capped = input.slice(-MAX_EVENTS)
  const kept: QueueRow[] = []
  let bytes = 0
  for (const row of capped.toReversed()) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (kept.length && bytes + size > MAX_QUEUE_BYTES) break
    kept.unshift(row)
    bytes += size
  }
  return kept
}

async function writeRows(input: QueueRow[]) {
  const selected = boundedRows(input)
  if (!selected.length) {
    await fs.rm(queuePath, { force: true }).catch(() => undefined)
    cacheQueue(undefined, 0)
    return
  }
  await atomic(queuePath, selected.map((item) => JSON.stringify(item)).join("\n") + "\n")
  cacheQueue(await fs.stat(queuePath), selected.length)
}

async function mutateRowsLocked(operation: (rows: QueueRow[]) => QueueRow[] | Promise<QueueRow[]>) {
  await writeRows(await operation(await rawRows()))
}

async function appendRowLocked(row: QueueRow) {
  const state = await queueStateLocked()
  await fs.mkdir(path.dirname(queuePath), { recursive: true })
  const appended = await (async () => {
    const handle = await fs.open(queuePath, "a+", 0o600)
    try {
      const prefix = await (async () => {
        if (!state.bytes) return ""
        const tail = Buffer.allocUnsafe(1)
        const read = await handle.read(tail, 0, 1, state.bytes - 1)
        return read.bytesRead === 1 && tail[0] !== 0x0a ? "\n" : ""
      })()
      const value = `${prefix}${JSON.stringify(row)}\n`
      const bytes = Buffer.byteLength(value)
      if (state.rows + 1 > MAX_EVENTS || state.bytes + bytes > MAX_QUEUE_BYTES) return false
      await handle.writeFile(value, "utf8")
      await handle.sync()
      cacheQueue(await handle.stat(), state.rows + 1)
      return true
    } finally {
      await handle.close()
    }
  })()
  if (appended) return
  await writeRows([...(await rawRows()), row])
}

async function activateLocked(state: ConsentFile, subject: string) {
  if (state.active_subject === subject) return false
  if (state.active_subject) {
    await mutateRowsLocked(() => [])
    await fs.rm(deadPath, { force: true }).catch(() => undefined)
  }
  state.active_subject = subject
  return true
}

function localStatus(
  state: ConsentFile,
  subject: string,
  signedIn: boolean,
  absent: boolean,
  corrupt: boolean,
): Status {
  const entry = state.subjects[subject]
  const enabled = signedIn && !corrupt && (entry?.analytics_enabled ?? false)
  return {
    analyticsEnabled: enabled,
    researchContentEnabled: enabled && (entry?.research_content_enabled ?? false),
    userOwnedContentEnabled: enabled && (entry?.user_owned_content_enabled ?? true),
    source: entry ? "account" : "default",
    signedIn,
    consentVersion: state.consent_version,
    pending: entry?.pending === true || (signedIn && absent),
    corrupt,
    deletionAvailable: signedIn,
    queuedEvents: 0,
    quarantinedEvents: 0,
  }
}

function consentDisabled(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const root = value as Record<string, unknown>
  const detail = root.detail && typeof root.detail === "object" && !Array.isArray(root.detail) ? root.detail : root
  return (detail as Record<string, unknown>).code === "telemetry_consent_disabled"
}

function userOwnedConsentDisabled(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const root = value as Record<string, unknown>
  const detail = root.detail && typeof root.detail === "object" && !Array.isArray(root.detail) ? root.detail : root
  return (detail as Record<string, unknown>).code === "user_owned_telemetry_consent_disabled"
}

async function disableSubjectLocked(state: ConsentFile, subject: string) {
  await mutateRowsLocked(() => [])
  await fs.rm(deadPath, { force: true }).catch(() => undefined)
  state.installation_id = randomUUID()
  state.subjects[subject] = {
    analytics_enabled: false,
    research_content_enabled: false,
    user_owned_content_enabled: false,
    updated_at: new Date().toISOString(),
    pending: false,
    generation: generation(),
  }
  await atomic(consentPath, JSON.stringify(state, null, 2))
}

type ConsentRequest = {
  subject: string
  token: string
  installation: string
  generation: string
  updatedAt: string
  analytics: boolean
  content: boolean
  userOwned: boolean
  pending: boolean
}

async function synchronizeConsent(who: Awaited<ReturnType<typeof identity>>) {
  // Snapshot the revision before waiting for the cross-process network lease.
  // If another waiter refreshes this same non-pending account first, its
  // committed generation lets us reuse that result instead of issuing the
  // same GET serially after the lease becomes available.
  const observed = await withStateLease(async () => {
    if (!(await identityIsCurrent(who))) return
    const consent = await readConsent()
    const entry = consent.value.subjects[who.subject]
    if (consent.corrupt || !entry) return
    return {
      subject: who.subject,
      installation: consent.value.installation_id,
      generation: entry.generation,
      updatedAt: entry.updated_at,
    }
  })
  return withConsentSyncLease(async () => {
    if (!who.token) return false
    const request = await withStateLease(async (): Promise<ConsentRequest | true | undefined> => {
      if (!(await identityIsCurrent(who))) return
      const consent = await readConsent()
      if (consent.corrupt) return
      const activated = await activateLocked(consent.value, who.subject)
      const ensured = await ensureSubject(consent.value, who.subject, who.token)
      if (activated || ensured) await atomic(consentPath, JSON.stringify(consent.value, null, 2))
      const entry = consent.value.subjects[who.subject]
      // A durable local opt-out is authoritative until the
      // user explicitly turns sharing back on in this client. A later GET must
      // never interpret a missing/default server row as permission.
      if (!entry.pending && (!entry.analytics_enabled || !entry.research_content_enabled)) return true
      return {
        subject: who.subject,
        token: who.token!,
        installation: consent.value.installation_id,
        generation: entry.generation!,
        updatedAt: entry.updated_at,
        analytics: entry.analytics_enabled,
        content: entry.research_content_enabled,
        userOwned: entry.user_owned_content_enabled,
        pending: entry.pending === true,
      }
    })
    if (request === true) return true
    if (!request) return false
    if (
      observed &&
      !request.pending &&
      observed.subject === request.subject &&
      observed.installation === request.installation &&
      (observed.generation !== request.generation || observed.updatedAt !== request.updatedAt)
    ) {
      return true
    }

    // Consent control-plane I/O must not stall trace capture. A dedicated
    // cross-process lease only coalesces consent reads/writes; the queue state
    // lease remains free while the request is on the network. The response can
    // commit only if subject, installation, and consent generation still match.
    const response = await fetch(`${API_BASE}/api/v1/telemetry/consent`, {
      method: request.pending ? "PUT" : "GET",
      headers: {
        Authorization: `Bearer ${request.token}`,
        Accept: "application/json",
        ...(request.pending ? { "Content-Type": "application/json" } : {}),
      },
      ...(request.pending
        ? {
            body: JSON.stringify({
              consent_version: CONSENT_VERSION,
              analytics_enabled: request.analytics,
              research_content_enabled: request.content,
              user_owned_content_enabled: request.userOwned,
              installation_id: request.installation,
            }),
          }
        : {}),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    if (!response) return false
    const body = (await response.json().catch(() => undefined)) as
      | {
          consent_version?: string
          analytics_enabled?: boolean
          research_content_enabled?: boolean
          user_owned_content_enabled?: boolean
          consent_epoch?: string
          effective?: {
            analytics_enabled?: boolean
            research_content_enabled?: boolean
            user_owned_content_enabled?: boolean
          }
        }
      | undefined

    return withStateLease(async () => {
      if (!(await identityIsCurrent(who))) return false
      const current = await readConsent()
      const entry = current.value.subjects[request.subject]
      if (
        current.corrupt ||
        current.value.active_subject !== request.subject ||
        current.value.installation_id !== request.installation ||
        entry?.generation !== request.generation ||
        entry.updated_at !== request.updatedAt ||
        entry.analytics_enabled !== request.analytics ||
        entry.research_content_enabled !== request.content ||
        entry.user_owned_content_enabled !== request.userOwned ||
        (entry.pending === true) !== request.pending
      ) {
        return false
      }
      if (!response.ok) {
        if (response.status === 403 && consentDisabled(body)) await disableSubjectLocked(current.value, request.subject)
        return false
      }
      const analytics = body?.analytics_enabled ?? body?.effective?.analytics_enabled ?? request.analytics
      const content = body?.research_content_enabled ?? body?.effective?.research_content_enabled ?? request.content
      const userOwned =
        body?.user_owned_content_enabled ?? body?.effective?.user_owned_content_enabled ?? request.userOwned
      if (typeof analytics !== "boolean" || typeof content !== "boolean" || typeof userOwned !== "boolean") return false
      if (!analytics || !content) {
        await disableSubjectLocked(current.value, request.subject)
        return true
      }
      current.value.consent_version = body?.consent_version || CONSENT_VERSION
      current.value.subjects[request.subject] = {
        analytics_enabled: true,
        research_content_enabled: true,
        user_owned_content_enabled: userOwned,
        updated_at: new Date().toISOString(),
        pending: false,
        generation: generation(),
        ...(/^[a-f0-9]{32}$/.test(body?.consent_epoch || "")
          ? { consent_epoch: body!.consent_epoch }
          : entry.consent_epoch
            ? { consent_epoch: entry.consent_epoch }
            : {}),
      }
      await atomic(consentPath, JSON.stringify(current.value, null, 2))
      return true
    })
  })
}

function digest(installationID: string, value: string, length: number) {
  return createHash("sha256").update(`${installationID}:${value}`).digest("hex").slice(0, length)
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = "… [truncated]"
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle) + suffix) <= maxBytes) low = middle
    else high = middle - 1
  }
  // Avoid leaving a dangling high surrogate at the truncation boundary.
  const prefix = value.slice(0, low).replace(/[\uD800-\uDBFF]$/, "")
  return prefix + suffix
}

/**
 * Normalize and bound in the same first traversal. In particular, do not use
 * Object.entries(...).map(...) or Array.map(...) here: both copy every child
 * before the later payload cap can protect us from hostile tool output.
 */
function toJson(value: unknown, seen = new WeakSet<object>(), depth = 0): JsonValue {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") return truncateUtf8(value, MAX_STRING_BYTES)
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return truncateUtf8(value.toString(), MAX_STRING_BYTES)
  if (typeof value === "undefined") return null
  if (typeof value === "function" || typeof value === "symbol") {
    return truncateUtf8(String(value), MAX_STRING_BYTES)
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return { type: "binary", byte_length: value.byteLength }
  if (depth >= MAX_NESTING_DEPTH) return "[Truncated: nesting depth]"
  if (typeof value !== "object") return truncateUtf8(String(value), MAX_STRING_BYTES)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  try {
    if (value instanceof Error) {
      return toJson({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, seen, depth)
    }
    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_CONTAINER_ITEMS)
      const result: JsonValue[] = []
      for (let index = 0; index < length; index++) result.push(toJson(value[index], seen, depth + 1))
      if (value.length > length) {
        result.push({ _openscience_truncated: true, omitted_items: value.length - length })
      }
      return result
    }
    const source = value as Record<string, unknown>
    const keys = Object.keys(source)
    const selected = keys.slice(0, MAX_CONTAINER_ITEMS)
    const result: Record<string, JsonValue> = {}
    for (const key of selected) result[truncateUtf8(key, MAX_STRING_BYTES)] = toJson(source[key], seen, depth + 1)
    if (keys.length > selected.length) {
      result._openscience_truncated = true
      result._openscience_omitted_fields = keys.length - selected.length
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function structurallyBound(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === "string") return truncateUtf8(value, MAX_STRING_BYTES)
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_NESTING_DEPTH) return "[Truncated: nesting depth]"
  if (Array.isArray(value)) {
    const selected = value.slice(0, MAX_CONTAINER_ITEMS).map((item) => structurallyBound(item, depth + 1))
    if (value.length > selected.length) {
      selected.push({ _openscience_truncated: true, omitted_items: value.length - selected.length })
    }
    return selected
  }
  const entries = Object.entries(value)
  const selected = entries.slice(0, MAX_CONTAINER_ITEMS)
  const result = Object.fromEntries(selected.map(([key, item]) => [key, structurallyBound(item, depth + 1)]))
  if (entries.length > selected.length) {
    result._openscience_truncated = true
    result._openscience_omitted_fields = entries.length - selected.length
  }
  return result
}

const DATABASE_URL_USERINFO =
  /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?):\/\/)[^@\s/]+@/gi
const AWS_ACCESS_KEY_ID = /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g
const AWS_CREDENTIAL =
  /(\b(?:aws_access_key_id|aws_secret_access_key|aws_session_token)\b\s*[:=]\s*)(["']?)([^"'\s,;}\]]{4,})\2/gi
const AUTH_OR_COOKIE_HEADER = /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]+/gi
const PEM_BLOCK = /-----BEGIN [A-Z0-9][A-Z0-9 -]*-----[\s\S]*?-----END [A-Z0-9][A-Z0-9 -]*-----/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const DELETION_PROOF_VALUE = /odp_v2\.[a-f0-9]{10,138}\.[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}/gi
const ENV_ASSIGNMENT =
  /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s#;\r\n]+)/gm
const INLINE_ENV_ASSIGNMENT =
  /(\b[A-Z_][A-Z0-9_]{1,}\s*=\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s#;\r\n]+)/g

function redactTelemetryText(value: string) {
  return value
    .replace(PEM_BLOCK, "[REDACTED]")
    .replace(DATABASE_URL_USERINFO, "$1[REDACTED]@")
    .replace(AUTH_OR_COOKIE_HEADER, "$1[REDACTED]")
    .replace(AWS_CREDENTIAL, "$1[REDACTED]")
    .replace(AWS_ACCESS_KEY_ID, "[REDACTED]")
    .replace(JWT, "[REDACTED]")
    .replace(DELETION_PROOF_VALUE, "[REDACTED]")
    .replace(ENV_ASSIGNMENT, "$1[REDACTED]")
    .replace(INLINE_ENV_ASSIGNMENT, "$1[REDACTED]")
}

function redactTelemetryJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactTelemetryText(value)
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(redactTelemetryJson)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactTelemetryJson(item)]))
}

function boundedPreview(value: JsonValue): Record<string, JsonValue> {
  const serialized = JSON.stringify(value)
  const originalBytes = Buffer.byteLength(serialized)
  let low = 0
  let high = serialized.length
  let result: Record<string, JsonValue> = {
    _openscience_truncated: true,
    original_byte_length: originalBytes,
    preview: "",
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = { ...result, preview: serialized.slice(0, middle) }
    if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_PAYLOAD_BYTES) {
      low = middle
      result = candidate
    } else {
      high = middle - 1
    }
  }
  return { ...result, preview: serialized.slice(0, low) }
}

async function safePayload(value: Record<string, unknown>) {
  // `toJson` imposes the structural bounds before scrubSecrets performs its
  // own recursive walk. The post-scrub pass covers raw logs and command text,
  // where secret-bearing headers and credential formats have no field name.
  const normalized = toJson(value) as Record<string, JsonValue>
  const scrubbed = (await OpenScience.scrubSecrets(normalized)) as Record<string, JsonValue>
  const redacted = redactTelemetryJson(scrubbed) as Record<string, JsonValue>
  const bounded = structurallyBound(redacted) as Record<string, JsonValue>
  return Buffer.byteLength(JSON.stringify(bounded)) <= MAX_PAYLOAD_BYTES ? bounded : boundedPreview(bounded)
}

function route(value: string | undefined): z.infer<typeof ModelRoute> | undefined {
  if (!value) return undefined
  const result = ModelRoute.safeParse(value.trim().toLowerCase())
  return result.success ? result.data : "custom"
}

/** Atlas stores provider/model labels under a deliberately narrow identifier
 * contract. Preserve ordinary IDs verbatim and replace invalid local labels
 * with a deterministic digest, so neither raw arbitrary text nor secrets can
 * leak through identifier fields. */
export function telemetryIdentifier(value: string): string {
  const trimmed = value.trim()
  if (AtlasIdentifier.safeParse(trimmed).success) return trimmed
  return `local:sha256:${createHash("sha256").update(value).digest("hex")}`
}

type TraceInput = {
  sessionID: string
  runID?: string
  spanKey?: string
  parentSpanID?: string
  route?: string
  provider?: string
  model?: string
  payload?: Record<string, unknown>
}

const routes = new Map<string, { route: z.infer<typeof ModelRoute>; provider?: string; model?: string }>()

function routeKey(input: Pick<TraceInput, "sessionID" | "runID">) {
  if (!input.runID) return input.sessionID
  return `${input.sessionID}\0${input.runID}`
}

function remember(input: TraceInput) {
  const value = route(input.route)
  if (!value) return
  const context = { route: value, provider: input.provider, model: input.model }
  routes.set(input.sessionID, context)
  if (input.runID) routes.set(routeKey(input), context)
}

function userOwned(value: z.infer<typeof ModelRoute> | undefined) {
  return value !== "managed"
}

function parseDeadRows(text: string): DeadRow[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [DeadRow.parse(JSON.parse(line))]
      } catch {
        return []
      }
    })
}

async function deadRows() {
  return parseDeadRows(await fs.readFile(deadPath, "utf8").catch(() => ""))
}

async function quarantine(rows: DeadRow[]) {
  if (!rows.length) return
  const selected = [...(await deadRows()), ...rows].slice(-MAX_EVENTS)
  await atomic(deadPath, selected.map((row) => JSON.stringify(row)).join("\n") + "\n")
}

async function appendUntracked(eventType: EventType, input: TraceInput) {
  const who = await identity()
  if (!who.signedIn) return false
  const payload = await safePayload(input.payload ?? {})
  const eventID = randomUUID()
  const spanKey = input.spanKey || eventID
  const intl = Intl.DateTimeFormat().resolvedOptions()
  const appended = await withStateLease(async () => {
    // Sanitization can take long enough for another process to opt out. The
    // authoritative consent check therefore happens after acquiring the same
    // lease used for the queue mutation, with a fresh disk read.
    if (!(await identityIsCurrent(who))) return false
    const consent = await readConsent()
    if (consent.corrupt) return false
    const activated = await activateLocked(consent.value, who.subject)
    const ensured = await ensureSubject(consent.value, who.subject, who.token)
    const changed = activated || ensured
    if (changed) await atomic(consentPath, JSON.stringify(consent.value, null, 2))
    const status = localStatus(consent.value, who.subject, true, consent.absent, false)
    if (!status.analyticsEnabled || !status.researchContentEnabled) return false
    const context = routes.get(routeKey(input)) ?? routes.get(input.sessionID)
    const known = route(input.route) ?? context?.route
    if (userOwned(known) && !status.userOwnedContentEnabled) return false
    const event = Event.parse({
      event_id: eventID,
      schema_version: VERSION,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      trace_id: digest(consent.value.installation_id, input.sessionID, 32),
      span_id: digest(consent.value.installation_id, spanKey, 16),
      ...(input.parentSpanID ? { parent_span_id: digest(consent.value.installation_id, input.parentSpanID, 16) } : {}),
      app_version: Installation.VERSION,
      platform: coarsePlatform(process.platform),
      architecture: process.arch,
      ...(intl.locale ? { locale: intl.locale } : {}),
      ...(intl.timeZone ? { timezone: intl.timeZone } : {}),
      installation_id: consent.value.installation_id,
      session_id: digest(consent.value.installation_id, input.sessionID, 32),
      ...(input.runID ? { run_id: input.runID } : {}),
      ...(known ? { model_route: known } : {}),
      ...(input.provider || context?.provider
        ? { provider_id: telemetryIdentifier(input.provider || context!.provider!) }
        : {}),
      ...(input.model || context?.model ? { model_id: telemetryIdentifier(input.model || context!.model!) } : {}),
      payload,
    })
    await appendRowLocked({ subject: who.subject, queued_at: Date.now(), event })
    return true
  })
  if (appended) scheduleFlush(who.subject)
  return appended
}

function append(eventType: EventType, input: TraceInput) {
  remember(input)
  return trackCapture(appendUntracked(eventType, input))
}

async function queuedForSubject(subject: string) {
  return withStateLease(async () => (await rawRows()).filter((row) => row.subject === subject).length)
}

async function settleBefore(task: Promise<unknown>, deadline: number) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return false
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    handle = setTimeout(() => resolve(false), remaining)
    handle.unref?.()
  })
  const settled = task.then(
    () => true as const,
    () => true as const,
  )
  const result = await Promise.race([settled, timeout])
  if (handle) clearTimeout(handle)
  return result
}

function selectedBatch(rows: QueueRow[]) {
  const selected: QueueRow[] = []
  let bytes = 0
  for (const row of rows.slice(0, MAX_BATCH_EVENTS)) {
    const size = Buffer.byteLength(JSON.stringify(row.event))
    if (size > MAX_BATCH_BYTES) continue
    if (selected.length && bytes + size > MAX_BATCH_BYTES) break
    selected.push(row)
    bytes += size
  }
  return selected
}

const PERMANENT_BATCH_REJECTIONS = new Set([400, 413, 415, 422])

type DeliveryResult = {
  completed: Set<string>
  quarantined: Map<string, { status: number; reason: string }>
  consentDisabled: boolean
  userOwnedDisabled: boolean
}

function emptyDelivery(): DeliveryResult {
  return { completed: new Set(), quarantined: new Map(), consentDisabled: false, userOwnedDisabled: false }
}

function mergeDelivery(left: DeliveryResult, right: DeliveryResult): DeliveryResult {
  return {
    completed: new Set([...left.completed, ...right.completed]),
    quarantined: new Map([...left.quarantined, ...right.quarantined]),
    consentDisabled: left.consentDisabled || right.consentDisabled,
    userOwnedDisabled: left.userOwnedDisabled || right.userOwnedDisabled,
  }
}

async function deliverTelemetryRows(rows: QueueRow[], token: string, installationID: string): Promise<DeliveryResult> {
  const deliveryID = randomUUID()
  const response = await fetch(`${API_BASE}/api/v1/telemetry/batches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    },
    body: new Uint8Array(
      gzipSync(
        JSON.stringify({
          schema_version: VERSION,
          consent_version: CONSENT_VERSION,
          delivery_id: deliveryID,
          installation_id: installationID,
          events: rows.map((row) => row.event),
        }),
      ),
    ),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response) return emptyDelivery()

  const body = (await response.json().catch(() => undefined)) as
    | { accepted?: string[]; replayed?: string[] }
    | undefined
  if (response.ok) {
    const hasAcknowledgements = Array.isArray(body?.accepted) || Array.isArray(body?.replayed)
    return {
      completed: new Set(
        hasAcknowledgements
          ? [...(body?.accepted ?? []), ...(body?.replayed ?? [])]
          : rows.map((row) => row.event.event_id),
      ),
      quarantined: new Map(),
      consentDisabled: false,
      userOwnedDisabled: false,
    }
  }
  if (response.status === 403 && consentDisabled(body)) {
    return { ...emptyDelivery(), consentDisabled: true }
  }
  if (response.status === 403 && userOwnedConsentDisabled(body)) {
    const privateRows = rows.filter((row) => row.event.model_route !== "managed")
    const managedRows = rows.filter((row) => row.event.model_route === "managed")
    const managed = managedRows.length
      ? await deliverTelemetryRows(managedRows, token, installationID)
      : emptyDelivery()
    return {
      ...managed,
      completed: new Set([...managed.completed, ...privateRows.map((row) => row.event.event_id)]),
      userOwnedDisabled: true,
    }
  }
  if (!PERMANENT_BATCH_REJECTIONS.has(response.status)) return emptyDelivery()

  // A schema or size failure identifies the batch, not the offending row.
  // Bisect until the bad singleton is isolated. Valid siblings are delivered
  // immediately and the permanently rejected event is preserved in a local
  // quarantine with the server response for diagnosis and recovery.
  if (rows.length === 1) {
    const reason = JSON.stringify(body ?? { code: "telemetry_rejected" }).slice(0, 2_048)
    log.warn("quarantining permanently rejected telemetry event", {
      event_id: rows[0].event.event_id,
      status: response.status,
    })
    return {
      completed: new Set(),
      quarantined: new Map([[rows[0].event.event_id, { status: response.status, reason }]]),
      consentDisabled: false,
      userOwnedDisabled: false,
    }
  }
  const middle = Math.ceil(rows.length / 2)
  const left = await deliverTelemetryRows(rows.slice(0, middle), token, installationID)
  if (left.consentDisabled) return left
  const right = await deliverTelemetryRows(rows.slice(middle), token, installationID)
  return mergeDelivery(left, right)
}

const searchTools = new Set(["research_search", "science_search", "websearch"])

export namespace OutboundTelemetry {
  /** Account login replacement and logout share this local boundary. Purge
   * every queued row before another account can become active and rotate the
   * installation id so future trace/session digests cannot link across it. */
  export async function resetAccountSession(): Promise<void> {
    await withStateLease(async () => {
      const consent = await readConsent()
      const state = consent.corrupt ? fresh() : consent.value
      state.installation_id = randomUUID()
      state.active_subject = undefined
      routes.clear()
      await mutateRowsLocked(() => [])
      await fs.rm(deadPath, { force: true }).catch(() => undefined)
      await fs.rm(legacyQueuePath, { force: true }).catch(() => undefined)
      await atomic(consentPath, JSON.stringify(state, null, 2))
    })
  }

  /** Initialize the authenticated account's default-on setting and retry any
   * durable consent write. A fresh enabled subject performs one bounded GET to
   * inherit an existing account choice and materialize its consent epoch. */
  export async function initializeAccount(options: { synchronize?: boolean } = {}): Promise<void> {
    const who = await identity()
    if (!who.signedIn) {
      if (options.synchronize !== false) await OutboundTelemetry.retryPendingConsent().catch(() => false)
      return
    }
    const requiresAuthoritativeRefresh = await withStateLease(async () => {
      if (!(await identityIsCurrent(who))) return
      const consent = await readConsent()
      if (consent.corrupt) consent.value = fresh()
      const activated = await activateLocked(consent.value, who.subject)
      const ensured = await ensureSubject(consent.value, who.subject, who.token)
      const changed = activated || ensured
      if (changed || consent.corrupt) await atomic(consentPath, JSON.stringify(consent.value, null, 2))
      await fs.rm(legacyQueuePath, { force: true }).catch(() => undefined)
      const entry = consent.value.subjects[who.subject]
      // consent_epoch is minted by the authenticated server GET/PUT. A
      // default-on entry without it is only a local disclosed default, so it
      // must be reconciled before normal startup permits capture. Durable local
      // opt-outs stay authoritative and pending choices use the PUT retry path.
      return (
        entry?.analytics_enabled === true &&
        entry.research_content_enabled === true &&
        entry.pending !== true &&
        !entry.consent_epoch
      )
    })
    if (options.synchronize !== false) {
      await OutboundTelemetry.retryPendingConsent().catch(() => false)
      if (requiresAuthoritativeRefresh) await synchronizeConsent(who).catch(() => false)
    }
  }

  /** Preserve the active account's local setting when a legacy session gains
   * its canonical user id without changing credentials. Keep the old alias as
   * well: another already-running process can still observe the legacy
   * session, and it must not recreate default-on consent during the handoff. */
  export async function preserveConsentForSession(next: { api_key: string; user_id?: string }): Promise<boolean> {
    const who = await identity()
    if (!who.token || who.token !== next.api_key) return false
    const nextSubject = subjectForSession(next)
    if (nextSubject === who.subject) return true
    return withStateLease(async () => {
      if (!(await identityIsCurrent(who))) return false
      const consent = await readConsent()
      if (consent.corrupt) return false
      await ensureSubject(consent.value, who.subject, who.token)
      const current = consent.value.subjects[who.subject]
      if (!current) return false
      consent.value.subjects[nextSubject] = { ...current }
      if (current.pending && (!current.analytics_enabled || !current.research_content_enabled)) {
        // Keep the historical alias disabled while the pending account choice
        // moves to the canonical subject.
        consent.value.subjects[who.subject] = {
          analytics_enabled: false,
          research_content_enabled: false,
          user_owned_content_enabled: false,
          updated_at: new Date().toISOString(),
          pending: false,
          generation: generation(),
        }
      }
      await atomic(consentPath, JSON.stringify(consent.value, null, 2))
      return true
    })
  }

  /** Retry the current account's durable consent write when authenticated.
   * Legacy deletion proofs are deliberately inert: disabling data use is
   * prospective, while deletion requires the explicit authenticated action. */
  export async function retryPendingConsent(): Promise<boolean> {
    const who = await identity()
    const prepared = await withStateLease(async () => {
      if (who.signedIn && !(await identityIsCurrent(who))) return false
      const consent = await readConsent()
      if (consent.corrupt) return false
      let changed = false
      for (const entry of Object.values(consent.value.subjects)) {
        if (!entry.deletion_proof) continue
        delete entry.deletion_proof
        changed = true
      }
      if (changed) await atomic(consentPath, JSON.stringify(consent.value, null, 2))
      return true
    })
    if (!prepared) return false
    if (!who.token) return true
    const pending = await withStateLease(async () => {
      if (!(await identityIsCurrent(who))) return { valid: false as const }
      const consent = await readConsent()
      if (consent.corrupt) return { valid: false as const }
      const entry = consent.value.subjects[who.subject]
      return {
        valid: true as const,
        pending: entry?.pending === true,
        disabling: !!entry && (!entry.analytics_enabled || !entry.research_content_enabled),
      }
    })
    if (!pending.valid) return false
    if (!pending.pending) return true
    const synchronized = await synchronizeConsent(who)
    return !pending.disabling || synchronized
  }

  export async function status(refresh = false): Promise<Status> {
    const who = await identity()
    if (!who.signedIn) {
      if (refresh) await OutboundTelemetry.retryPendingConsent().catch(() => false)
      return {
        analyticsEnabled: false,
        researchContentEnabled: false,
        userOwnedContentEnabled: false,
        source: "default",
        signedIn: false,
        consentVersion: CONSENT_VERSION,
        pending: false,
        corrupt: false,
        deletionAvailable: false,
        queuedEvents: 0,
        quarantinedEvents: 0,
      }
    }
    const inspect = () =>
      withStateLease(async () => {
        if (!(await identityIsCurrent(who))) {
          const stale = await readConsent()
          return localStatus(stale.value, who.subject, false, stale.absent, stale.corrupt)
        }
        const consent = await readConsent()
        if (consent.corrupt) return localStatus(consent.value, who.subject, true, consent.absent, true)
        const activated = await activateLocked(consent.value, who.subject)
        const ensured = await ensureSubject(consent.value, who.subject, who.token)
        if (activated || ensured) await atomic(consentPath, JSON.stringify(consent.value, null, 2))
        return localStatus(consent.value, who.subject, true, consent.absent, false)
      })
    const enrich = async (current: Status) => ({
      ...current,
      queuedEvents: await queuedForSubject(who.subject),
      quarantinedEvents: (await deadRows()).filter((row) => row.subject === who.subject).length,
    })
    const current = await inspect()
    if (!refresh || !current.signedIn || current.corrupt) return enrich(current)
    await synchronizeConsent(who)
    return enrich(await inspect())
  }

  export async function enabled(): Promise<boolean> {
    const status = await OutboundTelemetry.status(false)
    return status.analyticsEnabled && status.researchContentEnabled
  }

  export async function setAnalytics(enabled: boolean): Promise<Status> {
    // Account replacement/logout acquire CredentialLifecycle before the
    // telemetry state lease. Use the same ordering for the complete toggle,
    // from identity selection through the server write. This makes the two
    // outcomes atomic: either A opts out before replacement, or replacement
    // commits first and the toggle selects B. Never acquire these in reverse.
    return CredentialLifecycle.serialized(async () => {
      const who = await identity()
      if (!who.signedIn) return OutboundTelemetry.status()
      const status = await withStateLease(async () => {
        if (!(await identityIsCurrent(who))) {
          const stale = await readConsent()
          return localStatus(stale.value, who.subject, false, stale.absent, stale.corrupt)
        }
        const consent = await readConsent()
        if (consent.corrupt) consent.value = fresh()
        await activateLocked(consent.value, who.subject)
        const now = new Date()
        const currentEntry = consent.value.subjects[who.subject]
        consent.value.subjects[who.subject] = {
          analytics_enabled: enabled,
          research_content_enabled: enabled,
          user_owned_content_enabled: enabled ? (currentEntry?.user_owned_content_enabled ?? true) : false,
          updated_at: now.toISOString(),
          pending: true,
          generation: generation(),
          ...(currentEntry?.consent_epoch ? { consent_epoch: currentEntry.consent_epoch } : {}),
        }
        if (!enabled) {
          // Opt-out is prospective: stop capture immediately and discard only
          // unsent local rows. Previously uploaded account history remains
          // intact unless the separate explicit deletion endpoint is used.
          await mutateRowsLocked(() => [])
          await fs.rm(deadPath, { force: true }).catch(() => undefined)
        }
        await atomic(consentPath, JSON.stringify(consent.value, null, 2))
        return localStatus(consent.value, who.subject, true, false, false)
      })
      // The switch controls future collection only. Explicit account-data
      // deletion remains a separate operation and is never implied by opt-out.
      await synchronizeConsent(who).catch(() => false)
      return OutboundTelemetry.status(false).catch(() => status)
    })
  }

  export async function setUserOwned(enabled: boolean): Promise<Status> {
    return CredentialLifecycle.serialized(async () => {
      const who = await identity()
      if (!who.signedIn) return OutboundTelemetry.status()
      await withStateLease(async () => {
        if (!(await identityIsCurrent(who))) return
        const consent = await readConsent()
        if (consent.corrupt) consent.value = fresh()
        await activateLocked(consent.value, who.subject)
        await ensureSubject(consent.value, who.subject, who.token)
        const entry = consent.value.subjects[who.subject]
        consent.value.subjects[who.subject] = {
          ...entry,
          user_owned_content_enabled: enabled,
          updated_at: new Date().toISOString(),
          pending: true,
          generation: generation(),
        }
        if (!enabled) {
          await mutateRowsLocked((rows) =>
            rows.filter((row) => row.subject === who.subject && row.event.model_route === "managed"),
          )
          await fs.rm(deadPath, { force: true }).catch(() => undefined)
        }
        await atomic(consentPath, JSON.stringify(consent.value, null, 2))
      })
      await synchronizeConsent(who).catch(() => false)
      return OutboundTelemetry.status(false)
    })
  }

  export async function requestDeletion(): Promise<{ ok: boolean; message?: string }> {
    return CredentialLifecycle.serialized(async () => {
      const who = await identity()
      if (!who.token) return { ok: false, message: "Sign in to delete shared OpenScience data." }
      return withStateLease(async () => {
        if (!(await identityIsCurrent(who))) return { ok: false, message: "OpenScience account changed. Try again." }
        const response = await fetch(`${API_BASE}/api/v1/telemetry/account-data`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "traces" }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
        if (!response?.ok) return { ok: false, message: "OpenScience data could not be deleted." }
        // An explicit deletion keeps both account and state boundaries closed
        // until the server confirms it, so no later batch can land behind the
        // purge and no capture can recreate the queue during the operation.
        const consent = await readConsent()
        if (consent.corrupt) consent.value = fresh()
        consent.value.active_subject = who.subject
        await disableSubjectLocked(consent.value, who.subject)
        return { ok: true }
      })
    })
  }

  export async function flush(expectedSubject?: string): Promise<void> {
    const who = await identity()
    if (!who.token) {
      await OutboundTelemetry.retryPendingConsent().catch(() => false)
      return
    }
    // Background flushes are scheduled by append. If the account changed
    // before that task began, the old task must not activate its stale subject
    // and purge or send the new account's queue.
    if (expectedSubject && who.subject !== expectedSubject) return
    await CredentialLifecycle.serialized(async () => {
      if (!(await identityIsCurrent(who))) return
      const pending = await withStateLease(async () => {
        if (!(await identityIsCurrent(who))) return false
        const consent = await readConsent()
        if (consent.corrupt) return false
        const activated = await activateLocked(consent.value, who.subject)
        const ensured = await ensureSubject(consent.value, who.subject, who.token)
        if (activated || ensured) await atomic(consentPath, JSON.stringify(consent.value, null, 2))
        return consent.value.subjects[who.subject]?.pending === true
      })
      // A pending entry is a server consent write, including prospective opt-out.
      // Resolve it before selecting any content for delivery.
      if (pending && !(await synchronizeConsent(who))) return

      const selection = await withStateLease(async () => {
        if (!(await identityIsCurrent(who))) return
        const consent = await readConsent()
        if (consent.corrupt) return
        const entry = consent.value.subjects[who.subject]
        if (
          consent.value.active_subject !== who.subject ||
          !entry?.analytics_enabled ||
          !entry.research_content_enabled ||
          entry.pending === true
        ) {
          await mutateRowsLocked(() => [])
          return
        }
        const queued = await rawRows()
        const privateRows = entry.user_owned_content_enabled
          ? new Set<string>()
          : new Set(
              queued
                .filter((row) => row.subject === who.subject && row.event.model_route !== "managed")
                .map((row) => row.event.event_id),
            )
        if (privateRows.size) {
          await mutateRowsLocked((current) => current.filter((row) => !privateRows.has(row.event.event_id)))
        }
        const oversized = new Set(
          queued
            .filter((row) => !privateRows.has(row.event.event_id))
            .filter((row) => Buffer.byteLength(JSON.stringify(row.event)) > MAX_BATCH_BYTES)
            .map((row) => row.event.event_id),
        )
        if (oversized.size) {
          await quarantine(
            queued
              .filter((row) => oversized.has(row.event.event_id))
              .map((row) => ({
                subject: who.subject,
                failed_at: Date.now(),
                status: 413,
                reason: "local_batch_limit",
                event: row.event,
              })),
          )
          await mutateRowsLocked((current) => current.filter((row) => !oversized.has(row.event.event_id)))
        }
        const rows = selectedBatch(
          queued.filter(
            (row) =>
              row.subject === who.subject && !privateRows.has(row.event.event_id) && !oversized.has(row.event.event_id),
          ),
        )
        if (!rows.length) return
        return {
          subject: who.subject,
          installation: consent.value.installation_id,
          generation: entry.generation!,
          rows,
        }
      })
      if (!selection) return

      // Hold only the credential boundary across the request. Capture uses the
      // independent state lease and remains append-only while the network is
      // slow; account replacement, opt-out, and explicit deletion still wait
      // until this old-credential request has conclusively finished.
      const delivery = await deliverTelemetryRows(selection.rows, who.token!, selection.installation)

      await withStateLease(async () => {
        if (!(await identityIsCurrent(who))) return
        const consent = await readConsent()
        const entry = consent.value.subjects[selection.subject]
        const stable =
          !consent.corrupt &&
          consent.value.active_subject === selection.subject &&
          consent.value.installation_id === selection.installation &&
          entry?.generation === selection.generation &&
          entry.analytics_enabled &&
          entry.research_content_enabled &&
          entry.pending !== true
        if (!stable) {
          if (
            consent.corrupt ||
            consent.value.active_subject !== selection.subject ||
            consent.value.installation_id !== selection.installation ||
            !entry?.analytics_enabled ||
            !entry.research_content_enabled
          ) {
            await mutateRowsLocked(() => [])
          }
          return
        }
        if (delivery.consentDisabled) {
          await disableSubjectLocked(consent.value, selection.subject)
          return
        }
        if (delivery.userOwnedDisabled) {
          consent.value.subjects[selection.subject] = {
            ...entry,
            user_owned_content_enabled: false,
            updated_at: new Date().toISOString(),
            pending: false,
            generation: generation(),
          }
          await atomic(consentPath, JSON.stringify(consent.value, null, 2))
          await mutateRowsLocked((current) =>
            current.filter((row) => row.subject !== selection.subject || row.event.model_route === "managed"),
          )
        }
        if (delivery.quarantined.size) {
          await quarantine(
            selection.rows.flatMap((row) => {
              const failure = delivery.quarantined.get(row.event.event_id)
              if (!failure) return []
              return [{ subject: selection.subject, failed_at: Date.now(), ...failure, event: row.event }]
            }),
          )
        }
        const removed = new Set([...delivery.completed, ...delivery.quarantined.keys()])
        if (removed.size) {
          await mutateRowsLocked((current) => current.filter((row) => !removed.has(row.event.event_id)))
        }
      })
    })
  }

  /** Persist in-flight captures, then make a bounded best-effort upload pass.
   * Offline rows remain durably queued. This is safe to await at process exit:
   * a slow network or another process holding the queue lease cannot hang the
   * CLI beyond the caller's timeout. */
  export async function drain(options: { timeoutMs?: number } = {}): Promise<DrainResult> {
    const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS, 30_000))
    const deadline = Date.now() + timeoutMs
    let captureFailed = false

    while (captureTasks.size) {
      const pending = [...captureTasks]
      const settling = Promise.allSettled(pending).then((results) => {
        if (results.some((result) => result.status === "rejected")) captureFailed = true
      })
      if (!(await settleBefore(settling, deadline))) {
        return { captured: false, flushed: false, timedOut: true, pendingEvents: -1 }
      }
    }

    const who = await identity()
    if (!who.token) {
      await settleBefore(OutboundTelemetry.retryPendingConsent(), deadline)
      return { captured: !captureFailed, flushed: true, timedOut: false, pendingEvents: 0 }
    }

    let pendingEvents = 0
    const inspect = () => queuedForSubject(who.subject).then((count) => (pendingEvents = count))
    if (!(await settleBefore(inspect(), deadline))) {
      return { captured: !captureFailed, flushed: false, timedOut: true, pendingEvents: -1 }
    }

    while (pendingEvents > 0) {
      const before = pendingEvents
      if (!(await settleBefore(OutboundTelemetry.flush(who.subject), deadline))) {
        return { captured: !captureFailed, flushed: false, timedOut: true, pendingEvents }
      }
      if (!(await settleBefore(inspect(), deadline))) {
        return { captured: !captureFailed, flushed: false, timedOut: true, pendingEvents: -1 }
      }
      // Offline/transient failures deliberately retain the durable queue.
      if (pendingEvents >= before) {
        return { captured: !captureFailed, flushed: false, timedOut: false, pendingEvents }
      }
    }
    return { captured: !captureFailed, flushed: true, timedOut: false, pendingEvents: 0 }
  }

  export function sessionStarted(input: { sessionID: string; session: unknown }) {
    return append("session.started", {
      sessionID: input.sessionID,
      spanKey: `session:${input.sessionID}`,
      payload: { session: input.session },
    })
  }

  export async function sessionCompleted(input: {
    sessionID: string
    reason: string
    session?: unknown
    messageID?: string
  }) {
    const result = await append("session.completed", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `session:${input.sessionID}:completed:${input.messageID ?? input.reason}`,
      parentSpanID: input.messageID ?? `session:${input.sessionID}`,
      payload: { reason: input.reason, session: input.session },
    })
    const prefix = `${input.sessionID}\0`
    routes.delete(input.sessionID)
    for (const key of routes.keys()) {
      if (key.startsWith(prefix)) routes.delete(key)
    }
    return result
  }

  export function userMessage(input: {
    sessionID: string
    message: unknown
    parts: unknown[]
    messageID?: string
    route?: string
    provider?: string
    model?: string
  }) {
    const messageID = input.messageID || (input.message as { id?: string } | undefined)?.id || randomUUID()
    return append("user.message", {
      sessionID: input.sessionID,
      runID: messageID,
      spanKey: messageID,
      parentSpanID: `session:${input.sessionID}`,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: { message: input.message, parts: input.parts },
    })
  }

  export function modelRequest(input: {
    sessionID: string
    messageID: string
    attempt: number
    route: string
    provider: string
    model: string
    system: unknown
    messages: unknown
    tools: unknown
    parameters: unknown
  }) {
    return append("model.request", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `${input.messageID}:model:${input.attempt}:request`,
      parentSpanID: input.messageID,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: {
        attempt: input.attempt,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        parameters: input.parameters,
      },
    })
  }

  export function modelResponse(input: {
    sessionID: string
    messageID: string
    attempt: number
    route: string
    provider: string
    model: string
    message: unknown
    parts: unknown[]
    tokens?: unknown
    finish?: unknown
  }) {
    return append("model.response", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `${input.messageID}:model:${input.attempt}:response`,
      parentSpanID: `${input.messageID}:model:${input.attempt}:request`,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: {
        attempt: input.attempt,
        message: input.message,
        parts: input.parts,
        tokens: input.tokens,
        finish: input.finish,
      },
    })
  }

  export function modelUsage(input: {
    sessionID: string
    messageID: string
    operationID: string
    attempt: number
    route: string
    provider: string
    model: string
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    cost: number
  }) {
    return append("model.usage", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `${input.messageID}:usage:${input.operationID}`,
      parentSpanID: `${input.messageID}:model:${input.attempt}:response`,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: {
        input_tokens: input.tokens.input,
        output_tokens: input.tokens.output,
        reasoning_tokens: input.tokens.reasoning,
        cache_read_tokens: input.tokens.cache.read,
        cache_write_tokens: input.tokens.cache.write,
        estimated_cost_microusd: Math.max(0, Math.round(input.cost * 1_000_000)),
        cost_source: "model_catalog",
      },
    })
  }

  export function assistantMessage(input: {
    sessionID: string
    messageID: string
    attempt: number
    route: string
    provider: string
    model: string
    message: unknown
    parts: unknown[]
  }) {
    return append("assistant.message", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: input.messageID,
      parentSpanID: `${input.messageID}:model:${input.attempt}:response`,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: { message: input.message, parts: input.parts },
    })
  }

  /** Compatibility wrapper for older call sites while they migrate to modelResponse. */
  export function assistant(input: {
    sessionID: string
    route: string
    provider: string
    model: string
    tokens: unknown
  }) {
    return append("model.response", {
      sessionID: input.sessionID,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: { tokens: input.tokens },
    })
  }

  export function tool(part: MessageV2.ToolPart) {
    const search = searchTools.has(part.tool)
    const status = part.state.status
    const cancelled = status === "error" && /abort|cancel/i.test(part.state.error)
    const eventType: EventType = search
      ? status === "pending" || status === "running"
        ? "search.started"
        : status === "completed"
          ? "search.completed"
          : "search.failed"
      : status === "pending" || status === "running"
        ? "tool.started"
        : status === "completed"
          ? "tool.completed"
          : cancelled
            ? "tool.cancelled"
            : "tool.failed"
    return append(eventType, {
      sessionID: part.sessionID,
      runID: part.messageID,
      spanKey: part.callID,
      parentSpanID: part.messageID,
      payload: { tool: part.tool, call_id: part.callID, state: part.state, cancelled },
    })
  }

  export function artifact(input: {
    sessionID: string
    messageID?: string
    artifact: unknown
    execution?: unknown
    type?: string
    size?: number
  }) {
    return append("artifact.completed", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `${input.messageID || input.sessionID}:artifact:${randomUUID()}`,
      parentSpanID: input.messageID,
      payload: {
        artifact: input.artifact ?? { type: input.type, size: input.size },
        execution: input.execution,
      },
    })
  }

  export function error(input: {
    sessionID: string
    messageID?: string
    attempt?: number
    parentSpanID?: string
    route?: string
    provider?: string
    model?: string
    error: unknown
    context?: unknown
  }) {
    return append("error", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `${input.messageID || input.sessionID}:error:${input.attempt ?? 0}:${randomUUID()}`,
      parentSpanID: input.parentSpanID ?? input.messageID,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: { attempt: input.attempt, error: input.error, context: input.context },
    })
  }

  export function retry(input: {
    sessionID: string
    messageID: string
    attempt: number
    delay?: number
    route?: string
    provider?: string
    model?: string
    error?: unknown
  }) {
    return append("retry", {
      sessionID: input.sessionID,
      runID: input.messageID,
      spanKey: `${input.messageID}:retry:${input.attempt}`,
      parentSpanID: `${input.messageID}:model:${Math.max(0, input.attempt - 1)}:response`,
      route: input.route,
      provider: input.provider,
      model: input.model,
      payload: { attempt: input.attempt, delay_ms: input.delay, error: input.error },
    })
  }
}
