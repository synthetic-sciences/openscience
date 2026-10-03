/**
 * Whether a terminal runs as the person's own shell or stays sandboxed.
 *
 * Agent commands never come through here; this only decides the terminal
 * tab. The server decides for every create and connect, from facts the
 * caller cannot assert: the key cookie, the deployment, and the setting.
 */
export namespace TerminalMode {
  export type Mode = "host" | "sandboxed"
  export type Reason = "policy" | "not_local" | "no_key"

  export function decide(input: {
    /** `terminal.mode` in config; absent means host. */
    setting?: Mode
    /** The request carried a valid terminal key. */
    key: boolean
    /** No deployment token is configured: the server is not proxied to others. */
    local: boolean
  }): { mode: Mode; reason?: Reason } {
    if (input.setting === "sandboxed") return { mode: "sandboxed", reason: "policy" }
    if (!input.local) return { mode: "sandboxed", reason: "not_local" }
    if (!input.key) return { mode: "sandboxed", reason: "no_key" }
    return { mode: "host" }
  }

  /** The server always binds loopback; a deployment token means it is
   *  reverse-proxied or shared, where a host shell would belong to others. */
  export function local(env: NodeJS.ProcessEnv = process.env) {
    return !env.OPENSCIENCE_AUTH_TOKEN
  }
}
