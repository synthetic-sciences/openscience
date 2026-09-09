/**
 * Shared HTTP helper for scientific connectors.
 *
 * Wraps Bun's global `fetch` with the concerns every connector shares:
 *   - request timeout (AbortController)
 *   - a polite, identifiable User-Agent
 *   - automatic retry with exponential backoff on 429 / 5xx
 *   - a small in-memory TTL cache for idempotent GETs
 *   - json()/text() convenience helpers
 *
 * No API keys, no auth — every source used here is public/open. Connectors that
 * need auth should layer it on top explicitly rather than baking it in here.
 */

import type { RateLimit } from "./types"
import { Network } from "@/settings/network"
import { AsyncLocalStorage } from "node:async_hooks"

const USER_AGENT = "openscience-science/1.0 (+https://github.com/synthetic-sciences/OpenScience)"
const DEFAULT_TIMEOUT = 30_000
const DEFAULT_RETRIES = 3
const DEFAULT_CACHE_TTL = 5 * 60_000 // 5 minutes

export interface HttpOptions extends Omit<RequestInit, "signal"> {
  /** Request timeout in ms (default 30s). */
  timeout?: number
  /** Retry attempts on 429/5xx (default 3). */
  retries?: number
  /** External abort signal; combined with the internal timeout signal. */
  signal?: AbortSignal
  /** For getText endpoints documenting an empty 2xx JSON body as a missing record. */
  allowEmptyBody?: boolean
  /** Cache TTL in ms for this request. 0 disables caching (default: GET=5min, else 0). */
  cacheTtl?: number
  /** Optional per-host politeness throttle (min interval between + max concurrency). */
  rateLimit?: RateLimit
  /**
   * Cache gate: return `false` to keep a 2xx body OUT of the cache (e.g. a
   * source that answered with HTML/empty instead of the expected payload).
   * Empty bodies are never cached regardless.
   */
  looksValid?: (body: string) => boolean
  /** Deterministic resolver seam for connector unit tests. Production
   * connectors omit this and use the operating-system DNS resolver. */
  resolveAddresses?: Network.FetchPolicy["resolveAddresses"]
}

interface CacheEntry {
  expires: number
  status: number
  headers: Record<string, string>
  body: string
}

/** A non-ok HTTP response. Terminal by construction: retryable statuses are
 * handled before this is thrown, so reaching it means "do not retry". */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "HttpStatusError"
  }
}

export class SourceResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SourceResponseError"
  }
}

function parseJSON<T>(body: string): T {
  const value: unknown = JSON.parse(body)
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const failure = record.error ?? record.errors
    if (
      (typeof failure === "string" && failure.length > 0) ||
      (Array.isArray(failure) && failure.length > 0) ||
      (failure && typeof failure === "object" && !Array.isArray(failure) && Object.keys(failure).length > 0) ||
      record.STATUS === "ERROR"
    ) {
      throw new SourceResponseError(
        `Scientific source reported an error: ${JSON.stringify(failure ?? record).slice(0, 500)}`,
      )
    }
  }
  return value as T
}

/** Use only for endpoints whose documented missing-record response is 404. */
export async function orNotFound<T>(request: Promise<T>, fallback: T): Promise<T> {
  try {
    return await request
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404) return fallback
    throw error
  }
}

// Source errors are visible to the agent. A provider may echo the credential
// supplied in its URL or headers, so remove those values before surfacing it.
function redactRequestError(error: unknown, url: string, headers: Record<string, string>): void {
  if (!(error instanceof Error)) return
  const values = [
    ...[...new URL(url).searchParams]
      .filter(([name]) => /key|token|secret|password|credential/i.test(name))
      .map(([, value]) => value),
    ...Object.entries(headers)
      .filter(([name]) => /authorization|key|token|secret|cookie/i.test(name))
      .map(([, value]) => value),
  ].flatMap((value) => [value, value.replace(/^Bearer\s+/i, ""), encodeURIComponent(value)])
  for (const value of values) if (value) error.message = error.message.replaceAll(value, "[REDACTED]")
}

const cache = new Map<string, CacheEntry>()

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const stop = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }, ms)
    signal?.addEventListener("abort", stop, { once: true })
    // Don't let a lone pacing/backoff timer keep the process (or a test run) alive.
    ;(timer as { unref?: () => void }).unref?.()
  })

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599)
}

function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  return b ? AbortSignal.any([a, b]) : a
}

async function wait<T>(pending: Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!signal) return pending
  const aborted = Promise.withResolvers<never>()
  const stop = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", stop, { once: true })
  try {
    return await Promise.race([pending, aborted.promise])
  } finally {
    signal.removeEventListener("abort", stop)
  }
}

// ── per-host rate limiting (opt-in via HttpOptions.rateLimit) ────────────────
// Pacing serializes + spaces request STARTS to a single host; the concurrency
// cap bounds in-flight requests to that host. Keyed by host so unrelated
// sources are never over-serialized.

interface ThrottleState {
  pace: Map<string, Promise<void>>
  active: Map<string, number>
  waiters: Map<string, Array<() => void>>
}

function throttleState(): ThrottleState {
  return testContext.getStore()?.throttle ?? productionThrottle
}

function newThrottleState(): ThrottleState {
  return { pace: new Map(), active: new Map(), waiters: new Map() }
}

const productionThrottle = newThrottleState()

/** Request-local transport seam for deterministic connector integration tests.
 * AsyncLocalStorage keeps concurrent Bun test files from racing through the
 * process-global fetch function; production requests never enter this scope. */
export interface HttpTestPolicy {
  resolveAddresses: NonNullable<Network.FetchPolicy["resolveAddresses"]>
  transport: NonNullable<Network.FetchPolicy["transport"]>
}

interface HttpTestContext extends HttpTestPolicy {
  throttle: ThrottleState
}

const testContext = new AsyncLocalStorage<HttpTestContext>()

export function withHttpTestPolicy<T>(policy: HttpTestPolicy, action: () => T): T {
  return testContext.run({ ...policy, throttle: newThrottleState() }, action)
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * Resolve when this host may start another request. The first request in an
 * idle window returns immediately; each subsequent one is held until
 * `minIntervalMs` after the previous request began.
 */
function pace(host: string, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
  const state = throttleState()
  const ready = state.pace.get(host) ?? Promise.resolve()
  const admitted = wait(ready, signal)
  // A cancelled queued request adds no cooldown. Later requests still wait
  // for the preceding actual admission, preserving the host's start spacing.
  const next = admitted.then(
    () => sleep(minIntervalMs),
    () => ready,
  )
  state.pace.set(host, next)
  void next.then(() => {
    if (state.pace.get(host) === next) state.pace.delete(host)
  })
  return admitted
}

/** Take an in-flight slot for this host, waiting if `maxConcurrent` is reached. */
function acquire(host: string, maxConcurrent: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const state = throttleState()
  const active = state.active.get(host) ?? 0
  if (active < maxConcurrent) {
    state.active.set(host, active + 1)
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const queue = state.waiters.get(host) ?? []
    const admit = () => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }
    const stop = () => {
      const index = queue.indexOf(admit)
      if (index !== -1) queue.splice(index, 1)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", stop, { once: true })
    queue.push(admit)
    state.waiters.set(host, queue)
  })
}

/** Release an in-flight slot, handing it straight to the next waiter if any. */
function release(host: string): void {
  const state = throttleState()
  const next = state.waiters.get(host)?.shift()
  if (next) return next()
  const active = state.active.get(host) ?? 1
  state.active.set(host, Math.max(0, active - 1))
}

/** Apply the optional per-host throttle; returns a `release` to call when done. */
async function throttle(url: string, limit?: RateLimit, signal?: AbortSignal): Promise<() => void> {
  const host = hostOf(url)
  if (!host || !limit) return () => {}
  if (limit.minIntervalMs && limit.minIntervalMs > 0) await pace(host, limit.minIntervalMs, signal)
  if (limit.maxConcurrent && limit.maxConcurrent > 0) {
    await acquire(host, limit.maxConcurrent, signal)
    return () => release(host)
  }
  return () => {}
}

/**
 * Perform an HTTP request with timeout, retry/backoff, and optional caching.
 * Returns a normalized response object with `json()` / `text()` helpers.
 */
export async function request(url: string, opts: HttpOptions = {}) {
  opts.signal?.throwIfAborted()
  await Network.assertAllowed(url)
  opts.signal?.throwIfAborted()
  const method = (opts.method ?? "GET").toUpperCase()
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const retries = opts.retries ?? DEFAULT_RETRIES
  const cacheable = method === "GET"
  const ttl = opts.cacheTtl ?? (cacheable ? DEFAULT_CACHE_TTL : 0)
  const cacheKey = ttl > 0 ? `${method} ${url}` : undefined

  if (cacheKey) {
    const hit = cache.get(cacheKey)
    if (hit && hit.expires > Date.now()) return toResponse(hit.status, hit.headers, hit.body)
    if (hit) cache.delete(cacheKey)
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    // Neutral by default so XML/text sources (arXiv, PubMed EFetch) aren't asked
    // for JSON. `getJSON` sets `Accept: application/json` explicitly.
    Accept: "*/*",
    ...(opts.headers as Record<string, string> | undefined),
  }
  const { resolveAddresses, ...fetchOptions } = opts

  const done = await throttle(url, opts.rateLimit, opts.signal)
  try {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      opts.signal?.throwIfAborted()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const signal = combineSignals(controller.signal, opts.signal)
      try {
        const scopedPolicy = testContext.getStore()
        const res = await Network.fetch(
          url,
          { ...fetchOptions, method, headers, signal },
          {
            resolveAddresses: resolveAddresses ?? scopedPolicy?.resolveAddresses,
            transport: scopedPolicy?.transport,
          },
        )
        const body = await res.text()
        opts.signal?.throwIfAborted()
        if (!res.ok && isRetryable(res.status) && attempt < retries) {
          const backoff = backoffMs(res, attempt)
          if (backoff > MAX_BACKOFF) {
            throw new HttpStatusError(
              res.status,
              `HTTP ${res.status} for ${url}: source requests a ${Math.ceil(backoff / 1000)} second cooldown; no automatic retry`,
            )
          }
          clearTimeout(timer)
          await sleep(backoff, opts.signal)
          continue
        }
        if (!res.ok) {
          throw new HttpStatusError(
            res.status,
            `HTTP ${res.status} for ${url}: ${body.slice(0, 500) || res.statusText}`,
          )
        }
        if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body)) {
          throw new SourceResponseError(
            "Scientific source returned an HTML page instead of scientific data (possibly a verification or service-error page)",
          )
        }
        // Parse before caching, including GraphQL's successful-HTTP error envelopes.
        const jsonExpected =
          headers.Accept?.includes("application/json") ||
          /(?:application\/json|\+json)\b/i.test(res.headers.get("content-type") ?? "")
        if (jsonExpected && !(opts.allowEmptyBody && body.trim().length === 0)) parseJSON(body)
        else if (/^\s*[\[{]/.test(body)) {
          // Text formats can begin with a bracket (e.g. an SDF title [Na+]).
          // Recognize valid JSON error envelopes without treating all such files as JSON.
          try {
            parseJSON(body)
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error
          }
        }
        const record: CacheEntry = {
          expires: Date.now() + ttl,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body,
        }
        // Don't poison the cache with empty or caller-rejected (e.g. non-Atom) bodies.
        const valid = body.trim().length > 0 && (opts.looksValid?.(body) ?? true)
        if (cacheKey && valid) cache.set(cacheKey, record)
        clearTimeout(timer)
        return toResponse(record.status, record.headers, record.body)
      } catch (err) {
        clearTimeout(timer)
        redactRequestError(err, url, headers)
        lastError = err
        // Abort from the caller's signal is terminal; internal timeout retries.
        if (opts.signal?.aborted) throw err
        // A non-retryable HTTP status is terminal — don't burn retries on a 404.
        if (err instanceof HttpStatusError) throw err
        if (err instanceof SourceResponseError || err instanceof SyntaxError) throw err
        if (attempt < retries) {
          await sleep(backoffMs(undefined, attempt), opts.signal)
          continue
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`)
  } finally {
    done()
  }
}

const MAX_BACKOFF = 15_000

/** Preserve server cooldowns; request() returns promptly when they exceed its retry budget. */
export function backoffMs(res: Response | undefined, attempt: number): number {
  const retryAfter = res?.headers.get("retry-after")?.trim()
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 250), MAX_BACKOFF)
}

function toResponse(status: number, headers: Record<string, string>, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: () => body,
    json: <T = unknown>(): T => parseJSON<T>(body),
  }
}

/** Shorthand: GET + parse JSON. Sets `Accept: application/json` (caller can override). */
export async function getJSON<T = unknown>(url: string, opts?: HttpOptions): Promise<T> {
  const res = await request(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts?.headers as Record<string, string> | undefined) },
  })
  return res.json<T>()
}

/** Shorthand: GET + return text. */
export async function getText(url: string, opts?: HttpOptions): Promise<string> {
  const res = await request(url, opts)
  return res.text()
}

/** Clear the in-memory cache (test/debug helper). */
export function clearCache(): void {
  cache.clear()
}

/** Reset per-host rate-limit pacing + concurrency state (test/debug helper). */
export function resetRateLimits(): void {
  const state = throttleState()
  state.pace.clear()
  state.active.clear()
  state.waiters.clear()
}
