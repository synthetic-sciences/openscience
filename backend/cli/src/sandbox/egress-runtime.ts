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

  async function start(): Promise<Running> {
    const socket = path.join(Global.Path.state, `egress-${process.pid}.sock`)
    // A stale socket file from a killed previous process (same pid, unlikely
    // but possible after a pid wraparound) would make Bun.listen refuse to
    // bind with EADDRINUSE.
    await fs.rm(socket, { force: true })
    const rules = await currentRules()
    const server = Egress.serveProxy({
      socket,
      rules,
      onEvent: (line) => log.info(line),
    })
    const onGlobalChange = (event: { directory?: string; payload: unknown }) => {
      if (!isGlobalConfigChange(event)) return
      refresh(rules).catch(() => {})
    }
    GlobalBus.on("event", onGlobalChange)
    log.info("egress proxy listening", { socket })
    return { socket, port: Sandbox.SHIM_PORT, server, rules, onGlobalChange }
  }

  /** Start the proxy if it is not already running, and return where to
   *  reach it. Idempotent — a second call returns the same address without
   *  restarting anything. Also refreshes the live rules from the current
   *  config, so a caller composing a new sandboxed argv always gets the
   *  latest allowlist even between reactive updates. */
  export async function ensure(): Promise<{ socket: string; port: number }> {
    state.running ??= start()
    const running = await state.running
    await refresh(running.rules)
    return { socket: running.socket, port: running.port }
  }

  /** Stop the proxy and unlink its socket. The CLI process otherwise leaves
   *  this running for its own lifetime; tests use this to reset between
   *  cases. */
  export async function stop() {
    const pending = state.running
    state.running = undefined
    if (!pending) return
    const running = await pending
    GlobalBus.off("event", running.onGlobalChange)
    running.server.stop(true)
    await fs.rm(running.socket, { force: true })
  }
}
