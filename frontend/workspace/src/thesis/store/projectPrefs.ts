import { createSignal, createEffect } from "solid-js"

/**
 * Per-user preferences for project rows on the home page:
 *  - favorites: sticky-on-top, marked with a filled star.
 *  - hidden:    filtered out of the recent list.
 *
 * Both are keyed by the openscience project worktree (absolute path) and
 * persisted to localStorage so they survive reloads. We do NOT delete
 * the project from openscience itself — openscience tracks workspaces globally,
 * and the user might want to "unhide" later.
 */

const FAV_KEY = "thesis-project-favorites-v1"
const HIDE_KEY = "thesis-project-hidden-v1"

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr) : new Set()
  } catch {
    return new Set()
  }
}

function writeSet(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)))
  } catch {}
}

const [favorites, setFavoritesSig] = createSignal<Set<string>>(readSet(FAV_KEY))
const [hidden, setHiddenSig] = createSignal<Set<string>>(readSet(HIDE_KEY))

createEffect(() => writeSet(FAV_KEY, favorites()))
createEffect(() => writeSet(HIDE_KEY, hidden()))

const toggleFavorite = (path: string) => {
  setFavoritesSig((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  setHiddenSig((prev) => {
    if (!prev.has(path)) return prev
    const next = new Set(prev)
    next.delete(path)
    return next
  })
}

const hide = (path: string) => {
  setHiddenSig((prev) => new Set(prev).add(path))
  setFavoritesSig((prev) => {
    if (!prev.has(path)) return prev
    const next = new Set(prev)
    next.delete(path)
    return next
  })
}

const unhide = (path: string) => {
  setHiddenSig((prev) => {
    if (!prev.has(path)) return prev
    const next = new Set(prev)
    next.delete(path)
    return next
  })
}

const isFavorite = (path: string) => favorites().has(path)
const isHidden = (path: string) => hidden().has(path)

export const projectPrefs = {
  favorites,
  hidden,
  toggleFavorite,
  hide,
  unhide,
  isFavorite,
  isHidden,
}
