/**
 * Gzip for managed model request bodies (OPENSCIENCE_MANAGED_GZIP=1).
 *
 * A managed request carries the system prompt, tools and the whole history,
 * ~60 KB at the start of a session and growing. Over a long path to the
 * gateway the upload alone costs several round trips (TCP slow start), so it
 * is compressed (~3x on real requests, under a millisecond).
 *
 * The gateway says it can read gzip bodies with an
 * `x-openscience-request-encoding: gzip` reply header. Bodies are compressed
 * only for a gateway origin that has sent it, so the first call of a process,
 * and any gateway without support, get the plain body.
 *
 * A gateway can stop reading gzip after it advertised it: a rollback, or a
 * deploy that is half done, so some machines still run the old version. Such
 * a reply (`refused`) makes the caller resend the plain body once, and the
 * origin gets plain bodies for `COOLDOWN_MS` even if a newer machine
 * advertises gzip again meanwhile.
 */
export namespace ManagedGzip {
  export const HEADER = "x-openscience-request-encoding"
  /** Below this a body fits in the first round trip anyway. */
  export const MIN_BYTES = 8 * 1024

  /** How long a gateway that refused a gzip body gets plain bodies only. */
  export const COOLDOWN_MS = 10 * 60_000
  /** Errors meaning "could not read this body": the old gateway sees broken
   * JSON (before claiming the idempotency key); a new one reports the gzip. */
  const REFUSALS = new Set(["invalid_json", "invalid_content_encoding", "unsupported_content_encoding"])

  const accepted = new Set<string>()
  const refusedUntil = new Map<string, number>()

  function origin(endpoint: string) {
    try {
      return new URL(endpoint).origin
    } catch {
      return undefined
    }
  }

  export function enabled(env: NodeJS.ProcessEnv = process.env) {
    const value = (env["OPENSCIENCE_MANAGED_GZIP"] ?? "").toLowerCase()
    return value === "1" || value === "true"
  }

  /** Record whether the gateway behind `endpoint` reads gzip bodies. */
  export function learn(endpoint: string, headers: Headers) {
    const key = origin(endpoint)
    const value = headers.get(HEADER)
    if (!key || !value) return
    if ((refusedUntil.get(key) ?? 0) > Date.now()) return
    if (value.split(",").some((part) => part.trim().toLowerCase() === "gzip")) accepted.add(key)
  }

  /** Stop compressing for `endpoint`'s gateway for `COOLDOWN_MS`. */
  export function forget(endpoint: string) {
    const key = origin(endpoint)
    if (!key) return
    accepted.delete(key)
    refusedUntil.set(key, Date.now() + COOLDOWN_MS)
  }

  /** Whether the gateway could not read a gzip body it was sent. Reads a
   * clone, so the caller can still return the response untouched. */
  export async function refused(response: Response) {
    if (response.status === 415) return true
    if (response.status !== 400) return false
    const body = (await response
      .clone()
      .json()
      .catch(() => undefined)) as { detail?: { error?: unknown } } | undefined
    return typeof body?.detail?.error === "string" && REFUSALS.has(body.detail.error)
  }

  /** The gzip body to send instead of `body`, or undefined to send it as is. */
  export function encode(endpoint: string, body: string): Uint8Array<ArrayBuffer> | undefined {
    if (!enabled()) return
    const key = origin(endpoint)
    if (!key || !accepted.has(key) || Buffer.byteLength(body) < MIN_BYTES) return
    return Bun.gzipSync(Buffer.from(body), { level: 6 })
  }

  /** Test hook. */
  export function reset() {
    accepted.clear()
    refusedUntil.clear()
  }
}
