const RELOAD_ATTEMPT_KEY = "openscience.stale-build.reload-at"

type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">
type StorageLike = Pick<Storage, "getItem" | "setItem">

interface StaleBuildRecoveryOptions {
  target?: EventTargetLike
  storage?: StorageLike | null
  reload?: () => void
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

  const recover = (event: Event) => {
    if (!storage) return

    try {
      if (storage.getItem(RELOAD_ATTEMPT_KEY) !== null) return
      storage.setItem(RELOAD_ATTEMPT_KEY, "1")
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
