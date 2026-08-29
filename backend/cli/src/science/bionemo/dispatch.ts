import crypto from "node:crypto"
import path from "node:path"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import z from "zod"
import { BioNemoCapabilityID, type BioNemoCapabilityID as ID } from "./schema"

export const BioNemoHostedArtifact = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.string(),
  })
  .strict()

const ProviderRequestID = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/)
const EgressDigest = z.string().regex(/^[a-f0-9]{64}$/)
const EgressBucket = z
  .object({
    count: z.number().int().positive(),
    total_bytes: z.number().int().nonnegative(),
    sha256: EgressDigest,
  })
  .strict()

export const BioNemoHostedEgressSummary = z
  .object({
    input_kinds: z.array(z.string().min(1).max(64)).min(1).max(16),
    sequences: EgressBucket.extend({ lengths: z.array(z.number().int().nonnegative()).max(32) }).optional(),
    structures: EgressBucket.optional(),
    alignments: EgressBucket.optional(),
    ligands: EgressBucket.optional(),
    asset_references: EgressBucket.optional(),
    instructions: EgressBucket.optional(),
    scalar_parameters: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            value: z.union([z.number(), z.boolean(), z.string().min(1).max(64)]),
          })
          .strict(),
      )
      .max(24),
  })
  .strict()

export const BioNemoHostedResult = z
  .object({
    dispatch_id: z.string().optional(),
    capability: BioNemoCapabilityID,
    provider: z.literal("nvidia"),
    endpoint: z.string().url(),
    api_schema_version: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    payload_bytes: z.number().int().nonnegative(),
    started_at: z.string(),
    completed_at: z.string(),
    root: z.string(),
    artifacts: BioNemoHostedArtifact.array(),
    provider_request_id: ProviderRequestID.optional(),
  })
  .strict()

export const BioNemoHostedPending = z
  .object({
    dispatch_id: z.string(),
    capability: BioNemoCapabilityID,
    provider: z.literal("nvidia"),
    endpoint: z.string().url(),
    status_endpoint: z.string().url(),
    api_schema_version: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["pending", "unknown"]),
    pollable: z.literal(true),
    poll_attempts: z.number().int().nonnegative(),
    provider_request_id: ProviderRequestID,
    next: z.string(),
  })
  .strict()

export const BioNemoHostedPreview = z
  .object({
    capability: BioNemoCapabilityID,
    provider: z.literal("nvidia"),
    configured: z.boolean(),
    method: z.literal("POST"),
    endpoint: z.string().url(),
    status_endpoint_template: z.literal("https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}"),
    status_host: z.literal("api.nvcf.nvidia.com"),
    api_schema_version: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    payload_bytes: z.number().int().nonnegative(),
    egress_summary: BioNemoHostedEgressSummary,
    payload: z.record(z.string(), z.unknown()),
    terms_url: z.string().url(),
    warning: z.string(),
    dispatched: z.literal(false),
  })
  .strict()

const BioNemoDispatchRecord = z
  .object({
    schema_version: z.literal(2),
    dispatch_id: z.string(),
    session_id: z.string(),
    capability: BioNemoCapabilityID,
    provider: z.literal("nvidia"),
    endpoint: z.string().url(),
    host: z.string(),
    status_endpoint_template: z.literal("https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}"),
    status_host: z.literal("api.nvcf.nvidia.com"),
    api_schema_version: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    payload_bytes: z.number().int().nonnegative(),
    terms_url: z.string().url(),
    attempts: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    status: z.enum(["pending", "unknown", "retryable", "failed", "succeeded"]),
    poll_attempts: z.number().int().nonnegative().optional(),
    last_polled_at: z.string().optional(),
    http_status: z.number().int().optional(),
    provider_request_id: ProviderRequestID.optional(),
    retry_reason: z.enum(["authentication", "rate_limit"]).optional(),
    retry_after_ms: z.number().int().min(0).max(2_000).optional(),
    retry_not_before: z.string().datetime().optional(),
    error: z.string().optional(),
    result: BioNemoHostedResult.optional(),
  })
  .strict()

// Version 1 mislabeled NVIDIA's API interface version as a model version. This
// reader exists only to migrate an in-flight dispatch without sending a second
// paid POST; version 1 records are rewritten to the truthful version 2 schema.
const LegacyBioNemoHostedResult = z
  .object({
    dispatch_id: z.string().optional(),
    capability: BioNemoCapabilityID,
    provider: z.literal("nvidia"),
    endpoint: z.string().url(),
    model_version: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    payload_bytes: z.number().int().nonnegative(),
    started_at: z.string(),
    completed_at: z.string(),
    root: z.string(),
    artifacts: BioNemoHostedArtifact.array(),
    provider_request_id: ProviderRequestID.optional(),
  })
  .strict()

const LegacyBioNemoDispatchRecord = z
  .object({
    schema_version: z.literal(1),
    dispatch_id: z.string(),
    session_id: z.string(),
    capability: BioNemoCapabilityID,
    provider: z.literal("nvidia"),
    endpoint: z.string().url(),
    host: z.string(),
    status_endpoint_template: z.literal("https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}"),
    status_host: z.literal("api.nvcf.nvidia.com"),
    model_version: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    payload_bytes: z.number().int().nonnegative(),
    terms_url: z.string().url(),
    attempts: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    status: z.enum(["pending", "unknown", "failed", "succeeded"]),
    poll_attempts: z.number().int().nonnegative().optional(),
    last_polled_at: z.string().optional(),
    http_status: z.number().int().optional(),
    provider_request_id: ProviderRequestID.optional(),
    error: z.string().optional(),
    result: LegacyBioNemoHostedResult.optional(),
  })
  .strict()

export type BioNemoDispatchRecord = z.infer<typeof BioNemoDispatchRecord>
export type BioNemoHostedPreview = z.infer<typeof BioNemoHostedPreview>
export type BioNemoHostedResult = z.infer<typeof BioNemoHostedResult>
export type BioNemoHostedPending = z.infer<typeof BioNemoHostedPending>

const file = () => path.join(Global.Path.data, "scientific-capability-hosted-dispatches.json")
const key = (sessionID: string, approval: string) => `nvidia:${sessionID}:${approval}`
const requestID = (headers: Headers) =>
  headers.get("nvcf-reqid") ??
  headers.get("nvcf-request-id") ??
  headers.get("x-request-id") ??
  headers.get("request-id") ??
  undefined

function base(input: { preview: BioNemoHostedPreview; sessionID: string; attempts: number }) {
  const host = new URL(input.preview.endpoint).host
  return {
    schema_version: 2 as const,
    dispatch_id: crypto.randomUUID(),
    session_id: input.sessionID,
    capability: input.preview.capability,
    provider: "nvidia" as const,
    endpoint: input.preview.endpoint,
    host,
    status_endpoint_template: input.preview.status_endpoint_template,
    status_host: input.preview.status_host,
    api_schema_version: input.preview.api_schema_version,
    request_sha256: input.preview.request_sha256,
    approval_sha256: input.preview.approval_sha256,
    payload_bytes: input.preview.payload_bytes,
    terms_url: input.preview.terms_url,
    attempts: input.attempts,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function migrateLegacy(input: {
  value: unknown
  preview: BioNemoHostedPreview
  sessionID: string
  legacyApprovalSha256: string
}) {
  const legacy = LegacyBioNemoDispatchRecord.safeParse(input.value)
  if (!legacy.success) return undefined
  const record = legacy.data
  if (
    record.session_id !== input.sessionID ||
    record.capability !== input.preview.capability ||
    record.endpoint !== input.preview.endpoint ||
    record.host !== new URL(input.preview.endpoint).host ||
    record.status_endpoint_template !== input.preview.status_endpoint_template ||
    record.status_host !== input.preview.status_host ||
    record.model_version !== input.preview.api_schema_version ||
    record.request_sha256 !== input.preview.request_sha256 ||
    record.approval_sha256 !== input.legacyApprovalSha256 ||
    record.payload_bytes !== input.preview.payload_bytes ||
    record.terms_url !== input.preview.terms_url
  )
    return undefined

  const { schema_version: _schemaVersion, model_version, approval_sha256: _approval, result, ...rest } = record
  let migratedResult: BioNemoHostedResult | undefined
  if (result) {
    const { model_version: resultSchema, approval_sha256: _resultApproval, ...resultRest } = result
    if (
      resultSchema !== model_version ||
      result.capability !== record.capability ||
      result.endpoint !== record.endpoint ||
      result.request_sha256 !== record.request_sha256 ||
      result.approval_sha256 !== record.approval_sha256 ||
      result.payload_bytes !== record.payload_bytes
    )
      return undefined
    migratedResult = BioNemoHostedResult.parse({
      ...resultRest,
      api_schema_version: resultSchema,
      approval_sha256: input.preview.approval_sha256,
    })
  }
  return BioNemoDispatchRecord.parse({
    ...rest,
    schema_version: 2,
    api_schema_version: model_version,
    approval_sha256: input.preview.approval_sha256,
    result: migratedResult,
  })
}

export namespace BioNemoHostedDispatch {
  export async function get(input: { approvalSha256: string; sessionID: string }) {
    const data = await JsonStore.read(file())
    const parsed = BioNemoDispatchRecord.safeParse(data[key(input.sessionID, input.approvalSha256)])
    return parsed.success ? parsed.data : undefined
  }

  export async function begin(input: {
    preview: BioNemoHostedPreview
    sessionID: string
    legacyApprovalSha256?: string
  }) {
    let existing: BioNemoDispatchRecord | undefined
    let created: BioNemoDispatchRecord | undefined
    await JsonStore.update(file(), (data) => {
      const currentKey = key(input.sessionID, input.preview.approval_sha256)
      let current = BioNemoDispatchRecord.safeParse(data[currentKey]).data
      if (!current && input.legacyApprovalSha256) {
        const legacyKey = key(input.sessionID, input.legacyApprovalSha256)
        current = migrateLegacy({
          value: data[legacyKey],
          preview: input.preview,
          sessionID: input.sessionID,
          legacyApprovalSha256: input.legacyApprovalSha256,
        })
        if (current) {
          data[currentKey] = current
          delete data[legacyKey]
        }
      }
      if (
        current?.status === "pending" ||
        current?.status === "unknown" ||
        current?.status === "retryable" ||
        current?.status === "failed" ||
        current?.status === "succeeded"
      ) {
        existing = current
        return
      }
      created = BioNemoDispatchRecord.parse({
        ...base({
          preview: input.preview,
          sessionID: input.sessionID,
          attempts: current ? current.attempts + 1 : 1,
        }),
        status: "pending",
        poll_attempts: 0,
      })
      data[currentKey] = created
    })
    return { existing, created: created! }
  }

  /** Atomically converts one explicitly retryable rejection into one new POST
   *  claim. The caller reaches this only after the next tool invocation has
   *  obtained another one-time approval. Concurrent callers cannot both claim
   *  the same retry. */
  export async function claimRetry(input: { preview: BioNemoHostedPreview; sessionID: string }) {
    let existing: BioNemoDispatchRecord | undefined
    let created: BioNemoDispatchRecord | undefined
    await JsonStore.update(file(), (data) => {
      const currentKey = key(input.sessionID, input.preview.approval_sha256)
      const current = BioNemoDispatchRecord.safeParse(data[currentKey]).data
      if (!current || current.status !== "retryable") {
        existing = current
        return
      }
      const notBefore = current.retry_not_before ? Date.parse(current.retry_not_before) : 0
      if (Number.isFinite(notBefore) && notBefore > Date.now()) {
        existing = current
        return
      }
      created = BioNemoDispatchRecord.parse({
        ...base({
          preview: input.preview,
          sessionID: input.sessionID,
          attempts: current.attempts + 1,
        }),
        dispatch_id: current.dispatch_id,
        created_at: current.created_at,
        status: "pending",
        poll_attempts: current.poll_attempts ?? 0,
      })
      data[currentKey] = created
    })
    return { existing, created }
  }

  export async function fail(input: {
    preview: BioNemoHostedPreview
    sessionID: string
    status: "failed" | "unknown"
    error: string
    http_status?: number
    provider_request_id?: string
  }) {
    let record: BioNemoDispatchRecord | undefined
    await JsonStore.update(file(), (data) => {
      const current = BioNemoDispatchRecord.safeParse(data[key(input.sessionID, input.preview.approval_sha256)]).data
      record = BioNemoDispatchRecord.parse({
        ...(current ??
          base({
            preview: input.preview,
            sessionID: input.sessionID,
            attempts: 1,
          })),
        session_id: input.sessionID,
        updated_at: new Date().toISOString(),
        status: input.status,
        http_status: input.http_status,
        provider_request_id: input.provider_request_id,
        error: input.error,
      })
      data[key(input.sessionID, input.preview.approval_sha256)] = record
    })
    return record!
  }

  export async function retryable(input: {
    preview: BioNemoHostedPreview
    sessionID: string
    reason: "authentication" | "rate_limit"
    retry_after_ms: number
    error: string
    http_status: 401 | 403 | 429
  }) {
    let record: BioNemoDispatchRecord | undefined
    await JsonStore.update(file(), (data) => {
      const current = BioNemoDispatchRecord.safeParse(data[key(input.sessionID, input.preview.approval_sha256)]).data
      const delay = Math.max(0, Math.min(2_000, Math.trunc(input.retry_after_ms)))
      record = BioNemoDispatchRecord.parse({
        ...(current ??
          base({
            preview: input.preview,
            sessionID: input.sessionID,
            attempts: 1,
          })),
        session_id: input.sessionID,
        updated_at: new Date().toISOString(),
        status: "retryable",
        http_status: input.http_status,
        provider_request_id: undefined,
        retry_reason: input.reason,
        retry_after_ms: delay,
        retry_not_before: new Date(Date.now() + delay).toISOString(),
        error: input.error,
      })
      data[key(input.sessionID, input.preview.approval_sha256)] = record
    })
    return record!
  }

  export async function pending(input: {
    preview: BioNemoHostedPreview
    sessionID: string
    status: "pending" | "unknown"
    provider_request_id: string
    http_status?: number
    error?: string
    polled?: boolean
  }) {
    let record: BioNemoDispatchRecord | undefined
    await JsonStore.update(file(), (data) => {
      const current = BioNemoDispatchRecord.safeParse(data[key(input.sessionID, input.preview.approval_sha256)]).data
      const now = new Date().toISOString()
      record = BioNemoDispatchRecord.parse({
        ...(current ??
          base({
            preview: input.preview,
            sessionID: input.sessionID,
            attempts: 1,
          })),
        session_id: input.sessionID,
        updated_at: now,
        status: input.status,
        http_status: input.http_status,
        provider_request_id: input.provider_request_id,
        poll_attempts: (current?.poll_attempts ?? 0) + (input.polled ? 1 : 0),
        last_polled_at: input.polled ? now : current?.last_polled_at,
        error: input.error,
      })
      data[key(input.sessionID, input.preview.approval_sha256)] = record
    })
    return record!
  }

  export async function succeed(input: {
    preview: BioNemoHostedPreview
    sessionID: string
    result: BioNemoHostedResult
    http_status: number
    provider_request_id?: string
  }) {
    let record: BioNemoDispatchRecord | undefined
    await JsonStore.update(file(), (data) => {
      const current = BioNemoDispatchRecord.safeParse(data[key(input.sessionID, input.preview.approval_sha256)]).data
      record = BioNemoDispatchRecord.parse({
        ...(current ??
          base({
            preview: input.preview,
            sessionID: input.sessionID,
            attempts: 1,
          })),
        session_id: input.sessionID,
        updated_at: new Date().toISOString(),
        status: "succeeded",
        http_status: input.http_status,
        provider_request_id: input.provider_request_id,
        error: undefined,
        result: { ...input.result, dispatch_id: current?.dispatch_id ?? input.result.dispatch_id },
      })
      data[key(input.sessionID, input.preview.approval_sha256)] = record
    })
    return record!
  }

  export function providerRequestID(headers: Headers) {
    return requestID(headers)
  }
}
