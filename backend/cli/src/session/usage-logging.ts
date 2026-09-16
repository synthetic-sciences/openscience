import path from "node:path"
import { createHash } from "node:crypto"
import type { LanguageModelUsage, ProviderMetadata } from "ai"
import z from "zod"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { OpenScience } from "@/openscience"
import { managedApiBase } from "@/endpoints"
import { JsonStore } from "@/util/jsonstore"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"
import { tracePayload } from "./trace-payload"

const log = Log.create({ service: "usage-logging" })
const filepath = path.join(Global.Path.data, "usage-logging.json")
const version = "openscience-trace-v3-2026-08-26"
const limit = 2_048
const Route = z.enum(["managed", "byok", "chatgpt", "subscription", "local", "custom"])
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
const Observation = z.object({
  usage_source: z.literal("provider_response"),
  usage: z.object({
    input_tokens: Count,
    output_tokens: Count,
    total_tokens: Count,
    reasoning_tokens: Count,
    cached_input_tokens: Count,
    cache_creation_input_tokens: Count,
  }),
  cost_usd: z.number().finite().nonnegative().nullable(),
  cost_source: z.enum(["provider_response", "unavailable"]),
  duration_ms: z.number().finite().nonnegative(),
})
const Kind = z.enum([
  "model.request",
  "model.response",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "error",
])
const Event = z.object({
  event_id: z.string().uuid(),
  schema_version: z.literal(2),
  event_type: Kind,
  occurred_at: z.string().datetime(),
  installation_id: z.string().uuid(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().optional(),
  session_id: z.string(),
  run_id: z.string(),
  model_route: Route,
  provider_id: z.string(),
  model_id: z.string(),
  payload: z.record(z.string(), z.unknown()),
})
const Row = z.object({ account: z.string(), event: Event })
const Store = z.object({
  installation: z
    .string()
    .uuid()
    .default(() => crypto.randomUUID()),
  enabled: z.boolean().default(true),
  revision: z.string().default("initial"),
  queue: Row.array().max(limit).default([]),
  quarantined: Row.array().max(64).default([]),
  batchSize: z.number().int().min(1).max(64).default(64),
  delivered: z.number().int().nonnegative().default(0),
  lastDelivery: z.string().datetime().optional(),
  error: z.string().optional(),
})
const Consent = z.object({
  consent_version: z.literal(version),
  analytics_enabled: z.boolean(),
  research_content_enabled: z.boolean(),
  user_owned_content_enabled: z.boolean(),
})
const Receipt = z.object({
  delivery_id: z.string().uuid(),
  schema_version: z.literal(2),
  consent_version: z.literal(version),
  accepted: z.array(z.string().uuid()),
  replayed: z.array(z.string().uuid()),
  rejected: z.array(z.unknown()),
})

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function read() {
  return Store.parse(await JsonStore.read(filepath, { strict: true }))
}

async function update(fn: (state: z.infer<typeof Store>) => void) {
  await using operation = await DataRootBarrier.enter(filepath)
  await JsonStore.update(filepath, (raw) => {
    const state = Store.parse(raw)
    fn(state)
    return state
  })
}

async function legacy(session: { user_id: string; api_key: string }, route?: z.infer<typeof Route>) {
  for (const filename of ["telemetry-consent-v2.json", "telemetry-consent-v1.json"]) {
    const file = Bun.file(path.join(Global.Path.data, filename))
    if (!(await file.exists())) continue
    // Preserve saved opt-outs from releases before the uploader was removed.
    // Unreadable settings must never be interpreted as a new installation.
    const raw = object(await file.json())
    if (!raw.subjects || typeof raw.subjects !== "object") return false
    const keys = [
      `account:${session.user_id}`,
      `account:key-sha256:${digest(session.api_key)}`,
      `account:${session.api_key.split(".")[0]}`,
    ]
    for (const key of keys) {
      const entry = object(object(raw.subjects)[key])
      if (entry.analytics_enabled === false || entry.research_content_enabled === false) return false
      if (route !== "managed" && entry.user_owned_content_enabled === false) return false
    }
  }
  return true
}

let pending: Promise<void> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let delay = 1_000
let closing = false

function schedule() {
  if (timer || closing) return
  timer = setTimeout(() => {
    timer = undefined
    void UsageLogging.flush().catch(() => undefined)
  }, delay)
  timer.unref()
}

export namespace UsageLogging {
  export type Context = NonNullable<Awaited<ReturnType<typeof context>>>
  export type Binding = {
    context: Context
    sessionID: string
    messageID: string
    route: string
    provider: string
    model: string
    operationID?: string
  }
  const bindings = new Map<string, Binding>()

  export function bind(input: Binding) {
    const key = `${input.sessionID}:${input.messageID}`
    bindings.delete(key)
    bindings.set(key, input)
    if (bindings.size > 512) bindings.delete(bindings.keys().next().value!)
  }

  export function unbind(sessionID: string, messageID: string) {
    bindings.delete(`${sessionID}:${messageID}`)
  }

  export async function part(part: MessageV2.Part) {
    const bound = bindings.get(`${part.sessionID}:${part.messageID}`)
    if (!bound) return
    if (part.type === "tool") {
      const status = part.state.status
      const kind =
        status === "completed"
          ? "tool.completed"
          : status === "error"
            ? /abort|cancel/i.test(part.state.error)
              ? "tool.cancelled"
              : "tool.failed"
            : "tool.started"
      return event(bound, kind, { tool: part.tool, call_id: part.callID, state: part.state })
    }
    if (part.type === "text" || part.type === "reasoning") return event(bound, "assistant.message", { part })
  }
  export const Status = z.object({
    enabled: z.boolean(),
    signedIn: z.boolean(),
    queued: z.number().int(),
    quarantined: z.number().int(),
    delivered: z.number().int(),
    lastDelivery: z.string().optional(),
    error: z.string().optional(),
  })

  /** Retain only numeric provider usage. Missing usage is unknown, never an
   * invented zero or a count estimated from the generated text. */
  export function reported(usage: LanguageModelUsage, metadata?: ProviderMetadata) {
    const cost = object(metadata?.openrouter?.usage).cost
    const price = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null
    return {
      usage_source: "provider_response" as const,
      usage: {
        input_tokens: count(usage.inputTokens),
        output_tokens: count(usage.outputTokens),
        total_tokens: count(usage.totalTokens),
        reasoning_tokens: count(usage.reasoningTokens),
        cached_input_tokens: count(usage.cachedInputTokens),
        cache_creation_input_tokens: count(
          metadata?.anthropic?.cacheCreationInputTokens ??
            object(metadata?.bedrock?.usage).cacheWriteInputTokens ??
            object(metadata?.venice?.usage).cacheCreationInputTokens,
        ),
      },
      cost_usd: price,
      cost_source: price === null ? ("unavailable" as const) : ("provider_response" as const),
    }
  }

  export async function context() {
    const session = await OpenScience.getSession()
    if (!session?.user_id) return
    const state = await read()
    if (!state.enabled) return
    return {
      session,
      revision: state.revision,
      base: managedApiBase(),
      account: digest(`${managedApiBase()}\n${session.user_id}\n${session.organization_id ?? ""}`),
    }
  }

  export async function record(
    input: Binding & {
      usage: LanguageModelUsage
      metadata?: ProviderMetadata
      duration: number
      content?: unknown
      finish?: string
    },
  ) {
    return event(input, "model.response", {
      ...reported(input.usage, input.metadata),
      duration_ms: input.duration,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.finish === undefined ? {} : { finish: input.finish }),
    })
  }

  export async function event(input: Binding, kind: z.infer<typeof Kind>, payload: Record<string, unknown>) {
    const current = await context()
    if (
      !current ||
      current.revision !== input.context.revision ||
      current.account !== input.context.account ||
      current.session.api_key !== input.context.session.api_key
    )
      return
    const route = Route.catch("custom").parse(input.route)
    if (!(await legacy(current.session, route))) return
    OpenScience.registerSecretValues([current.session.api_key])
    const observation = kind === "model.response" ? Observation.safeParse(payload) : undefined
    const sanitized = {
      ...(await tracePayload(payload)),
      ...(observation?.success ? observation.data : {}),
    }
    const labels = await OpenScience.scrubSecrets({ provider: input.provider, model: input.model })
    const label = (value: string) => (/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/.test(value) ? value : "custom")
    await update((state) => {
      if (!state.enabled || state.revision !== input.context.revision) return
      if (state.queue.length >= limit || Buffer.byteLength(JSON.stringify(state.queue)) > 32 * 1024 * 1024) {
        state.error = "Trace queue is full; the latest record could not be saved."
        log.warn("usage queue full")
        return
      }
      const id = crypto.randomUUID()
      state.queue.push({
        account: current.account,
        event: Event.parse({
          event_id: id,
          schema_version: 2,
          // The receiver's model.usage projection only accepts catalog
          // estimates. Keep observed amounts in a response record instead of
          // mislabelling a provider charge as an estimate or inventing a bill.
          event_type: kind,
          occurred_at: new Date().toISOString(),
          installation_id: state.installation,
          trace_id: digest(`${state.installation}:${input.sessionID}`).slice(0, 32),
          span_id: digest(kind === "model.request" ? (input.operationID ?? id) : id).slice(0, 16),
          ...(kind !== "model.request" && input.operationID
            ? { parent_span_id: digest(input.operationID).slice(0, 16) }
            : {}),
          session_id: digest(`${state.installation}:${input.sessionID}`),
          run_id: digest(`${state.installation}:${input.messageID}`),
          model_route: route,
          provider_id: label(labels.provider),
          model_id: label(labels.model),
          payload: sanitized,
        }),
      })
    })
    schedule()
  }

  export async function status(): Promise<z.infer<typeof Status>> {
    const state = await read()
    return {
      enabled: state.enabled,
      signedIn: !!(await OpenScience.getSession())?.user_id,
      queued: state.queue.length,
      quarantined: state.quarantined.length,
      delivered: state.delivered,
      lastDelivery: state.lastDelivery,
      error: state.error,
    }
  }

  export async function setEnabled(enabled: boolean) {
    await CredentialLifecycle.serialized(() =>
      update((state) => {
        if (state.enabled !== enabled) state.revision = crypto.randomUUID()
        state.enabled = enabled
        if (!enabled) {
          state.queue = []
          state.quarantined = []
          bindings.clear()
        }
        state.error = undefined
      }),
    )
    if (enabled) schedule()
    return status()
  }

  async function deliver() {
    await CredentialLifecycle.serialized(async () => {
      const who = await context()
      if (!who) {
        if (!(await OpenScience.getSession()) && (await Bun.file(filepath).exists())) {
          await update((state) => {
            state.queue = []
            state.quarantined = []
          })
          bindings.clear()
        }
        return
      }
      const state = await read()
      if (!state.queue.length) return
      const headers = {
        Authorization: `Bearer ${who.session.api_key}`,
        ...(who.session.organization_id ? { "X-Organization-ID": who.session.organization_id } : {}),
      }
      const response = await fetch(`${who.base}/api/v1/telemetry/consent`, {
        headers,
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      })
      if (!response.ok) throw new Error("Account sharing preference could not be verified.")
      const consent = Consent.parse(await response.json())
      const managed =
        consent.analytics_enabled && consent.research_content_enabled && (await legacy(who.session, "managed"))
      const owned = managed && consent.user_owned_content_enabled && (await legacy(who.session, "byok"))
      const allowed = (row: z.infer<typeof Row>) =>
        row.account === who.account && (row.event.model_route === "managed" ? managed : owned)
      const rows: z.infer<typeof Row>[] = []
      let bytes = 0
      for (const row of state.queue) {
        if (!allowed(row)) continue
        const size = Buffer.byteLength(JSON.stringify(row.event))
        if (rows.length >= state.batchSize || bytes + size > 2 * 1024 * 1024) break
        rows.push(row)
        bytes += size
      }
      // Drop other accounts' records and records excluded by an opt-out. Do
      // not retain them for a later sign-in or a later change of preference.
      await update((latest) => {
        latest.queue = latest.queue.filter(allowed)
        latest.quarantined = latest.quarantined.filter(allowed)
        if (!managed) latest.error = "Trace sharing is disabled by your saved privacy preferences."
      })
      if (!rows.length) return
      const delivery = crypto.randomUUID()
      const batch = await fetch(`${who.base}/api/v1/telemetry/batches`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "Content-Encoding": "gzip" },
        body: Bun.gzipSync(
          JSON.stringify({
            schema_version: 2,
            consent_version: version,
            delivery_id: delivery,
            installation_id: state.installation,
            events: rows.map((row) => row.event),
          }),
        ),
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      })
      if ([400, 413, 415, 422].includes(batch.status)) {
        await update((latest) => {
          latest.batchSize = Math.max(1, Math.floor(rows.length / 2))
          if (rows.length === 1) {
            latest.queue = latest.queue.filter((row) => row.event.event_id !== rows[0].event.event_id)
            latest.quarantined = [...latest.quarantined, rows[0]].slice(-64)
            latest.batchSize = 64
          }
          latest.error = `Trace delivery needs attention (HTTP ${batch.status}). Rejected records are kept locally.`
        })
        return
      }
      if (!batch.ok) throw new Error(`Trace delivery was not accepted (HTTP ${batch.status}).`)
      const receipt = Receipt.parse(await batch.json())
      const sent = new Set(rows.map((row) => row.event.event_id))
      const confirmed = [...receipt.accepted, ...receipt.replayed]
      if (
        receipt.delivery_id !== delivery ||
        receipt.rejected.length ||
        new Set(confirmed).size !== confirmed.length ||
        confirmed.some((id) => !sent.has(id))
      )
        throw new Error("Usage delivery receipt did not match the submitted batch.")
      await update((latest) => {
        const ids = new Set(confirmed)
        const removed = latest.queue.filter((row) => ids.has(row.event.event_id)).length
        latest.queue = latest.queue.filter((row) => !ids.has(row.event.event_id))
        latest.delivered += removed
        if (removed) latest.lastDelivery = new Date().toISOString()
        latest.error = confirmed.length === sent.size ? undefined : "Some trace records are awaiting acknowledgement."
        if (confirmed.length === sent.size) latest.batchSize = 64
      })
      delay = confirmed.length ? 1_000 : Math.min(delay * 2, 300_000)
    })
  }

  export function flush(): Promise<void> {
    if (pending) return pending
    const operation = deliver()
      .catch(async () => {
        // Provider/account payloads and HTTP bodies can contain credentials;
        // persist only our content-free diagnostic, never the caught exception.
        await update((state) => {
          state.error = "Trace delivery could not be verified; queued records will be retried."
        })
        delay = Math.min(delay * 2, 300_000)
      })
      .finally(async () => {
        pending = undefined
        const state = await read().catch(() => undefined)
        if (state?.queue.length) schedule()
        else delay = 1_000
      })
    pending = operation
    return operation
  }

  export function start() {
    closing = false
    schedule()
  }

  export async function drain() {
    closing = true
    if (timer) clearTimeout(timer)
    timer = undefined
    await Promise.race([flush().catch(() => undefined), Bun.sleep(2_000)])
  }
}
