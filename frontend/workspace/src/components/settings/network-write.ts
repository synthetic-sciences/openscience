export type NetworkSettingsState = {
  allowlistEnabled: boolean
  enabled: string[]
  custom: string[]
}

type NetworkWriteHooks = {
  isSaving: () => boolean
  state: () => NetworkSettingsState
  setState: (state: NetworkSettingsState) => void
  setSaving: (saving: boolean) => void
  setError: (error: string | undefined) => void
  write: (state: NetworkSettingsState) => Promise<NetworkSettingsState>
}

export async function commitNetworkState(
  next: NetworkSettingsState,
  hooks: NetworkWriteHooks,
): Promise<{ ok: true } | { ok: false; busy: true } | { ok: false; error: string }> {
  // The endpoint replaces the whole state. Reject a second write while the
  // first is in flight so an older response can never overwrite a newer edit.
  if (hooks.isSaving()) return { ok: false, busy: true }

  const previous = hooks.state()
  hooks.setSaving(true)
  hooks.setError(undefined)
  hooks.setState(next)
  try {
    hooks.setState(await hooks.write(next))
    return { ok: true }
  } catch (error) {
    hooks.setState(previous)
    const value = error instanceof Error ? error.message : String(error)
    hooks.setError(value)
    return { ok: false, error: value }
  } finally {
    hooks.setSaving(false)
  }
}
