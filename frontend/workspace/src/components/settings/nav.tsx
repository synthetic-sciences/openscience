import { createContext, useContext } from "solid-js"
import type { SettingsPanelId } from "./registry"

// Lets a panel jump to another panel through the shell's history stack (e.g.
// Storage ▸ "Cloud storage" → Credentials). The shell (dialog-settings.tsx)
// provides the real `navigate`; the default is a no-op for isolated renders.
export const SettingsNavContext = createContext<(id: SettingsPanelId) => void>(() => {})

export function useSettingsNav() {
  return useContext(SettingsNavContext)
}
