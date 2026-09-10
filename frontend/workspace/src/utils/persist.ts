import { usePlatform, type Platform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@synsci/util/encode"
import { createResource, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [Store<T>, SetStoreFunction<T>, InitType, Accessor<boolean>]

type PersistTarget = {
  storage?: string
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "openscience.global.dat"
// Storage access that fails for any reason other than one value being too
// large (private browsing, a blocked origin) makes every key hopeless, so the
// cache becomes the only store. A single value the quota cannot hold is not
// that, and must never cost the other keys their persistence.
const fallback = { disabled: false }
// Key -> the serialized length that would not fit. Retried once the value
// shrinks enough, or once a removal hands the space back.
const refused = new Map<string, number>()
// Keys already announced. Kept apart from `refused` so that freeing space,
// which is a reason to retry every refused key, is not also a reason to tell
// the user again about one that is still failing.
const reported = new Set<string>()
// Serialized string length, so roughly double that many bytes once stored.
// Re-serializing anything shorter costs little enough that any shrink earns
// another attempt; past it the cost is what stalls the composer, so only a
// halving does, which is the difference between dropping an attachment and
// editing the text beside it. The test is on the value in hand rather than the
// one that failed, so a payload that has fallen under the line is cheap again
// however large it used to be.
const RETRY_COARSE_LENGTH = 1024 * 1024

function worthRetry(length: number, dropped: number) {
  if (length < RETRY_COARSE_LENGTH) return length < dropped
  return length * 2 <= dropped
}
const FLUSH_CAP_MS = 250

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

export type PersistFailure = { key: string }

const listeners = new Set<(failure: PersistFailure) => void>()

/**
 * A refused write is the one storage failure a user can act on: what they are
 * looking at will not survive a reload. Let the UI say so instead of losing it
 * quietly.
 */
export function onPersistFailure(listener: (failure: PersistFailure) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const recoveries = new Set<(key: string) => void>()

/**
 * The other half of the story: a key that was reported and then stored. A
 * message telling someone to free up room outlives its truth the moment they
 * do, so the UI needs to hear about this to take it back.
 */
export function onPersistRecovered(listener: (key: string) => void) {
  recoveries.add(listener)
  return () => {
    recoveries.delete(listener)
  }
}

/** Persistence observers are advisory UI: one broken observer must not stop the flush. */
function announce(notify: () => void) {
  try {
    notify()
  } catch {
    return
  }
}

type WriteResult = "stored" | "refused"

/**
 * A quota failure from `setItem` leaves the existing entry unchanged. Keep
 * that atomic boundary: removing the current key or any sibling in pursuit of
 * a retry can turn one refused draft into silent loss of previously saved
 * state. Report only this key instead. The value is offered to the tab's cache
 * on the way past, but the cache has a ceiling of its own that anything large
 * enough to be refused here has usually already passed, so a refused draft is
 * generally not kept anywhere.
 */
function write(storage: Storage, key: string, value: string): WriteResult {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return "stored"
  } catch (error) {
    if (!quota(error)) throw error
  }

  cacheSet(key, value)
  return "refused"
}

type Pending = { value: string }
const pending = new Map<string, Pending>()
const queue = { cancel: undefined as (() => void) | undefined }

/**
 * Write every queued value now. Runs from idle time (capped so a burst never
 * waits long), and synchronously before the page is hidden or unloaded.
 */
export function flushPersisted() {
  queue.cancel?.()
  queue.cancel = undefined
  if (pending.size === 0) return

  const items = Array.from(pending.entries())
  pending.clear()
  if (fallback.disabled) return

  for (const [key, item] of items) {
    const dropped = refused.get(key)
    if (dropped !== undefined && !worthRetry(item.value.length, dropped)) continue

    const result = (() => {
      try {
        return write(localStorage, key, item.value)
      } catch {
        fallback.disabled = true
        return undefined
      }
    })()
    if (result === undefined) return

    if (result === "stored") {
      refused.delete(key)
      if (reported.delete(key)) for (const listener of recoveries) announce(() => listener(key))
      continue
    }

    refused.set(key, item.value.length)
    if (reported.has(key)) continue
    reported.add(key)
    for (const listener of listeners) announce(() => listener({ key }))
  }
}

function schedule() {
  if (queue.cancel) return
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(flushPersisted, { timeout: FLUSH_CAP_MS })
    queue.cancel = () => cancelIdleCallback(id)
    return
  }
  const id = setTimeout(flushPersisted, FLUSH_CAP_MS)
  queue.cancel = () => clearTimeout(id)
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", flushPersisted)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersisted()
  })
}

function read(key: string) {
  const queued = pending.get(key)
  if (queued) return queued.value

  const cached = cacheGet(key)
  if (fallback.disabled && cached !== undefined) return cached

  const stored = (() => {
    try {
      return localStorage.getItem(key)
    } catch {
      fallback.disabled = true
      return null
    }
  })()
  if (stored === null) return cached ?? null
  cacheSet(key, stored)
  return stored
}

/**
 * Stores serialize on every mutation, so bootstrap and reconnect bursts used
 * to trigger many small synchronous localStorage writes. Skip values that
 * match what is already cached (hence stored or queued) and coalesce the rest
 * into one deferred write per key.
 */
function enqueue(key: string, value: string) {
  if (cacheGet(key) === value) return
  cacheSet(key, value)
  if (fallback.disabled) return
  pending.set(key, { value })
  schedule()
}

function remove(key: string) {
  pending.delete(key)
  cacheDelete(key)
  refused.delete(key)
  reported.delete(key)
  if (fallback.disabled) return
  try {
    localStorage.removeItem(key)
    refused.clear()
  } catch {
    fallback.disabled = true
  }
}

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function workspaceStorage(dir: string) {
  const head = dir.slice(0, 12) || "workspace"
  const sum = checksum(dir) ?? "0"
  return `openscience.workspace.${head}.${sum}.dat`
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const item = (key: string) => base + key
  return {
    getItem: (key) => read(item(key)),
    setItem: (key, value) => enqueue(item(key), value),
    removeItem: (key) => remove(item(key)),
  }
}

function localStorageDirect(): SyncStorage {
  return {
    getItem: read,
    setItem: (key, value) => enqueue(key, value),
    removeItem: remove,
  }
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `workspace:${key}`, legacy }
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `session:${session}:${key}`, legacy }
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
}

/**
 * Callers that remove from a timer or a `pagehide` handler run with no Solid
 * owner, where `usePlatform()` throws; they pass the platform they captured
 * while one was available.
 */
export function removePersisted(target: { storage?: string; key: string }, platform: Platform = usePlatform()) {
  const isDesktop = platform.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    return platform.storage?.(target.storage)?.removeItem(target.key)
  }

  if (!target.storage) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const platform = usePlatform()
  const config: PersistTarget = typeof target === "string" ? { key: target } : target

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage

  const currentStorage = (() => {
    if (isDesktop) return platform.storage?.(config.storage)
    if (!config.storage) return localStorageDirect()
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!config.storage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const storage = (() => {
    if (!isDesktop) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage

      const api: SyncStorage = {
        getItem: (key) => {
          const raw = current.getItem(key)
          if (raw !== null) {
            const parsed = parse(raw)
            if (parsed === undefined) return raw

            const migrated = config.migrate ? config.migrate(parsed) : parsed
            const merged = merge(defaults, migrated)
            const next = JSON.stringify(merged)
            if (raw !== next) current.setItem(key, next)
            return next
          }

          for (const legacyKey of legacy) {
            const legacyRaw = legacyStore.getItem(legacyKey)
            if (legacyRaw === null) continue

            current.setItem(key, legacyRaw)
            legacyStore.removeItem(legacyKey)

            const parsed = parse(legacyRaw)
            if (parsed === undefined) return legacyRaw

            const migrated = config.migrate ? config.migrate(parsed) : parsed
            const merged = merge(defaults, migrated)
            const next = JSON.stringify(merged)
            if (legacyRaw !== next) current.setItem(key, next)
            return next
          }

          return null
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined

    const api: AsyncStorage = {
      getItem: async (key) => {
        const raw = await current.getItem(key)
        if (raw !== null) {
          const parsed = parse(raw)
          if (parsed === undefined) return raw

          const migrated = config.migrate ? config.migrate(parsed) : parsed
          const merged = merge(defaults, migrated)
          const next = JSON.stringify(merged)
          if (raw !== next) await current.setItem(key, next)
          return next
        }

        if (!legacyStore) return null

        for (const legacyKey of legacy) {
          const legacyRaw = await legacyStore.getItem(legacyKey)
          if (legacyRaw === null) continue

          await current.setItem(key, legacyRaw)
          await legacyStore.removeItem(legacyKey)

          const parsed = parse(legacyRaw)
          if (parsed === undefined) return legacyRaw

          const migrated = config.migrate ? config.migrate(parsed) : parsed
          const merged = merge(defaults, migrated)
          const next = JSON.stringify(merged)
          if (legacyRaw !== next) await current.setItem(key, next)
          return next
        }

        return null
      },
      setItem: async (key, value) => {
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const isAsync = init instanceof Promise
  const [ready] = createResource(
    () => init,
    async (initValue) => {
      if (initValue instanceof Promise) await initValue
      return true
    },
    { initialValue: !isAsync },
  )

  return [state, setState, init, () => ready() === true]
}
