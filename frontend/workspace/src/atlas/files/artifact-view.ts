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

const storageOrNothing = (given?: Storage) => given ?? (globalThis as { localStorage?: Storage }).localStorage

// Validated the way ui.ts:287 validates the agent picker: a value that is not
// one of ours is treated as absent, so a hand-edited key cannot render a
// toolbar with no working controls.
export function readView(storage = storageOrNothing()): View {
  try {
    const raw = storage?.getItem(VIEW_KEY)
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

export function writeView(view: View, storage = storageOrNothing()): void {
  try {
    storage?.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
}
