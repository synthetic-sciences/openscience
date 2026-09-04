import { createSignal } from "solid-js"
import { DEFAULT_WARN_TOKENS } from "@/pages/session-context"

export type ProductPreferences = {
  show_trace: boolean
  atlas_enabled: boolean
  show_local_models: boolean
  // Effective `compaction.warn_tokens` served by /settings/preferences. The
  // session page compares the live conversation size against it.
  compaction_warn_tokens?: number
}

const [localModels, setLocalModels] = createSignal(true)
const [warnTokens, setWarnTokens] = createSignal(DEFAULT_WARN_TOKENS)

// Gateway and Trace remain backend preferences for compatibility, but they are
// not public navigation surfaces. Keep legacy `true` values from reviving an
// entry point after an upgrade.
const hiddenSurface = () => false

export const productPreferences = {
  trace: hiddenSurface,
  atlas: hiddenSurface,
  localModels,
  warnTokens,
  sync(preferences: Partial<ProductPreferences>) {
    if (preferences.show_local_models !== undefined) setLocalModels(preferences.show_local_models === true)
    if (preferences.compaction_warn_tokens !== undefined && preferences.compaction_warn_tokens > 0) {
      setWarnTokens(preferences.compaction_warn_tokens)
    }
  },
}
