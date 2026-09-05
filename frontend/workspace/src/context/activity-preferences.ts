import { createStore } from "solid-js/store"
import type { ActivityMode } from "@synsci/ui/context/activity"

export const activityPreferenceKey = "openscience:activity-view:v1"
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

export function readActivityMode(storage?: Storage): ActivityMode {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(activityPreferenceKey) === "compact" ? "compact" : "detailed"
  } catch {
    return "detailed"
  }
}

export function writeActivityMode(value: ActivityMode, storage?: Storage) {
  try {
    ;(storage ?? globalThis.localStorage)?.setItem(activityPreferenceKey, value)
  } catch {
    // The control remains usable when this device cannot save preferences.
  }
}

export function activityExpanded(mode: ActivityMode, choice: boolean | undefined, working: boolean) {
  return choice ?? (mode === "detailed" || working)
}

const [state, setState] = createStore({ mode: readActivityMode() })
export const activityPreferences = {
  mode: () => state.mode,
  change(value: ActivityMode) {
    setState("mode", value)
    writeActivityMode(value)
  },
}
