import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { GlobalBus } from "@/bus/global"
import { Event } from "@/server/event"
import { Log } from "@/util/log"
import { Egress } from "./egress"
import { Sandbox } from "./sandbox"

const log = Log.create({ service: "egress-runtime" })

/**
 * Lifecycle for the host-side allowlist proxy — the listening end of
 * `Egress.serveProxy` (see `egress.ts` for the proxy itself and
 * `docs/adr/0002-sandbox-network-policy.md` for why it exists).
 *
 * One proxy per process, held lazily with a disposer, the same shape
 * `science/kernel/registry.ts` uses for its kernel table: nothing runs until
 * the first `ensure()`, and `stop()` tears down the server and unlinks the
 * socket. Unlike that table, this is not `Instance.state` — the proxy must
 * outlive any single project instance, since a global config write disposes
 * every open instance (`Config`'s `patchConfigPath`) and the proxy must not
 * go down with them, or every kernel bound to its socket would lose its only
 * route out.
 *
 * `rules` is a live array, not a snapshot. `Egress.serveProxy` reads it by
 * reference on every connection, so refreshing its *contents* in place —
 * on every `ensure()`, and reactively whenever global config changes — is
 * what lets an allowlist edit reach a kernel that is already running,
 * without restarting the proxy or the kernel. Building a fresh array once
 * at construction and handing it to `serveProxy` would silently defeat
 * that: the proxy would keep the rules it was born with until the process
 * itself restarted. This is also why `allowHosts` stays out of
 * `ExecutionAuthority.generation` — that hash exists to decide when a
 * kernel must be torn down and rebooted, and an allowlist edit is
 * deliberately not that kind of change.
 */
export namespace EgressRuntime {
  /**
   * Bubblewrap (Linux) carries `socket` — the bind-mounted socket itself is
   * the sandboxed process's only route in. Seatbelt (macOS) has no network
   * namespace to bind a socket into, so `Egress.serveProxy` listens directly
   * on a loopback TCP port instead (see its own doc comment and
   * `sandbox.ts`'s `seatbeltProfile`), carried as `hostname`/`secret` —
   * `secret` is the per-start `Proxy-Authorization` credential that port
   * requires, since a loopback TCP port, unlike a unix socket, carries no
   * filesystem permissions of its own. Optional fields rather than a
   * discriminated union: every real caller narrows by checking `socket`
   * (see `stop()`, `ensure()`, `egressFor()` below), and a union would force
   * that same narrowing onto every *test* that reaches these fields too,
   * including the bubblewrap-only ones this task must leave unchanged.
   */
  type Running = {
    socket?: string
    hostname?: string
    port: number
    secret?: string
    // Not `ReturnType<typeof Egress.serveProxy>`: TS resolves that utility
    // against an overloaded function's LAST signature only (the TCP one
    // here), not a union of all of them — this field needs both, since
    // `startBubblewrap`'s `server` really is a `UnixSocketListener`.
    server: Bun.UnixSocketListener<undefined> | Bun.TCPSocketListener<undefined>
    rules: Egress.Rule[]
    onGlobalChange: (event: { directory?: string; payload: unknown }) => void
  }

  const state: { running?: Promise<Running> } = {}

  async function currentRules(): Promise<Egress.Rule[]> {
    const policy = await Config.trustedSandbox()
    return [...Egress.DEFAULT_RULES, ...(policy.allowHosts ?? [])]
  }

  /** Re-populate `rules` in place (same array reference) rather than
   *  replacing it, so `Egress.serveProxy`'s closure over that reference
   *  observes the update on its very next connection. A failed re-read
   *  (config file briefly unreadable mid-write, for example) keeps
   *  whatever rules were already live rather than clearing the allowlist. */
  async function refresh(rules: Egress.Rule[]) {
    const next = await currentRules().catch((error) => {
      log.warn("failed to refresh the sandbox allowlist, keeping the previous rules", { error })
      return undefined
    })
    if (!next) return
    rules.length = 0
    rules.push(...next)
  }

  function isGlobalConfigChange(event: { directory?: string; payload: unknown }): boolean {
    if (event.directory !== "global") return false
    const payload = event.payload
    if (typeof payload !== "object" || payload === null || !("type" in payload)) return false
    return payload.type === Event.Disposed.type
  }

  function listener(rules: Egress.Rule[]) {
    const onGlobalChange = (event: { directory?: string; payload: unknown }) => {
      if (!isGlobalConfigChange(event)) return
      refresh(rules).catch(() => {})
    }
    GlobalBus.on("event", onGlobalChange)
    return onGlobalChange
  }

  /** Bubblewrap (Linux): a bind-mountable unix socket under the state dir —
   *  unchanged from before Task 7 (macOS seatbelt support) added the
   *  loopback-TCP branch below. */
  async function startBubblewrap(): Promise<Running> {
    const socket = path.join(Global.Path.state, `egress-${process.pid}.sock`)
    // A stale socket file from a killed previous process (same pid, unlikely
    // but possible after a pid wraparound) would make Bun.listen refuse to
    // bind with EADDRINUSE.
    await fs.rm(socket, { force: true })
    const rules = await currentRules()
    // Bun.listen throws synchronously, with a message ("Failed to listen at
    // <path>") that says nothing about what depends on it. Every sandboxed
    // spawn does, so name that here rather than letting a bare bind error
    // surface out of an unrelated-looking `bash`/kernel/job call.
    const server = (() => {
      try {
        return Egress.serveProxy({ socket, rules, onEvent: (line) => log.info(line) })
      } catch (e) {
        throw new Error(
          `Could not start the sandbox allowlist proxy on ${socket}: ${e instanceof Error ? e.message : String(e)}. ` +
            `Sandboxed commands need it to reach the network — retry once the path is writable, or set sandbox.network to "deny" or "allow".`,
        )
      }
    })()
    const onGlobalChange = listener(rules)
    log.info("egress proxy listening", { socket })
    return { socket, port: Sandbox.SHIM_PORT, server, rules, onGlobalChange }
  }

  /**
   * Seatbelt (macOS): no network namespace to bind a unix socket into, so
   * `Egress.serveProxy` listens directly on a loopback TCP port instead —
   * decision 1 of the Task 7 brief, deliberately *not* a host-side bridge
   * from TCP to a unix socket (that would just be a second component doing
   * what one listener already can). `port: 0` asks the OS for an ephemeral
   * port: unlike bubblewrap's `SHIM_PORT`, nothing needs this value fixed in
   * advance — no shim script embeds it as a literal, since seatbelt has no
   * shim at all (see `sandbox.ts`'s `shimPlan` doc comment) — and a fixed
   * port here, with no namespace to keep it private, would collide across
   * every concurrently sandboxed process on the machine.
   *
   * `secret` is generated fresh per proxy start (decision 2): a loopback TCP
   * port, unlike a unix socket, carries no filesystem permissions of its
   * own, so every request to it must additionally prove it holds this —
   * enforced inside `Egress.serveProxy` itself, not here.
   */
  async function startSeatbelt(): Promise<Running> {
    const rules = await currentRules()
    const secret = crypto.randomUUID()
    const server = (() => {
      try {
        return Egress.serveProxy({ hostname: "127.0.0.1", port: 0, secret, rules, onEvent: (line) => log.info(line) })
      } catch (e) {
        throw new Error(
          `Could not start the sandbox allowlist proxy on 127.0.0.1: ${e instanceof Error ? e.message : String(e)}. ` +
            `Sandboxed commands need it to reach the network — retry, or set sandbox.network to "deny" or "allow".`,
        )
      }
    })()
    const onGlobalChange = listener(rules)
    log.info("egress proxy listening", { hostname: "127.0.0.1", port: server.port })
    return { hostname: "127.0.0.1", port: server.port, secret, server, rules, onGlobalChange }
  }

  /**
   * `platform` decides which of the two listeners above starts — defaulting
   * to the real platform, like every other platform-injectable seam this
   * branch added (`Sandbox.backend`, `plan`/`wrapArgv`), so the seatbelt
   * branch is exercisable, deterministically, from a machine that has none.
   */
  function start(platform: NodeJS.Platform = process.platform): Promise<Running> {
    return platform === "darwin" ? startSeatbelt() : startBubblewrap()
  }

  /** Start the proxy if it is not already running, and return where to
   *  reach it. Idempotent — a second call returns the same address without
   *  restarting anything. Also refreshes the live rules from the current
   *  config, so a caller composing a new sandboxed argv always gets the
   *  latest allowlist even between reactive updates.
   *
   *  A failure is loud but never permanent. Caching the promise is what makes
   *  the success path idempotent, and it would just as happily cache a
   *  rejection: one transient failure — a state directory briefly unwritable,
   *  a socket path momentarily taken — would then be replayed to every later
   *  caller for the life of the process, and since every bash command,
   *  terminal, kernel and compute job routes through here under the
   *  "allowlist" default, that is the whole product failing until restart.
   *  So a rejected start un-caches itself and the next call genuinely
   *  retries. It still throws rather than degrading to no-proxy: `wrapArgv`
   *  would reject an "allowlist" policy with no egress socket anyway, and a
   *  silent downgrade is exactly the failure this feature keeps producing —
   *  a sandbox that looks like it has bounded egress and in fact has none.
   *
   *  `platform` decides only which listener `start()` picks — see its doc
   *  comment — and is only ever non-default from a test; every real caller
   *  (`egressFor` below) leaves it at the real one. The proxy itself is not
   *  re-created per platform: `state.running` is one proxy for the process
   *  lifetime, same as before this parameter existed, so a caller that wants
   *  a differently-platformed proxy exercised must `stop()` first. */
  export async function ensure(
    platform: NodeJS.Platform = process.platform,
  ): Promise<{ socket?: string; hostname?: string; port: number; secret?: string }> {
    const pending = (state.running ??= start(platform))
    const running = await pending.catch((error) => {
      if (state.running === pending) state.running = undefined
      throw error
    })
    await refresh(running.rules)
    return { socket: running.socket, hostname: running.hostname, port: running.port, secret: running.secret }
  }

  /** Stop the proxy. The CLI process otherwise leaves this running for its
   *  own lifetime; tests use this to reset between cases. A no-op when
   *  nothing is running, and — because a caller reaching for the escape
   *  hatch after a failed start must not be handed that same failure again —
   *  when the last start rejected. Unlinks the unix socket on bubblewrap;
   *  seatbelt's loopback listener leaves nothing on disk to clean up. */
  export async function stop() {
    const pending = state.running
    state.running = undefined
    if (!pending) return
    const running = await pending.catch(() => undefined)
    if (!running) return
    GlobalBus.off("event", running.onGlobalChange)
    running.server.stop(true)
    if (running.socket) await fs.rm(running.socket, { force: true })
  }

  /** The value to pass as `Sandbox.Options.egress`, or `undefined` when the
   *  proxy would not actually be used: the sandbox is off, network isn't
   *  "allowlist", or the platform's backend is neither bubblewrap nor
   *  seatbelt. The shape differs by backend, matching `Options.egress`'s own
   *  doc comment: bubblewrap gets the bind-mountable unix socket path, since
   *  the bind-mounted socket itself is the sandboxed process's only route in;
   *  seatbelt gets `"<port>:<secret>"` — `buildPolicy` in sandbox.ts is what
   *  splits that back apart into `Policy.port`/`Policy.secret`, the same
   *  division of labour it already has for bubblewrap's `Policy.egress`. A
   *  disabled/deny/allow policy skips starting the proxy entirely — pure
   *  waste when nothing would ever connect to it. Every `wrapArgv` /
   *  `plan()` caller should route through this rather than calling `ensure()`
   *  directly, so a terminal or kernel with network "deny" never pays for a
   *  proxy it has no way to reach.
   *
   *  `platform` defaults to the real one — the same injectable seam
   *  `Sandbox.backend`/`plan`/`wrapArgv` use — so the seatbelt branch is
   *  exercisable, deterministically, from a machine that has none.
   *
   *  `ensure()` caches ONE proxy for the process lifetime (see its doc
   *  comment); `platform` only decides which listener `start()` picks when
   *  nothing is running yet. Asking for `"darwin"` after a differently-
   *  platformed proxy is already cached (a real caller never does this —
   *  `process.platform` is constant for the life of a process — but a test
   *  injecting platform explicitly can) silently reuses that cached
   *  listener instead of starting a seatbelt one. Interpolating a
   *  bubblewrap `Running`'s missing `secret` into the template literal
   *  below would then produce the *string* `"undefined"` — truthy, and
   *  therefore indistinguishable from a real secret to any check that only
   *  asks whether the value is present. Guarded explicitly rather than
   *  trusting the interpolation to fail loudly on its own, because it
   *  doesn't: confirmed by execution (Task 7 fix round 1 review) that it
   *  silently composes `"<port>:undefined"` instead. */
  export async function egressFor(
    policy: Sandbox.Options,
    platform: NodeJS.Platform = process.platform,
  ): Promise<string | undefined> {
    const { enabled, network } = Sandbox.resolved(policy)
    if (!enabled) return undefined
    if (network !== "allowlist") return undefined
    const b = Sandbox.backend(platform)
    if (b === "bubblewrap") return (await ensure(platform)).socket
    if (b === "seatbelt") {
      const running = await ensure(platform)
      if (!running.secret) {
        throw new Error(
          "sandbox egress proxy is already running as the bubblewrap (unix-socket) listener, not seatbelt's — " +
            "call EgressRuntime.stop() first if a seatbelt proxy is genuinely needed here",
        )
      }
      return `${running.port}:${running.secret}`
    }
    return undefined
  }
}
