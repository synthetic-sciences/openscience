import { createStore, reconcile } from "solid-js/store"

const key = "openscience-trace-expansion-v1"
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

const browserStorage = () => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Keep the classic per-turn preference, including an explicit collapse of a
 * live turn. A working turn opens once; finishing never closes it again. */
export function createTraceExpansion(storage: Storage | undefined = browserStorage()) {
  const read = () => {
    try {
      const value: unknown = JSON.parse(storage?.getItem(key) ?? "{}")
      if (!value || typeof value !== "object" || Array.isArray(value)) return {}
      return Object.fromEntries(
        Object.entries(value)
          .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
          .slice(-200),
      )
    } catch {
      return {}
    }
  }
  const [state, setState] = createStore<Record<string, boolean>>(read())
  const set = (id: string, expanded: boolean) => {
    const next = Object.fromEntries(
      [...Object.entries(state).filter(([name]) => name !== id), [id, expanded]].slice(-200),
    )
    setState(reconcile(next))
    try {
      storage?.setItem(key, JSON.stringify(next))
    } catch {}
  }
  return {
    expanded: (id: string) => state[id] === true,
    toggle: (id: string) => set(id, state[id] !== true),
    open: (id: string) => {
      if (state[id] === undefined) set(id, true)
    },
  }
}
