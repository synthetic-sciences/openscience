/**
 * Process-local marker for the synchronized workspace credential overlay.
 *
 * Children spawned from this process inherit whatever overlay values were live
 * at spawn time: service env such as GITHUB_TOKEN or HF_TOKEN through
 * applyCredentialEnv, and portable provider keys through
 * OpenScience.subprocessEnv. The durable credential-process ledger stamps every
 * registration with the overlay that was live, so an overlay-only revocation
 * (its grant expired while offline) can reach exactly those children and leave
 * every runtime that never held the grant alone.
 */
export namespace CredentialOverlay {
  const state: { organization?: string } = {}

  export function mark(organization: string): void {
    state.organization = organization
  }

  export function clear(): void {
    state.organization = undefined
  }

  /** The workspace whose synced overlay is currently live in this process. */
  export function current(): string | undefined {
    return state.organization
  }
}
