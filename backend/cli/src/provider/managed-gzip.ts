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
 * and any gateway without support, get the plain body. A 415 reply makes the
 * caller forget the origin and resend the plain body.
 */
export namespace ManagedGzip {
  export const HEADER = "x-openscience-request-encoding"
  /** Below this a body fits in the first round trip anyway. */
  export const MIN_BYTES = 8 * 1024

  const accepted = new Set<string>()

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
    if (value.split(",").some((part) => part.trim().toLowerCase() === "gzip")) accepted.add(key)
  }

  export function forget(endpoint: string) {
    const key = origin(endpoint)
    if (key) accepted.delete(key)
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
  }
}
