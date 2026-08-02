import { createSignal } from "solid-js"

export type ProductPreferences = {
  show_trace: boolean
  atlas_enabled: boolean
}

const [trace, setTrace] = createSignal(false)
const [atlas, setAtlas] = createSignal(true)

export const productPreferences = {
  trace,
  atlas,
  sync(preferences: Partial<ProductPreferences>) {
    if (preferences.show_trace !== undefined) setTrace(preferences.show_trace === true)
    if (preferences.atlas_enabled !== undefined) setAtlas(preferences.atlas_enabled !== false)
  },
}
