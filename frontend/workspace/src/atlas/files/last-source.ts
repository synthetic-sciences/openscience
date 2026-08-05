const SOURCE_KEY = "openscience:files-source"

interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// Resolved inside each try rather than as a default argument: reading
// globalThis.localStorage is itself what throws in a sandboxed frame, and these
// run during the pane's render.
const storageOrNothing = (given?: Storage) => given ?? (globalThis as { localStorage?: Storage }).localStorage

/**
 * The source the picker was last left on. Ids are not a fixed set — a connected
 * folder's id is its grant id — so this only guarantees a non-empty string; the
 * pane resolves it against the sources that actually exist and falls back when
 * it no longer matches one.
 */
export function readSource(given?: Storage): string | undefined {
  try {
    const value = storageOrNothing(given)?.getItem(SOURCE_KEY)
    return value ? value : undefined
  } catch {
    return undefined
  }
}

export function writeSource(id: string | undefined, given?: Storage): void {
  try {
    const storage = storageOrNothing(given)
    if (!id) return storage?.removeItem(SOURCE_KEY)
    storage?.setItem(SOURCE_KEY, id)
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
}
