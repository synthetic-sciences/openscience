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

const USER_AGENT = "openscience-science/1.0 (+https://syntheticsciences.ai)"
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
}

interface CacheEntry {
  expires: number
  status: number
  headers: Record<string, string>
  body: string
}

/** A non-ok HTTP response. Terminal by construction: retryable statuses are
 * handled before this is thrown, so reaching it means "do not retry". */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "HttpStatusError"
  }
}

const cache = new Map<string, CacheEntry>()

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Don't let a lone pacing/backoff timer keep the process (or a test run) alive.
    ;(timer as { unref?: () => void }).unref?.()
  })

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599)
}

function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  for (const sig of [a, b]) {
    if (sig.aborted) {
      controller.abort()
      break
    }
    sig.addEventListener("abort", onAbort, { once: true })
  }
  return controller.signal
}

// ── per-host rate limiting (opt-in via HttpOptions.rateLimit) ────────────────
// Pacing serializes + spaces request STARTS to a single host; the concurrency
// cap bounds in-flight requests to that host. Keyed by host so unrelated
// sources are never over-serialized.

const hostPace = new Map<string, Promise<void>>()
const hostActive = new Map<string, number>()
const hostWaiters = new Map<string, Array<() => void>>()

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
function pace(host: string, minIntervalMs: number): Promise<void> {
  const ready = hostPace.get(host) ?? Promise.resolve()
  hostPace.set(
    host,
    ready.then(() => sleep(minIntervalMs)),
  )
  return ready
}

/** Take an in-flight slot for this host, waiting if `maxConcurrent` is reached. */
function acquire(host: string, maxConcurrent: number): Promise<void> {
  const active = hostActive.get(host) ?? 0
  if (active < maxConcurrent) {
    hostActive.set(host, active + 1)
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const queue = hostWaiters.get(host) ?? []
    queue.push(resolve)
    hostWaiters.set(host, queue)
  })
}

/** Release an in-flight slot, handing it straight to the next waiter if any. */
function release(host: string): void {
  const next = hostWaiters.get(host)?.shift()
  if (next) return next()
  const active = hostActive.get(host) ?? 1
  hostActive.set(host, Math.max(0, active - 1))
}

/** Apply the optional per-host throttle; returns a `release` to call when done. */
async function throttle(url: string, limit?: RateLimit): Promise<() => void> {
  const host = hostOf(url)
  if (!host || !limit) return () => {}
  if (limit.minIntervalMs && limit.minIntervalMs > 0) await pace(host, limit.minIntervalMs)
  if (limit.maxConcurrent && limit.maxConcurrent > 0) {
    await acquire(host, limit.maxConcurrent)
    return () => release(host)
  }
  return () => {}
}

/**
 * Perform an HTTP request with timeout, retry/backoff, and optional caching.
 * Returns a normalized response object with `json()` / `text()` helpers.
 */
export async function request(url: string, opts: HttpOptions = {}) {
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

  const done = await throttle(url, opts.rateLimit)
  try {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const signal = combineSignals(controller.signal, opts.signal)
      try {
        const res = await fetch(url, { ...opts, method, headers, signal })
        const body = await res.text()
        if (!res.ok && isRetryable(res.status) && attempt < retries) {
          const backoff = backoffMs(res, attempt)
          clearTimeout(timer)
          await sleep(backoff)
          continue
        }
        if (!res.ok) {
          throw new HttpStatusError(
            res.status,
            `HTTP ${res.status} for ${url}: ${body.slice(0, 500) || res.statusText}`,
          )
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
        lastError = err
        // Abort from the caller's signal is terminal; internal timeout retries.
        if (opts.signal?.aborted) throw err
        // A non-retryable HTTP status is terminal — don't burn retries on a 404.
        if (err instanceof HttpStatusError) throw err
        if (attempt < retries) {
          await sleep(backoffMs(undefined, attempt))
          continue
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`)
  } finally {
    done()
  }
}

function backoffMs(res: Response | undefined, attempt: number): number {
  const retryAfter = res?.headers.get("retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return seconds * 1000
  }
  return Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 250)
}

function toResponse(status: number, headers: Record<string, string>, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: () => body,
    json: <T = unknown>(): T => JSON.parse(body) as T,
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

/**
 * Await `p`, but on failure return `fallback` instead — UNLESS the caller's
 * `signal` was aborted, in which case rethrow so cancellation propagates.
 *
 * Connectors use this instead of a blanket `.catch(() => fallback)`: that
 * pattern swallows the AbortError `request()` deliberately rethrows on caller
 * abort, so a cancelled `science_search` looked like "no results" instead of a
 * clean cancellation. An internal request timeout still falls back (the caller
 * didn't cancel), which is the intended behavior — one slow source shouldn't
 * fail the whole search.
 */
export async function orFallback<T>(p: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  try {
    return await p
  } catch (err) {
    if (signal?.aborted) throw err
    return fallback
  }
}

/** Clear the in-memory cache (test/debug helper). */
export function clearCache(): void {
  cache.clear()
}

/** Reset per-host rate-limit pacing + concurrency state (test/debug helper). */
export function resetRateLimits(): void {
  hostPace.clear()
  hostActive.clear()
  hostWaiters.clear()
}
