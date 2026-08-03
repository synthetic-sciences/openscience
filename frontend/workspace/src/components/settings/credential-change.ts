const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Run a credential write and the catalog re-read that has to follow it, and
 * say which of the two failed — because they are not the same failure.
 *
 * Once the write resolves the credential is persisted server-side; a refresh
 * that fails after that leaves the panel stale, nothing more. Letting its
 * rejection reach the caller's `catch` — where it landed once refreshProviders
 * started propagating errors instead of logging them — rendered a completed
 * sign-in as "sign-in failed" and skipped the success side effects
 * (`onConnected` never fired) for a credential that IS stored. Swallowing it
 * again is not the fix either; that was the bug the propagation change
 * removed. So it comes back as a notice the caller renders wherever it renders
 * errors, worded outcome-first, while `ok` stays true.
 */
export async function credentialChange(input: {
  write: () => Promise<unknown>
  refresh: () => Promise<unknown>
  done: string
}): Promise<{ ok: boolean; notice?: string }> {
  const failed = await input.write().then(
    () => undefined,
    (error) => reason(error),
  )
  if (failed !== undefined) return { ok: false, notice: failed }

  return input.refresh().then(
    () => ({ ok: true }),
    (error) => ({
      ok: true,
      notice: `${input.done}, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
    }),
  )
}
