import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@synsci/ui/context"
import { persisted } from "@/utils/persist"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  enabled: boolean
  volume: number
  agent: string
  permissions: string
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
  }
  updates: {
    startup: boolean
  }
  appearance: {
    fontSize: number
    font: string
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
  ui: {
    showChangesView: boolean
  }
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
  },
  updates: {
    startup: true,
  },
  appearance: {
    fontSize: 14,
    font: "ibm-plex-mono",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    // Audio feedback is opt-in. The choices are ready when it is enabled, but
    // fresh installs remain silent and playback stays deliberately subtle.
    enabled: false,
    volume: 0.3,
    agent: "yup-01",
    permissions: "bip-bop-01",
    errors: "alert-01",
  },
  ui: {
    showChangesView: false,
  },
}

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const monoPrefix = '"Söhne Mono", "Sohne Mono"'

const monoFonts: Record<string, string> = {
  "ibm-plex-mono": `${monoPrefix}, "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "cascadia-code": `${monoPrefix}, "Cascadia Code Nerd Font", "Cascadia Code NF", "Cascadia Mono NF", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "fira-code": `${monoPrefix}, "Fira Code Nerd Font", "FiraMono Nerd Font", "FiraMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  hack: `${monoPrefix}, "Hack Nerd Font", "Hack Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  inconsolata: `${monoPrefix}, "Inconsolata Nerd Font", "Inconsolata Nerd Font Mono","IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "intel-one-mono": `${monoPrefix}, "Intel One Mono Nerd Font", "IntoneMono Nerd Font", "IntoneMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  iosevka: `${monoPrefix}, "Iosevka Nerd Font", "Iosevka Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "jetbrains-mono": `${monoPrefix}, "JetBrains Mono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrainsMonoNL Nerd Font", "JetBrainsMonoNL Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "meslo-lgs": `${monoPrefix}, "Meslo LGS Nerd Font", "MesloLGS Nerd Font", "MesloLGM Nerd Font", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "roboto-mono": `${monoPrefix}, "Roboto Mono Nerd Font", "RobotoMono Nerd Font", "RobotoMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "source-code-pro": `${monoPrefix}, "Source Code Pro Nerd Font", "SauceCodePro Nerd Font", "SauceCodePro Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
  "ubuntu-mono": `${monoPrefix}, "Ubuntu Mono Nerd Font", "UbuntuMono Nerd Font", "UbuntuMono Nerd Font Mono", "IBM Plex Mono", "IBM Plex Mono Fallback", ${monoFallback}`,
}

export function monoFontFamily(font: string | undefined) {
  return monoFonts[font ?? defaultSettings.appearance.font] ?? monoFonts[defaultSettings.appearance.font]
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))

    createEffect(() => {
      if (typeof document === "undefined") return
      document.documentElement.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.font))
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: createMemo(() => store.general?.autoSave ?? defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: createMemo(() => store.general?.releaseNotes ?? defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
      },
      updates: {
        startup: createMemo(() => store.updates?.startup ?? defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
      },
      appearance: {
        fontSize: createMemo(() => store.appearance?.fontSize ?? defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: createMemo(() => store.appearance?.font ?? defaultSettings.appearance.font),
        setFont(value: string) {
          setStore("appearance", "font", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", action, undefined!)
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: createMemo(() => store.permissions?.autoApprove ?? defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: createMemo(() => store.notifications?.agent ?? defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: createMemo(() => store.notifications?.permissions ?? defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: createMemo(() => store.notifications?.errors ?? defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        enabled: createMemo(() => {
          const stored = store.sounds?.enabled
          if (stored !== undefined) return stored
          // Preserve the intent of pre-toggle settings: a previously chosen
          // sound means the user had explicitly enabled audio feedback.
          return Boolean(store.sounds?.agent || store.sounds?.permissions || store.sounds?.errors)
        }),
        setEnabled(value: boolean) {
          setStore("sounds", "enabled", value)
          if (!value) return
          if (!store.sounds.agent) setStore("sounds", "agent", defaultSettings.sounds.agent)
          if (!store.sounds.permissions) setStore("sounds", "permissions", defaultSettings.sounds.permissions)
          if (!store.sounds.errors) setStore("sounds", "errors", defaultSettings.sounds.errors)
        },
        volume: createMemo(() => store.sounds?.volume ?? defaultSettings.sounds.volume),
        setVolume(value: number) {
          const next = Number.isFinite(value) ? value : defaultSettings.sounds.volume
          setStore("sounds", "volume", Math.min(1, Math.max(0, next)))
        },
        agent: createMemo(() => store.sounds?.agent ?? defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissions: createMemo(() => store.sounds?.permissions ?? defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errors: createMemo(() => store.sounds?.errors ?? defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
      ui: {
        showChangesView: createMemo(() => store.ui?.showChangesView ?? defaultSettings.ui.showChangesView),
        setShowChangesView(value: boolean) {
          setStore("ui", "showChangesView", value)
        },
      },
    }
  },
})
