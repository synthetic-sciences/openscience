import { createSignal } from "solid-js"

export type ProductPreferences = {
  show_trace: boolean
  atlas_enabled: boolean
  show_local_models: boolean
}

const [trace, setTrace] = createSignal(false)
const [atlas, setAtlas] = createSignal(false)
const [localModels, setLocalModels] = createSignal(true)

export const productPreferences = {
  trace,
  atlas,
  localModels,
  sync(preferences: Partial<ProductPreferences>) {
    if (preferences.show_trace !== undefined) setTrace(preferences.show_trace === true)
    if (preferences.atlas_enabled !== undefined) setAtlas(preferences.atlas_enabled === true)
    if (preferences.show_local_models !== undefined) setLocalModels(preferences.show_local_models === true)
  },
}
