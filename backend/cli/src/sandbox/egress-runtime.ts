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
  type Running = {
    socket: string
    port: number
    server: ReturnType<typeof Egress.serveProxy>
    /**
     * Seatbelt-only: the host-side TCP-loopback→unix-socket bridge that
     * gives a seatbelt-sandboxed process (no network namespace, so nothing
     * severs it from an ordinary loopback connect) a port to dial directly.
     * `undefined` on bubblewrap, where the bind-mounted socket itself is
     * already the sandboxed process's only route in.
     */
    bridge?: ReturnType<typeof Egress.serveShim>
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

  /**
   * `platform` decides only whether a seatbelt bridge joins the unix-socket
   * proxy below — defaulting to the real platform, like every other
   * platform-injectable seam this branch added (`Sandbox.backend`,
   * `plan`/`wrapArgv`), so this is exercisable, deterministically, from a
   * machine that has no seatbelt at all.
   */
  async function start(platform: NodeJS.Platform = process.platform): Promise<Running> {
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
    // Seatbelt has no network namespace to bind-mount the socket into, so a
    // seatbelt-sandboxed process cannot reach it the way bubblewrap's
    // in-namespace shim does. What it CAN reach — seatbelt's own profile is
    // what narrows this down to exactly one port, see sandbox.ts's
    // seatbeltProfile — is an ordinary host loopback TCP port. That bridge,
    // TCP loopback → this same unix socket, is exactly what `Egress.serveShim`
    // already implements for bubblewrap's in-namespace shim; nothing about it
    // is namespace-specific, so running it here, in the CLI's own process
    // instead of inside a sandbox, gives seatbelt the same host-side proxy
    // Linux has, reached one hop further in. `port: 0` asks the OS for an
    // ephemeral port — unlike SHIM_PORT, nothing needs this value known in
    // advance: no shim script embeds it as a literal (seatbelt's profile is
    // built from `policy.port` at wrap time, not composed into a string that
    // has to agree with a value chosen earlier), and a fixed port here, with
    // no namespace to keep it private, would collide across every
    // concurrently sandboxed process on the machine.
    const bridge = Sandbox.backend(platform) === "seatbelt" ? Egress.serveShim({ port: 0, socket }) : undefined
    const port = bridge ? bridge.port : Sandbox.SHIM_PORT
    const onGlobalChange = (event: { directory?: string; payload: unknown }) => {
      if (!isGlobalConfigChange(event)) return
      refresh(rules).catch(() => {})
    }
    GlobalBus.on("event", onGlobalChange)
    log.info("egress proxy listening", { socket, port, bridged: bridge !== undefined })
    return { socket, port, server, bridge, rules, onGlobalChange }
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
   *  `platform` decides only whether `start()` joins a seatbelt bridge — see
   *  its doc comment — and is only ever non-default from a test; every real
   *  caller (`egressFor` below) leaves it at the real one. The proxy itself
   *  is not re-created per platform: `state.running` is one proxy for the
   *  process lifetime, same as before this parameter existed, so a caller
   *  that wants the seatbelt branch exercised must `stop()` first if a
   *  differently-platformed proxy is already cached. */
  export async function ensure(
    platform: NodeJS.Platform = process.platform,
  ): Promise<{ socket: string; port: number }> {
    const pending = (state.running ??= start(platform))
    const running = await pending.catch((error) => {
      if (state.running === pending) state.running = undefined
      throw error
    })
    await refresh(running.rules)
    return { socket: running.socket, port: running.port }
  }

  /** Stop the proxy and unlink its socket. The CLI process otherwise leaves
   *  this running for its own lifetime; tests use this to reset between
   *  cases. A no-op when nothing is running, and — because a caller reaching
   *  for the escape hatch after a failed start must not be handed that same
   *  failure again — when the last start rejected. */
  export async function stop() {
    const pending = state.running
    state.running = undefined
    if (!pending) return
    const running = await pending.catch(() => undefined)
    if (!running) return
    GlobalBus.off("event", running.onGlobalChange)
    running.server.stop(true)
    await fs.rm(running.socket, { force: true })
  }

  /** The value to pass as `Sandbox.Options.egress`, or `undefined` when the
   *  proxy would not actually be used: the sandbox is off, network isn't
   *  "allowlist", or the platform's backend is neither bubblewrap nor
   *  seatbelt. The shape differs by backend, matching `Options.egress`'s own
   *  doc comment: bubblewrap gets the bind-mountable unix socket path, since
   *  the bind-mounted socket itself is the sandboxed process's only route in;
   *  seatbelt gets `ensure()`'s bridged loopback port, stringified, since a
   *  seatbelt-sandboxed process dials that port directly (see
   *  `sandbox.ts`'s `seatbeltProfile`) and never touches the socket at all.
   *  A disabled/deny/allow policy skips starting the proxy entirely — pure
   *  waste when nothing would ever connect to it. Every `wrapArgv` /
   *  `plan()` caller should route through this rather than calling `ensure()`
   *  directly, so a terminal or kernel with network "deny" never pays for a
   *  proxy it has no way to reach.
   *
   *  `platform` defaults to the real one — the same injectable seam
   *  `Sandbox.backend`/`plan`/`wrapArgv` use — so the seatbelt branch is
   *  exercisable, deterministically, from a machine that has none. */
  export async function egressFor(
    policy: Sandbox.Options,
    platform: NodeJS.Platform = process.platform,
  ): Promise<string | undefined> {
    const { enabled, network } = Sandbox.resolved(policy)
    if (!enabled) return undefined
    if (network !== "allowlist") return undefined
    const b = Sandbox.backend(platform)
    if (b === "bubblewrap") return (await ensure(platform)).socket
    if (b === "seatbelt") return String((await ensure(platform)).port)
    return undefined
  }
}
