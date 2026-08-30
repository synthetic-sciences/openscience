import { createHash, createHmac, randomBytes } from "node:crypto"
import z from "zod"

/**
 * Local-only compatibility surface.
 *
 * OpenScience does not collect or upload product analytics, prompts, tool
 * calls, model traffic, artifacts, or research content. The namespace remains
 * so older internal call sites and extensions do not need a flag check.
 */
export const CONSENT_VERSION = "openscience-local-only-v1"

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

const Platform = z.enum(["macos", "windows", "linux", "unknown"])
const ModelRoute = z.enum(["managed", "byok", "chatgpt", "subscription", "local", "custom"])

export const Event = z
  .object({
    event_id: z.string().uuid(),
    schema_version: z.number().int(),
    event_type: z.enum(EVENT_TYPES),
    occurred_at: z.string().datetime(),
    trace_id: z.string(),
    span_id: z.string(),
    parent_span_id: z.string().optional(),
    app_version: z.string().optional(),
    platform: Platform.optional(),
    architecture: z.string().optional(),
    locale: z.string().optional(),
    timezone: z.string().optional(),
    installation_id: z.string().uuid(),
    session_id: z.string().optional(),
    run_id: z.string().optional(),
    model_route: ModelRoute.optional(),
    provider_id: z.string().optional(),
    model_id: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export type Event = z.infer<typeof Event>
export type EventType = (typeof EVENT_TYPES)[number]

export type Status = {
  analyticsEnabled: boolean
  researchContentEnabled: boolean
  userOwnedContentEnabled: boolean
  source: "default" | "account" | "local"
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

const disabledStatus = (): Status => ({
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
})

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

export function telemetryKeyID(value: string): string | undefined {
  return /^((?:thk|osk)_[0-9a-f]{32})\.[A-Za-z0-9_-]{16,}$/i.exec(value)?.[1].toLowerCase()
}

export function telemetryKeyPrefix(value: string): string | undefined {
  const current = /^(thk|osk)_([0-9a-f]{32})\.[A-Za-z0-9_-]+$/i.exec(value)
  if (current) return `${current[1].toLowerCase()}_${current[2].slice(0, 8).toLowerCase()}`
  return /^((?:thk|osk)_[A-Za-z0-9_-]{1,64})\.[A-Za-z0-9_-]+$/.exec(value)?.[1]
}

export function telemetryDeletionProof(
  value: string,
  consentEpoch = "0".repeat(32),
  nonceHex = randomBytes(16).toString("hex"),
): string | undefined {
  const prefix = telemetryKeyPrefix(value)
  if (!prefix || !/^[a-f0-9]{32}$/.test(consentEpoch) || !/^[a-f0-9]{32}$/.test(nonceHex)) return
  const prefixHex = Buffer.from(prefix, "utf8").toString("hex")
  const verifier = createHash("sha256").update(value).digest()
  const message = `openscience-telemetry-delete:v2\n${prefixHex}\n${consentEpoch}\n${nonceHex}`
  const mac = createHmac("sha256", verifier).update(message).digest("hex")
  return `odp_v2.${prefixHex}.${consentEpoch}.${nonceHex}.${mac}`
}

export function telemetryIdentifier(value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/.test(trimmed)) return trimmed
  return `local:sha256:${createHash("sha256").update(value).digest("hex")}`
}

type SessionStartedInput = { sessionID: string; session: unknown }
type SessionCompletedInput = { sessionID: string; reason: string; session?: unknown; messageID?: string }
type UserMessageInput = {
  sessionID: string
  messageID?: string
  route?: string
  provider?: string
  model?: string
  message: unknown
  parts: unknown
}
type ModelRequestInput = {
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
}
type ModelResponseInput = {
  sessionID: string
  messageID: string
  attempt: number
  route: string
  provider: string
  model: string
  message: unknown
  parts: unknown
  tokens?: unknown
  finish?: unknown
}
type ModelUsageInput = {
  sessionID: string
  messageID: string
  operationID: string
  attempt: number
  route: string
  provider: string
  model: string
  tokens: unknown
  cost: number
}
type AssistantMessageInput = {
  sessionID: string
  messageID: string
  attempt: number
  route: string
  provider: string
  model: string
  message: unknown
  parts: unknown
}
type ErrorInput = {
  sessionID: string
  messageID?: string
  attempt?: number
  parentSpanID?: string
  route?: string
  provider?: string
  model?: string
  error: unknown
  context?: unknown
}
type RetryInput = {
  sessionID: string
  messageID: string
  attempt: number
  delay?: number
  route?: string
  provider?: string
  model?: string
  error?: unknown
}

const done = async (..._args: unknown[]): Promise<boolean> => false

export namespace OutboundTelemetry {
  export const resetAccountSession = done
  export const initializeAccount = done
  export async function preserveConsentForSession(_session?: unknown): Promise<boolean> {
    return true
  }
  export async function retryPendingConsent(): Promise<boolean> {
    return true
  }
  export async function status(_refresh = false): Promise<Status> {
    return disabledStatus()
  }
  export async function enabled(): Promise<boolean> {
    return false
  }
  export async function setAnalytics(_enabled?: boolean): Promise<Status> {
    return disabledStatus()
  }
  export async function setUserOwned(_enabled?: boolean): Promise<Status> {
    return disabledStatus()
  }
  export async function requestDeletion(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true }
  }
  export const flush = done
  export async function drain(_options?: { timeoutMs?: number }): Promise<DrainResult> {
    return { captured: true, flushed: true, timedOut: false, pendingEvents: 0 }
  }
  export async function sessionStarted(_input: SessionStartedInput): Promise<boolean> {
    return false
  }
  export async function sessionCompleted(_input: SessionCompletedInput): Promise<boolean> {
    return false
  }
  export async function userMessage(_input: UserMessageInput): Promise<boolean> {
    return false
  }
  export async function modelRequest(_input: ModelRequestInput): Promise<boolean> {
    return false
  }
  export async function modelResponse(_input: ModelResponseInput): Promise<boolean> {
    return false
  }
  export async function modelUsage(_input: ModelUsageInput): Promise<boolean> {
    return false
  }
  export async function assistantMessage(_input: AssistantMessageInput): Promise<boolean> {
    return false
  }
  export const assistant = done
  export const tool = done
  export const artifact = done
  export async function error(_input: ErrorInput): Promise<boolean> {
    return false
  }
  export async function retry(_input: RetryInput): Promise<boolean> {
    return false
  }
}
