import { createSignal } from "solid-js"

export type ProductPreferences = {
  show_trace: boolean
  atlas_enabled: boolean
  show_local_models: boolean
}

const [localModels, setLocalModels] = createSignal(true)

// Gateway and Trace remain backend preferences for compatibility, but they are
// not public navigation surfaces. Keep legacy `true` values from reviving an
// entry point after an upgrade.
const hiddenSurface = () => false

export const productPreferences = {
  trace: hiddenSurface,
  atlas: hiddenSurface,
  localModels,
  sync(preferences: Partial<ProductPreferences>) {
    if (preferences.show_local_models !== undefined) setLocalModels(preferences.show_local_models === true)
  },
}
