import { createEffect, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/** Preserve card and disclosure state while fresh JSON objects arrive on every poll. */
export function useStableList<T extends { id: string }>(source: Accessor<T[] | undefined>) {
  const [items, setItems] = createStore<T[]>([])
  createEffect(() => setItems(reconcile(source() ?? [], { key: "id", merge: true })))
  return items
}
