const RELOAD_ATTEMPT_KEY = "openscience.stale-build.reload-at"
const DEFAULT_COOLDOWN_MS = 30_000

type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">
type StorageLike = Pick<Storage, "getItem" | "setItem">

interface StaleBuildRecoveryOptions {
  target?: EventTargetLike
  storage?: StorageLike | null
  reload?: () => void
  now?: () => number
  cooldownMs?: number
}

function readLastAttempt(storage: StorageLike): number | undefined {
  const value = storage.getItem(RELOAD_ATTEMPT_KEY)
  if (value === null) return
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function defaultStorage(): StorageLike | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function installStaleBuildRecovery(options: StaleBuildRecoveryOptions = {}): () => void {
  const target = options.target ?? window
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const reload = options.reload ?? (() => window.location.reload())
  const now = options.now ?? Date.now
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS

  const recover = (event: Event) => {
    if (!storage) return

    const attemptedAt = now()
    let lastAttempt: number | undefined
    try {
      lastAttempt = readLastAttempt(storage)
    } catch {
      return
    }
    if (lastAttempt !== undefined && attemptedAt - lastAttempt < cooldownMs) return

    try {
      storage.setItem(RELOAD_ATTEMPT_KEY, String(attemptedAt))
    } catch {
      return
    }

    event.preventDefault()
    reload()
  }

  // Vite emits this when an open tab requests a lazy chunk removed by a newer deployment.
  target.addEventListener("vite:preloadError", recover)
  return () => target.removeEventListener("vite:preloadError", recover)
}
