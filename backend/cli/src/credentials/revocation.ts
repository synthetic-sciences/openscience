/**
 * Classifies credential revision reasons into the runtimes they may reach.
 *
 * Every published revision used to trigger one response: kill every
 * credential-bearing child, stop every command, and dispose every project
 * instance, which also aborted the model request of every active turn. That
 * was wrong for the expiry of the synchronized workspace overlay. The synced
 * provider and service keys are a short-lived, revocable overlay that is
 * separate from Ace's managed-model access and from the keys this device owns,
 * so letting them lapse invalidates only the children that inherited the
 * overlay. A turn running on managed or local credentials never used the
 * expired grant; disposing its runtime surfaced as "Bash failed" with empty
 * arguments for a tool call that had not even started.
 *
 * The security model is unchanged: an expired grant is cleared before the
 * revision is published, so no new request can use it, and every child stamped
 * with the overlay is still killed. Only the blast radius is narrowed.
 */
export namespace CredentialRevocation {
  export const EXPIRED = "Interrupted: synchronized workspace credentials expired before they could be renewed"
  export type Target = "none" | "mcp" | "overlay" | "all"

  const mcp = ["mcp-auth.set:", "mcp-auth.remove:", "mcp-auth.tokens:", "mcp-auth.tokens.refresh:", "mcp-auth.client:"]

  export function target(reason: string): Target {
    if (reason === "mcp-auth.migrate") return "none"
    if (reason === "workspace-sync.expired") return "overlay"
    if (reason.startsWith("mcp-config.") || mcp.some((prefix) => reason.startsWith(prefix))) return "mcp"
    return "all"
  }

  /** Ledger scope for the per-kind revoke handlers: an overlay expiry reaches
   * only children stamped with the overlay; every other reason keeps the kind. */
  export function scope(reason: string): { overlay?: true } {
    return target(reason) === "overlay" ? { overlay: true } : {}
  }

  export function message(reason: string): string {
    if (reason === "workspace-sync.expired") return EXPIRED
    if (target(reason) === "mcp") {
      return `Interrupted: MCP credentials changed (${reason}) and the MCP transports that inherited the previous snapshot were stopped`
    }
    return `Interrupted: credentials changed (${reason}) and every runtime that inherited the previous snapshot was stopped`
  }

  /** Abort reason carried by a session controller whose turn a credential
   * revision cancelled, so the recorded error names the cause. */
  export class Interruption extends Error {
    readonly reason: string
    constructor(reason: string) {
      super(message(reason))
      this.name = "CredentialInterruption"
      this.reason = reason
    }
  }

  export function interruption(value: unknown): Interruption | undefined {
    return value instanceof Interruption ? value : undefined
  }

  /** The interruption that cancelled `error`: `signal` was aborted by a
   * credential revision and `error` is that abort, either the reason itself
   * (thrown by throwIfAborted) or the AbortError a cancelled request surfaces.
   * An unrelated failure that happened to be thrown after the abort is not
   * attributed to the revision. */
  export function cancelled(error: unknown, signal: AbortSignal): Interruption | undefined {
    const cause = interruption(signal.reason)
    if (!cause) return undefined
    if (error === cause) return cause
    return error instanceof Error && error.name === "AbortError" ? cause : undefined
  }
}
