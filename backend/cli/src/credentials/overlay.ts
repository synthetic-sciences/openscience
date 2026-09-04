/**
 * Process-local record of which `process.env` values came from the
 * synchronized workspace credential overlay.
 *
 * applyCredentialEnv is the only writer: it records a key when it injects an
 * account-sourced service value (GITHUB_TOKEN, HF_TOKEN, ...) and forgets it
 * when that value is removed or replaced by a device-owned one. The subprocess
 * env builder asks whether the env it produced still carries any of those
 * exact values, so a child's overlay stamp in the credential process ledger
 * reflects what the child actually inherited rather than whether the cached
 * grant happened to be readable at spawn time. In particular, a grant that
 * lapsed before the expiry revision removed its values from `process.env`
 * still stamps every child spawned in that window.
 */
export namespace CredentialOverlay {
  const injected = new Map<string, { organization: string; value: string }>()

  /** `key` in `process.env` now carries `value` from `organization`'s overlay. */
  export function inject(key: string, value: string, organization: string): void {
    injected.set(key, { organization, value })
  }

  /** `key` no longer carries an overlay value. */
  export function release(key: string): void {
    injected.delete(key)
  }

  /** The workspace whose synced service values `env` carries verbatim, if any. */
  export function inherited(env: Record<string, string | undefined>): string | undefined {
    for (const [key, entry] of injected) {
      if (env[key] === entry.value) return entry.organization
    }
    return undefined
  }

  /** Env keys currently carrying overlay values, for diagnostics. */
  export function keys(): string[] {
    return [...injected.keys()]
  }
}
