import http2 from "node:http2"
import { fetchWithFreshConnection } from "@/util/fetch"
import { Log } from "@/util/log"

/**
 * Reused HTTP/2 connection for managed model calls to the Ace gateway.
 *
 * Today every managed call opens a fresh TLS connection, because Bun's fetch
 * pool can reuse a silently half-open socket and hang the next request until
 * its timeout (#584). A fresh connection costs about two round trips before
 * the request is on the wire. This transport keeps one multiplexed HTTP/2
 * session per gateway origin and proves it alive instead of trusting it:
 *
 * - a PING leaves with every request on a reused session, and every
 *   `pingIntervalMs` while any request is open; no answer within
 *   `pingTimeoutMs` destroys the session and fails its open streams;
 * - an idle session closes after `idleCloseMs`, and one whose wall-clock idle
 *   time exceeds that (a laptop that slept) is discarded before reuse;
 * - a request whose connection died before response headers is sent once
 *   more on a new connection, only when it carries an Idempotency-Key (the
 *   gateway answers a duplicate with the in-progress or sealed verdict) or is
 *   a GET; never after headers, never after the caller aborted;
 * - Bun 1.3.14 ends (rather than errors) open streams when a session is
 *   destroyed, so a body that ends on a dead session is reported as an error,
 *   never as a complete reply.
 *
 * Anything this transport cannot carry safely uses the fresh connection as
 * before: the switch is off, a proxy is configured, the body is not a string
 * or bytes, the origin did not negotiate h2, its upload window is smaller
 * than `minWindow`, or connecting failed (the origin is then skipped for
 * `unsuitableMs`). Fly's edge drops an h2 connection that carries no request
 * within ~5 s, so a warmed connection sends a small GET straight away.
 */
export namespace ManagedH2 {
  const log = Log.create({ service: "managed-h2" })

  export type Options = {
    connectTimeoutMs: number
    pingIntervalMs: number
    pingTimeoutMs: number
    idleCloseMs: number
    minWindow: number
    unsuitableMs: number
    warmPath: string
    keepaliveMs: number
    keepWarmCheckMs: number
    keepWarmIdleStopMs: number
  }

  const defaults: Options = {
    connectTimeoutMs: 3_000,
    pingIntervalMs: 10_000,
    pingTimeoutMs: 5_000,
    // Just under Fly's edge, which closes an HTTP/2 connection 300 s after
    // its last request (PINGs do not count).
    idleCloseMs: 290_000,
    minWindow: 1 << 20,
    unsuitableMs: 5 * 60_000,
    warmPath: "/api/health",
    // Keep-warm: a request on a connection that carried none for this long
    // resets Fly's idle timer. /api/health answers from memory (no database).
    keepaliveMs: 240_000,
    keepWarmCheckMs: 30_000,
    // Stop keeping warm this long after the last activity.
    keepWarmIdleStopMs: 30 * 60_000,
  }
  let options: Options = { ...defaults }

  export class DeadConnection extends Error {
    readonly code = "MANAGED_H2_DEAD_CONNECTION"
    constructor(
      why: string,
      readonly afterHeaders: boolean,
    ) {
      super(`HTTP/2 connection to the gateway was lost: ${why}`)
      this.name = "ManagedH2DeadConnection"
    }
  }

  class Unsuitable extends Error {
    constructor(why: string) {
      super(why)
    }
  }

  type Session = {
    session: http2.ClientHttp2Session
    streams: number
    dead?: string
    draining?: boolean
    pingTimer?: ReturnType<typeof setInterval>
    idleTimer?: ReturnType<typeof setTimeout>
    lastActive: number
    lastRequest: number
    // Open requests fail through these when the session dies: Bun does not
    // reliably emit stream events for a session it was told to destroy.
    open: Set<(error: DeadConnection) => void>
  }

  const sessions = new Map<string, Promise<Session>>()
  const unsuitable = new Map<string, number>()
  export const stats = { connects: 0, reused: 0, retries: 0, deadDetected: 0, fallbacks: 0 }

  /** On when OPENSCIENCE_MANAGED_H2 is truthy and no proxy is configured
   * (node:http2 does not honour proxy variables; fetch does). */
  export function enabled(env: NodeJS.ProcessEnv = process.env) {
    const flag = (env["OPENSCIENCE_MANAGED_H2"] ?? "").toLowerCase()
    if (flag !== "1" && flag !== "true") return false
    return !["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((key) => env[key])
  }

  /** Test hook: override timings; returns a restore function. */
  export function configure(next: Partial<Options>) {
    const previous = options
    options = { ...options, ...next }
    return () => {
      options = previous
    }
  }

  export async function reset() {
    stopKeepWarm()
    const open = [...sessions.values()]
    sessions.clear()
    unsuitable.clear()
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0
    for (const pending of open) {
      const held = await pending.catch(() => undefined)
      if (held) kill(held, "reset")
    }
  }

  function kill(held: Session, why: string, origin?: string, pending?: Promise<Session>) {
    if (held.dead) return
    held.dead = why
    if (held.pingTimer) clearInterval(held.pingTimer)
    if (held.idleTimer) clearTimeout(held.idleTimer)
    if (origin && (!pending || sessions.get(origin) === pending)) sessions.delete(origin)
    for (const fail of [...held.open]) fail(new DeadConnection(why, false))
    held.open.clear()
    try {
      held.session.destroy()
    } catch {
      // already closed
    }
  }

  function ping(origin: string, held: Session) {
    if (held.dead) return
    const timer = setTimeout(() => {
      if (held.dead) return
      stats.deadDetected++
      log.warn("gateway connection did not answer a ping", { origin })
      kill(held, "ping timeout", origin)
    }, options.pingTimeoutMs)
    try {
      held.session.ping((error) => {
        clearTimeout(timer)
        if (error) kill(held, `ping failed: ${error.message}`, origin)
      })
    } catch (error) {
      clearTimeout(timer)
      kill(held, `ping failed: ${error instanceof Error ? error.message : String(error)}`, origin)
    }
  }

  function connect(origin: string): Promise<Session> {
    stats.connects++
    const pending: Promise<Session> = new Promise<Session>((resolve, reject) => {
      let settled = false
      const session = http2.connect(origin)
      const held: Session = { session, streams: 0, lastActive: Date.now(), lastRequest: Date.now(), open: new Set() }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        kill(held, error.message, origin, pending)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Unsuitable("connect timeout")), options.connectTimeoutMs)
      session.once("error", (error) => {
        if (!settled) fail(new Unsuitable(`connect failed: ${error.message}`))
        else kill(held, `session error: ${error.message}`, origin, pending)
      })
      session.once("close", () => kill(held, "closed", origin, pending))
      session.once("goaway", () => {
        held.draining = true
        if (sessions.get(origin) === pending) sessions.delete(origin)
      })
      session.once("connect", () => {
        if (session.alpnProtocol && session.alpnProtocol !== "h2" && session.alpnProtocol !== "h2c")
          return fail(new Unsuitable(`gateway negotiated ${session.alpnProtocol}`))
        settled = true
        clearTimeout(timer)
        resolve(held)
        // The server's SETTINGS (with its upload window) arrive one round trip
        // after the handshake. Requests do not wait for them: until then the
        // protocol's default 64 KiB window applies. A gateway that turns out
        // to advertise a small window stops taking new calls.
        const check = () => {
          const window = session.remoteSettings?.initialWindowSize ?? 0
          if (window >= options.minWindow || held.dead) return
          log.info("gateway upload window too small for connection reuse", { origin, window })
          unsuitable.set(origin, Date.now() + options.unsuitableMs)
          stats.fallbacks++
          held.draining = true
          if (sessions.get(origin) === pending) sessions.delete(origin)
          if (held.streams === 0) kill(held, "upload window too small", origin, pending)
        }
        if (session.remoteSettings?.initialWindowSize !== undefined && session.remoteSettings.initialWindowSize !== 65_535) check()
        else session.once("remoteSettings", check)
      })
    })
    sessions.set(origin, pending)
    pending.catch(() => {
      if (sessions.get(origin) === pending) sessions.delete(origin)
    })
    return pending
  }

  async function acquire(origin: string) {
    const existing = sessions.get(origin)
    if (existing) {
      const held = await existing.catch(() => undefined)
      const usable =
        held &&
        !held.dead &&
        !held.draining &&
        !held.session.closed &&
        !held.session.destroyed &&
        (held.streams > 0 || Date.now() - held.lastActive < options.idleCloseMs)
      if (usable) return { held, reused: true }
      if (held && !held.dead) kill(held, "idle past the cap", origin, existing)
    }
    return { held: await connect(origin), reused: false }
  }

  function begin(origin: string, held: Session) {
    if (held.idleTimer) clearTimeout(held.idleTimer)
    held.idleTimer = undefined
    held.lastActive = Date.now()
    held.lastRequest = held.lastActive
    if (held.streams++ === 0) {
      held.pingTimer = setInterval(() => ping(origin, held), options.pingIntervalMs)
      held.pingTimer.unref?.()
    }
  }

  function end(origin: string, held: Session) {
    held.lastActive = Date.now()
    if (--held.streams > 0 || held.dead) return
    if (held.pingTimer) clearInterval(held.pingTimer)
    held.pingTimer = undefined
    held.idleTimer = setTimeout(() => kill(held, "idle", origin), options.idleCloseMs)
    held.idleTimer.unref?.()
  }

  const hopByHop = new Set(["connection", "host", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te"])

  function once(url: URL, init: BunFetchRequestInit, held: Session, reused: boolean): Promise<Response> {
    const origin = url.origin
    begin(origin, held)
    if (reused) ping(origin, held)
    const method = (init.method ?? "GET").toUpperCase()
    const headers: http2.OutgoingHttpHeaders = {
      ":method": method,
      ":path": url.pathname + url.search,
      ":scheme": url.protocol.replace(":", ""),
      ":authority": url.host,
    }
    new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => {
      if (!hopByHop.has(key)) headers[key] = value
    })
    // The fresh-connection fetch decompresses; this transport does not.
    headers["accept-encoding"] = "identity"
    const signal = init.signal ?? undefined
    const body = init.body as string | Uint8Array | null | undefined
    return new Promise<Response>((resolve, reject) => {
      let settled = false
      let released = false
      const release = () => {
        if (released) return
        released = true
        end(origin, held)
      }
      if (signal?.aborted) {
        release()
        return reject(signal.reason)
      }
      let stream: http2.ClientHttp2Stream
      try {
        stream = held.session.request(headers, { endStream: body == null })
      } catch (error) {
        release()
        return reject(new DeadConnection(error instanceof Error ? error.message : String(error), false))
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const output = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value
          },
          pull() {
            stream.resume()
          },
          cancel() {
            stream.close(http2.constants.NGHTTP2_CANCEL)
            release()
          },
        },
        { highWaterMark: 16 },
      )
      const lost = (why: string, afterHeaders: boolean) => new DeadConnection(held.dead ?? why, afterHeaders)
      let ended = false
      const fail = (error: unknown) => {
        held.open.delete(fail)
        release()
        if (!settled) {
          settled = true
          reject(held.dead ? lost("stream failed", false) : error)
          return
        }
        try {
          controller.error(held.dead ? lost("stream failed", true) : error)
        } catch {
          // already closed
        }
      }
      held.open.add(fail)
      const onAbort = () => {
        stream.close(http2.constants.NGHTTP2_CANCEL)
        fail(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      stream.on("response", (incoming) => {
        settled = true
        held.lastActive = Date.now()
        const status = Number(incoming[":status"])
        const out = new Headers()
        for (const [key, value] of Object.entries(incoming)) {
          if (key.startsWith(":") || value == null) continue
          if (Array.isArray(value)) for (const item of value) out.append(key, item)
          else out.set(key, String(value))
        }
        if (status >= 300 && status < 400 && init.redirect === "error") {
          stream.close(http2.constants.NGHTTP2_CANCEL)
          release()
          reject(new TypeError("fetch failed: redirect mode is set to error"))
          return
        }
        const empty = method === "HEAD" || status === 204 || status === 304
        resolve(new Response(empty ? null : output, { status, headers: out }))
      })
      stream.on("data", (chunk: Buffer) => {
        held.lastActive = Date.now()
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 1) <= 0) stream.pause()
      })
      // Decide on close, not end: Bun ends open streams of a destroyed
      // session as if they completed (1.3.14 for a session we destroy, both
      // versions when the connection is torn down). A graceful GOAWAY leaves
      // the session closed but not destroyed and its streams complete.
      stream.on("end", () => {
        ended = true
      })
      stream.on("error", fail)
      stream.on("close", () => {
        signal?.removeEventListener("abort", onAbort)
        held.open.delete(fail)
        release()
        if (!settled) {
          settled = true
          reject(lost(`stream closed (code ${stream.rstCode})`, false))
          return
        }
        const clean =
          ended &&
          !held.dead &&
          !held.session.destroyed &&
          (!stream.rstCode || stream.rstCode === http2.constants.NGHTTP2_NO_ERROR)
        try {
          if (clean) controller.close()
          else controller.error(lost(ended ? "the reply ended with the connection" : `stream reset (code ${stream.rstCode})`, true))
        } catch {
          // already closed or errored
        }
      })
      if (body != null) stream.end(body)
    })
  }

  function target(input: string | URL | Request) {
    if (input instanceof Request) return
    try {
      const url = new URL(String(input))
      return url.protocol === "https:" || url.protocol === "http:" ? url : undefined
    } catch {
      return
    }
  }

  function carriable(init?: BunFetchRequestInit) {
    const body = init?.body
    return body == null || typeof body === "string" || body instanceof Uint8Array
  }

  function skip(origin: string) {
    const until = unsuitable.get(origin)
    if (until === undefined) return false
    if (Date.now() < until) return true
    unsuitable.delete(origin)
    return false
  }

  /** Fetch-compatible: managed gateway calls ride the reused HTTP/2 session
   * when possible, and otherwise the fresh connection exactly as before. */
  export async function fetch(input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> {
    activity()
    const url = target(input)
    if (!enabled() || !url || !carriable(init) || skip(url.origin)) return fetchWithFreshConnection(input, init)
    const request = init ?? {}
    const acquired = await acquire(url.origin).catch((error) => {
      if (!(error instanceof Unsuitable)) throw error
      unsuitable.set(url.origin, Date.now() + options.unsuitableMs)
      stats.fallbacks++
      log.info("gateway connection reuse unavailable; using a fresh connection", { origin: url.origin, reason: error.message })
      return undefined
    })
    if (!acquired) return fetchWithFreshConnection(input, init)
    if (acquired.reused) stats.reused++
    try {
      return await once(url, request, acquired.held, acquired.reused)
    } catch (error) {
      const method = (request.method ?? "GET").toUpperCase()
      const resendable = new Headers(request.headers as HeadersInit | undefined).has("idempotency-key") || method === "GET"
      if (!(error instanceof DeadConnection) || error.afterHeaders || !resendable || request.signal?.aborted) throw error
      stats.retries++
      log.warn("gateway connection lost before the reply; sending once more on a new connection", {
        origin: url.origin,
        reason: error.message,
      })
      const next = await acquire(url.origin).catch(() => undefined)
      if (!next) return fetchWithFreshConnection(input, init)
      return once(url, request, next.held, false)
    }
  }

  /** Open (or keep) the gateway session ahead of a model call. The first
   * request goes out at once: Fly's edge drops a connection that carries no
   * request within ~5 s. Never throws. */
  export function warm(base: string) {
    activity()
    warmNow(base)
  }

  // Keep-warm's own warming is not user activity: it must not extend the window.
  function warmNow(base: string) {
    const url = target(base)
    if (!enabled() || !url || skip(url.origin)) return
    void (async () => {
      const acquired = await acquire(url.origin)
      if (acquired.reused) return
      const response = await once(new URL(options.warmPath, url.origin), { method: "GET" }, acquired.held, false)
      await response.body?.cancel().catch(() => undefined)
    })().catch((error) => {
      if (error instanceof Unsuitable) {
        unsuitable.set(url.origin, Date.now() + options.unsuitableMs)
        stats.fallbacks++
      }
    })
  }

  // Keep-warm: open the gateway connection when the app starts and keep it
  // usable until the first message, which may come minutes later.
  let keeper:
    | { resolve: () => string | undefined; timer: ReturnType<typeof setInterval>; until: number }
    | undefined

  /** Extend the keep-warm window (a UI connected, a session opened, a call). */
  export function activity() {
    if (keeper) keeper.until = Date.now() + options.keepWarmIdleStopMs
  }

  /** Keep a gateway connection warm while the app is in use. `resolve` returns
   * the managed gateway base URL, or undefined while it is not known (before
   * credential sync, or for a session without Ace). Each check opens the
   * connection when there is none, and sends one small request when the open
   * connection has carried none for `keepaliveMs`; checks stop
   * `keepWarmIdleStopMs` after the last activity and resume with the next
   * one. A no-op while the switch is off. */
  export function keepWarm(resolve: () => string | undefined) {
    stopKeepWarm()
    const tick = () => {
      if (!keeper || !enabled()) return
      if (Date.now() > keeper.until) return
      const base = keeper.resolve()
      const url = base ? target(base) : undefined
      if (!url || skip(url.origin)) return
      void (async () => {
        const existing = sessions.get(url.origin)
        const held = existing ? await existing.catch(() => undefined) : undefined
        const live = held && !held.dead && !held.draining && Date.now() - held.lastActive < options.idleCloseMs
        if (!live) return warmNow(base!)
        if (held.streams > 0 || Date.now() - held.lastRequest < options.keepaliveMs) return
        const response = await once(new URL(options.warmPath, url.origin), { method: "GET" }, held, true)
        await response.body?.cancel().catch(() => undefined)
      })().catch(() => undefined)
    }
    const timer = setInterval(tick, options.keepWarmCheckMs)
    timer.unref?.()
    keeper = { resolve, timer, until: Date.now() + options.keepWarmIdleStopMs }
    tick()
  }

  export function stopKeepWarm() {
    if (keeper) clearInterval(keeper.timer)
    keeper = undefined
  }
}
