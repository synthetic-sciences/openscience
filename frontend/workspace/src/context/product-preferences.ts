import { createSignal } from "solid-js"

export type ProductPreferences = {
  show_trace: boolean
}

const [trace, setTrace] = createSignal(false)

export const productPreferences = {
  trace,
  sync(preferences: Partial<ProductPreferences>) {
    setTrace(preferences.show_trace === true)
  },
}
