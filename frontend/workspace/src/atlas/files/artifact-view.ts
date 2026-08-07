import type { Sort } from "./artifact-groups"

export interface View {
  sort: Sort
  layout: "grid" | "list"
  sizes: boolean
}

export const VIEW_KEY = "openscience:artifacts-view"
export const DEFAULT_VIEW: View = { sort: "created", layout: "grid", sizes: false }

interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// Resolved inside the callers' try blocks, never as a default argument: reading
// globalThis.localStorage is itself what throws in a sandboxed frame or a
// blocked-storage browser, and readView runs during the grid's render, so an
// escape here reaches the app-wide ErrorBoundary and takes the workspace with it.
const storageOrNothing = (given?: Storage) => given ?? (globalThis as { localStorage?: Storage }).localStorage

// Validated the way ui.ts:287 validates the agent picker: a value that is not
// one of ours is treated as absent, so a hand-edited key cannot render a
// toolbar with no working controls.
export function readView(given?: Storage): View {
  try {
    const raw = storageOrNothing(given)?.getItem(VIEW_KEY)
    if (!raw) return DEFAULT_VIEW
    const value = JSON.parse(raw) as Partial<View>
    if (value.sort !== "created" && value.sort !== "name") return DEFAULT_VIEW
    if (value.layout !== "grid" && value.layout !== "list") return DEFAULT_VIEW
    if (typeof value.sizes !== "boolean") return DEFAULT_VIEW
    return { sort: value.sort, layout: value.layout, sizes: value.sizes }
  } catch {
    return DEFAULT_VIEW
  }
}

export function writeView(view: View, given?: Storage): void {
  try {
    storageOrNothing(given)?.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
}
