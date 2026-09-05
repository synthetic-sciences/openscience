import type { NamedError } from "@synsci/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@synsci/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  // Codes that unambiguously mean "TOTAL input too big". Deliberately small — never
  // generic buckets like `invalid_request_error`, which also cover bad params. Excludes
  // OpenAI's `string_above_max_length`: it fires when a SINGLE string field exceeds its
  // per-field limit — an oversized arg, not total-context overflow — which compaction can't
  // fix. Such an error is only treated as overflow if its message also matches a pattern.
  const OVERFLOW_CODES = new Set(["context_length_exceeded"])

  // Substrings from the human-readable message of a context-window rejection.
  // Cross-provider fallback: Anthropic has no dedicated code, Gemini uses the
  // generic INVALID_ARGUMENT — but the message always describes the condition.
  //
  // Deliberately excludes generic phrasings that also appear in retryable
  // RATE-LIMIT (429/TPM) guidance — "too many tokens", "reduce the length",
  // "reduce your prompt" — so a transient rate limit isn't misclassified as a
  // deterministic overflow and turned into a terminal error. Rate limits are
  // additionally excluded by the 429 guard in isContextOverflow.
  const OVERFLOW_PATTERNS = [
    "context length",
    "context window",
    "maximum context",
    "exceeds the context",
    "prompt is too long",
    "input is too long",
    "too long for the model",
    "input token count",
    "maximum prompt length",
  ]

  // Explicit transient / rate-limit signals. Streamed errors arrive as
  // NamedError.Unknown with NO statusCode, so the numeric 5xx/429 guards in
  // isContextOverflow can't protect them; a transient failure whose text mentions
  // tokens (e.g. a Gemini quota message carrying "input token count") would otherwise
  // match an OVERFLOW_PATTERN and be turned into a terminal "too large" error. These
  // phrases mark it retryable, never a deterministic overflow.
  const RATELIMIT_PATTERNS = [
    "rate limit",
    "rate_limit",
    "too many requests",
    "quota",
    "resource exhausted",
    "resource_exhausted",
    "overloaded",
    "please try again",
    "try again later",
    "temporarily unavailable",
  ]

  const asString = (value: unknown) => (typeof value === "string" ? value : "")

  // Flatten any provider error — HTTP responseBody or in-stream error chunk —
  // into one canonical { statusCode, code, message } so a single classifier
  // runs over every provider's differing JSON shape.
  function normalizeProviderError(error: ReturnType<NamedError["toObject"]>) {
    const isApi = MessageV2.APIError.isInstance(error)
    let statusCode = isApi ? error.data.statusCode : undefined
    const raw = asString(error.data?.message)
    let code = ""
    let type = ""
    let message = raw
    for (const source of [isApi ? error.data.responseBody : undefined, raw]) {
      if (!source) continue
      const json = iife(() => {
        try {
          return JSON.parse(source)
        } catch {
          return undefined
        }
      })
      if (!json || typeof json !== "object") continue
      const err =
        json.error && typeof json.error === "object"
          ? json.error
          : json.detail && typeof json.detail === "object"
            ? json.detail
            : json
      const nestedStatus = Number(
        err.statusCode ??
          err.status_code ??
          json.statusCode ??
          json.status_code ??
          // OpenRouter streamed errors use numeric `error.code` for the HTTP
          // class while omitting statusCode entirely (for example 502 with
          // metadata.error_type=provider_unavailable). Preserve that 5xx so a
          // message mentioning "context window" is not misclassified as a
          // deterministic overflow and compacted twice into a terminal error.
          (typeof err.code === "number" ? err.code : undefined) ??
          (typeof json.code === "number" ? json.code : undefined),
      )
      if (!statusCode && Number.isFinite(nestedStatus)) statusCode = nestedStatus
      // The managed gateway's idempotency guard answers with a bare
      // {"error":"operation_in_progress"} token rather than an error object.
      const token = typeof json.error === "string" && /^[a-z0-9_]+$/.test(json.error) ? json.error : ""
      code = asString(err.code) || asString(json.code) || token || code
      type =
        asString(err.type) ||
        asString(json.type) ||
        asString(err.metadata?.error_type) ||
        asString(json.metadata?.error_type) ||
        type
      message = asString(err.message) || asString(json.message) || message
      break
    }
    return { statusCode, code, type, message }
  }

  // True when the assembled request exceeds a context or HTTP payload limit.
  // A small new prompt can still carry an oversized conversation. Both limits
  // need the same bounded compact + resume path, never an identical retry.
  export function isContextOverflow(error: ReturnType<NamedError["toObject"]>): boolean {
    const { statusCode, code, type, message } = normalizeProviderError(error)
    if (statusCode === 429) return false
    // Gateways can reject the serialized body before the model sees it, with
    // only an HTML/plain-text 413 and no provider-specific context error code.
    // This is a byte limit, not proof that the model's token window is full.
    if (statusCode === 413) return true
    if (OVERFLOW_CODES.has(code) || OVERFLOW_CODES.has(type)) return true
    const lower = message.toLowerCase()
    // Catches transient failures with no statusCode (streamed error chunks) whose
    // text would otherwise match an overflow pattern — keep them retryable.
    if (RATELIMIT_PATTERNS.some((pattern) => lower.includes(pattern))) return false
    // OpenRouter can wrap an upstream context rejection in a 502 with
    // metadata.error_type=provider_unavailable. The explicit rejection remains
    // deterministic; retrying the identical request cannot recover.
    if (OVERFLOW_PATTERNS.some((pattern) => lower.includes(pattern))) return true
    if (statusCode && statusCode >= 500) return false
    return false
  }

  // Managed idempotency verdicts the gateway answers identically for this key.
  // The key is stable across attempts, so a session-level retry of the same
  // body can only reproduce the verdict; the provider fetch wrapper already
  // waited out a live original request.
  const MANAGED_TERMINAL_CODES = new Set([
    "managed_outcome_unknown",
    "managed_request_timeout",
    "managed_response_incomplete",
    "provider_request_timeout",
    "managed_conflict_timeout",
    "operation_in_progress",
    "idempotency_conflict",
    "idempotent_stream_already_started",
    "idempotent_response_not_replayable",
  ])

  // The gateway already dispatched this body once and cannot replay its
  // output (a sealed stream: 409 with the replay header from older gateways,
  // 410 from current ones), or cannot prove whether the provider ran it. The
  // provider may have billed that dispatch, so the body is never sent again
  // automatically; the user decides whether to pay for a second inference by
  // resubmitting.
  const MANAGED_DISPATCHED_CODES = new Set([
    "idempotent_stream_already_started",
    "idempotent_response_not_replayable",
    "managed_outcome_unknown",
  ])
  export const MANAGED_DISPATCHED_MESSAGE =
    "The gateway already dispatched this request and its output is no longer available. It may have been billed; sending it again will be billed again. Resubmit your message to retry."

  /** The error the user sees for a terminal provider failure. A dispatched
   * verdict carries the gateway's wire message, which explains the key, not
   * the billing consequence; replace it and pin the error non-retryable so no
   * client re-sends it. Every other error passes through untouched. */
  export function terminal<T extends ReturnType<NamedError["toObject"]>>(error: T): T | MessageV2.APIError {
    const normalized = normalizeProviderError(error)
    if (normalized.code === "managed_request_timeout" || normalized.code === "managed_response_incomplete") {
      return new MessageV2.APIError({
        message:
          (normalized.code === "managed_response_incomplete"
            ? "The managed response ended before confirming completion. "
            : "The managed response stopped making progress. ") +
          "Partial output and completed tool results are kept. OpenScience did not retry automatically. The provider may still bill this request; resubmitting starts a new request.",
        isRetryable: false,
        metadata: {
          code: normalized.code,
          openscience_state: "stopped",
          dispatch_state: "outcome_unknown",
          action: "resubmit",
        },
      }).toObject() as MessageV2.APIError
    }
    if (!MessageV2.APIError.isInstance(error)) return error
    if (!MANAGED_DISPATCHED_CODES.has(normalized.code)) return error
    return new MessageV2.APIError({
      ...error.data,
      message: MANAGED_DISPATCHED_MESSAGE,
      isRetryable: false,
    }).toObject() as MessageV2.APIError
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (isContextOverflow(error)) return undefined
    const normalized = normalizeProviderError(error)
    // The gateway cannot prove whether the provider accepted this request, or
    // has sealed its answer. Never redispatch it, even if the SDK's generic
    // status-code classification allows it.
    if (MANAGED_TERMINAL_CODES.has(normalized.code)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const { statusCode, code, type, message } = normalized
    const signal = `${code} ${type} ${message}`.toLowerCase()

    // Status-less provider stream errors arrive wrapped as UnknownError. Retry
    // only positive transient signals: the mere presence of an `error` object
    // is not evidence of a server failure. Deterministic policy, auth, missing
    // model and invalid-parameter errors must terminate on their first attempt.
    if (statusCode === 429 || type === "too_many_requests" || signal.includes("too many requests")) {
      return "Too Many Requests"
    }
    if (signal.includes("rate_limit") || signal.includes("rate limit")) return "Rate Limited"
    if (
      signal.includes("resource_exhausted") ||
      signal.includes("resource exhausted") ||
      signal.includes("unavailable") ||
      signal.includes("overloaded")
    ) {
      return "Provider is overloaded"
    }
    if (
      (statusCode !== undefined && statusCode >= 500) ||
      type === "server_error" ||
      type === "internal_error" ||
      code === "server_error" ||
      code === "internal_error" ||
      signal.includes("no_kv_space")
    ) {
      return "Provider Server Error"
    }
    return undefined
  }
}
