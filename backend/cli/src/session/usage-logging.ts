import path from "node:path"
import { createHash } from "node:crypto"
import type { LanguageModelUsage, ProviderMetadata } from "ai"
import z from "zod"
import { Global } from "@/global"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { OpenScience } from "@/openscience"
import { managedApiBase } from "@/endpoints"
import type { MessageV2 } from "./message-v2"
import { tracePayload } from "./trace-payload"
import { TraceQueue } from "./trace-queue"

const version = "openscience-trace-v3-2026-08-26"
const Route = TraceQueue.Route
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
const Kind = TraceQueue.Kind
const Event = TraceQueue.Event
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

class DeliveryError extends Error {
  constructor(kind: "consent" | "delivery" | "receipt", status?: number) {
    super(
      kind === "consent"
        ? `Account sharing preference could not be verified (HTTP ${status}).`
        : kind === "delivery"
          ? `Trace delivery was not accepted (HTTP ${status}); queued records will be retried.`
          : "Usage delivery receipt did not match the submitted batch; queued records will be retried.",
    )
  }
}

const read = TraceQueue.read

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
  export async function bind(input: Binding) {
    await TraceQueue.bind({
      account: input.context.account,
      revision: input.context.revision,
      credential: digest(input.context.session.api_key),
      sessionID: input.sessionID,
      messageID: input.messageID,
      route: Route.catch("custom").parse(input.route),
      provider: input.provider,
      model: input.model,
      operationID: input.operationID,
    })
  }

  export function unbind(sessionID: string, messageID: string) {
    return TraceQueue.unbind(sessionID, messageID)
  }

  export async function part(part: MessageV2.Part) {
    const who = await context()
    if (!who) return
    const record = await TraceQueue.binding(part.sessionID, part.messageID)
    if (
      !record ||
      record.account !== who.account ||
      record.revision !== who.revision ||
      record.credential !== digest(who.session.api_key)
    )
      return
    const bound: Binding = {
      context: who,
      sessionID: record.sessionID,
      messageID: record.messageID,
      route: record.route,
      provider: record.provider,
      model: record.model,
      operationID: record.operationID,
    }
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
    oldestQueuedAt: z.string().datetime().optional(),
    stalled: z.boolean().optional(),
    lastAttempt: TraceQueue.Attempt.optional(),
    rejection: TraceQueue.Rejection.optional(),
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
            object(metadata?.venice?.usage).cacheCreationInputTokens ??
            object(object(metadata?.openrouter?.usage).promptTokensDetails).cacheWriteTokens,
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

  export async function installationID(): Promise<string> {
    return (await read()).installation
  }

  /** Opaque session identity used by the server. It lets a local audit name
   * its consented trace without revealing the user's local session id. */
  export async function telemetrySessionID(sessionID: string) {
    // Persist the installation before deriving an identity. On a fresh data
    // root, parsing defaults alone would mint a different installation for
    // each call and none would match a later uploaded trace.
    const state = await read()
    return digest(`${state.installation}:${sessionID}`)
  }

  export async function record(
    input: Binding & {
      usage: LanguageModelUsage
      metadata?: ProviderMetadata
      duration: number
      content?: unknown
      finish?: string
      call?: { id: string; hold?: string; providerRequest?: string }
    },
  ) {
    return event({ ...input, operationID: input.call?.id ?? input.operationID }, "model.response", {
      ...reported(input.usage, input.metadata),
      duration_ms: input.duration,
      ...(input.call && {
        http_call_id: input.call.id,
        ...(input.call.hold && { hold: input.call.hold }),
        ...(input.call.providerRequest && { provider_request_id: input.call.providerRequest }),
      }),
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
    const state = await read()
    if (!state.enabled || state.revision !== input.context.revision) return
    const id = crypto.randomUUID()
    await TraceQueue.enqueue(
      {
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
      },
      input.context.revision,
    )
    schedule()
  }

  export async function status(): Promise<z.infer<typeof Status>> {
    const state = await TraceQueue.status()
    return {
      enabled: state.enabled,
      signedIn: !!(await OpenScience.getSession())?.user_id,
      queued: state.queued,
      quarantined: state.quarantined,
      delivered: state.delivered,
      lastDelivery: state.lastDelivery,
      oldestQueuedAt: state.oldestQueuedAt,
      stalled: state.stalled,
      lastAttempt: state.lastAttempt,
      rejection: state.rejection,
      error: state.error,
    }
  }

  export async function setEnabled(enabled: boolean) {
    await CredentialLifecycle.serialized(async () => {
      await TraceQueue.setEnabled(enabled)
    })
    if (enabled) schedule()
    return status()
  }

  async function deliver() {
    await CredentialLifecycle.serialized(async () => {
      const who = await context()
      if (!who) {
        if (!(await OpenScience.getSession())) {
          await TraceQueue.clear()
        }
        return
      }
      const state = await read()
      if (!(await TraceQueue.status()).queued) return
      const headers = {
        Authorization: `Bearer ${who.session.api_key}`,
        ...(who.session.organization_id ? { "X-Organization-ID": who.session.organization_id } : {}),
      }
      const response = await fetch(`${who.base}/api/v1/telemetry/consent`, {
        headers,
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      })
      if (!response.ok) throw new DeliveryError("consent", response.status)
      const consent = Consent.parse(await response.json())
      const managed =
        consent.analytics_enabled && consent.research_content_enabled && (await legacy(who.session, "managed"))
      const owned = managed && consent.user_owned_content_enabled && (await legacy(who.session, "byok"))
      await TraceQueue.filter(who.account, managed, owned)
      const rows = await TraceQueue.batch(who.account)
      if (!rows.length) return
      const delivery = crypto.randomUUID()
      if (!(await TraceQueue.beginDelivery(delivery, who.account, rows, who.revision))) return
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
      await TraceQueue.response(delivery, batch.status)
      if ([400, 413, 415, 422].includes(batch.status)) {
        await batch.body?.cancel().catch(() => undefined)
        await TraceQueue.reject(delivery, rows, batch.status)
        return
      }
      if (!batch.ok) {
        await batch.body?.cancel().catch(() => undefined)
        throw new DeliveryError("delivery", batch.status)
      }
      const parsed = Receipt.safeParse(await batch.json().catch(() => undefined))
      if (!parsed.success) throw new DeliveryError("receipt")
      const receipt = parsed.data
      const sent = new Set(rows.map((row) => row.event.event_id))
      const confirmed = [...receipt.accepted, ...receipt.replayed]
      if (
        receipt.delivery_id !== delivery ||
        receipt.rejected.length ||
        new Set(confirmed).size !== confirmed.length ||
        confirmed.some((id) => !sent.has(id))
      )
        throw new DeliveryError("receipt")
      await TraceQueue.acknowledge(
        delivery,
        receipt.accepted,
        receipt.replayed,
        confirmed.length === sent.size,
        who.revision,
      )
      delay = confirmed.length ? 1_000 : Math.min(delay * 2, 300_000)
    })
  }

  export function flush(): Promise<void> {
    if (pending) return pending
    const operation = deliver()
      .catch(async (error: unknown) => {
        // Provider/account payloads and HTTP bodies can contain credentials;
        // persist only our content-free diagnostic, never the caught exception.
        await TraceQueue.failure(
          error instanceof DeliveryError
            ? error.message
            : "Trace delivery could not be verified; queued records will be retried.",
        )
        delay = Math.min(delay * 2, 300_000)
      })
      .finally(async () => {
        pending = undefined
        const state = await TraceQueue.status().catch(() => undefined)
        if (state?.queued) schedule()
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
