import { onMount, onCleanup, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import type { DesktopTheme } from "./types"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { DEFAULT_THEMES } from "./default-themes"
import { createSimpleContext } from "../context/helper"

export type ColorScheme = "light" | "dark" | "system"

const STORAGE_KEYS = {
  THEME_ID: "openscience-theme-id",
  COLOR_SCHEME: "openscience-color-scheme",
  LEGACY_THEME_CSS_LIGHT: "openscience-theme-css-light",
  LEGACY_THEME_CSS_DARK: "openscience-theme-css-dark",
} as const

const THEME_STYLE_ID = "openscience-theme"

const themeCssKey = (themeId: string, mode: "light" | "dark") => `openscience-theme-css-${themeId}-${mode}`

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function getStoredColorScheme(): ColorScheme | undefined {
  const scheme = localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME)
  if (scheme === "system" || scheme === "light" || scheme === "dark") return scheme
}

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark") {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  try {
    localStorage.setItem(themeCssKey(themeId, mode), css)
  } catch {}

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  document.getElementById("openscience-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", tokens["background-base"])
}

function cacheThemeVariants(theme: DesktopTheme, themeId: string) {
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    try {
      localStorage.setItem(themeCssKey(themeId, mode), css)
    } catch {}
  }
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { defaultTheme?: string; lockedTheme?: string; lockedScheme?: Exclude<ColorScheme, "system"> }) => {
    const lockedTheme = props.lockedTheme && DEFAULT_THEMES[props.lockedTheme] ? props.lockedTheme : undefined
    const lockedScheme = props.lockedScheme
    // OpenScience is a long-running research workbench, so new installations
    // start in its lower-glare dark appearance. System and Light remain real,
    // persisted choices once the user selects them.
    const initialScheme = lockedScheme ?? getStoredColorScheme() ?? "dark"
    const [store, setStore] = createStore({
      themes: DEFAULT_THEMES as Record<string, DesktopTheme>,
      themeId: lockedTheme ?? props.defaultTheme ?? "openscience",
      colorScheme: initialScheme,
      mode: initialScheme === "system" ? getSystemMode() : initialScheme,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    onMount(() => {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const handler = () => {
        if (store.colorScheme === "system") {
          setStore("mode", getSystemMode())
        }
      }
      mediaQuery.addEventListener("change", handler)
      onCleanup(() => mediaQuery.removeEventListener("change", handler))

      const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME_ID)
      const savedScheme = getStoredColorScheme()
      if (lockedTheme) {
        setStore("themeId", lockedTheme)
        localStorage.setItem(STORAGE_KEYS.THEME_ID, lockedTheme)
        localStorage.removeItem(STORAGE_KEYS.LEGACY_THEME_CSS_LIGHT)
        localStorage.removeItem(STORAGE_KEYS.LEGACY_THEME_CSS_DARK)
      } else if (savedTheme && store.themes[savedTheme]) {
        setStore("themeId", savedTheme)
      }
      if (lockedScheme) {
        setStore("colorScheme", lockedScheme)
        setStore("mode", lockedScheme)
        localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, lockedScheme)
      } else if (savedScheme) {
        setStore("colorScheme", savedScheme)
        if (savedScheme !== "system") {
          setStore("mode", savedScheme)
        }
      }
      const currentTheme = store.themes[store.themeId]
      if (currentTheme) {
        cacheThemeVariants(currentTheme, store.themeId)
      }
    })

    createEffect(() => {
      const theme = store.themes[store.themeId]
      if (theme) {
        applyThemeCss(theme, store.themeId, store.mode)
      }
    })

    const setTheme = (id: string) => {
      if (lockedTheme && id !== lockedTheme) return
      const theme = store.themes[id]
      if (!theme) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      setStore("themeId", id)
      localStorage.setItem(STORAGE_KEYS.THEME_ID, id)
      cacheThemeVariants(theme, id)
    }

    const setColorScheme = (scheme: ColorScheme) => {
      if (lockedScheme && scheme !== lockedScheme) return
      setStore("colorScheme", scheme)
      localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setStore("mode", scheme === "system" ? getSystemMode() : scheme)
    }

    return {
      themeId: () => store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      themes: () => store.themes,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => setStore("themes", theme.id, theme),
      previewTheme: (id: string) => {
        if (lockedTheme && id !== lockedTheme) return
        const theme = store.themes[id]
        if (!theme) return
        setStore("previewThemeId", id)
        const previewMode = store.previewScheme
          ? store.previewScheme === "system"
            ? getSystemMode()
            : store.previewScheme
          : store.mode
        applyThemeCss(theme, id, previewMode)
      },
      previewColorScheme: (scheme: ColorScheme) => {
        if (lockedScheme && scheme !== lockedScheme) return
        setStore("previewScheme", scheme)
        const previewMode = scheme === "system" ? getSystemMode() : scheme
        const id = store.previewThemeId ?? store.themeId
        const theme = store.themes[id]
        if (theme) {
          applyThemeCss(theme, id, previewMode)
        }
      },
      commitPreview: () => {
        if (store.previewThemeId) {
          setTheme(store.previewThemeId)
        }
        if (store.previewScheme) {
          setColorScheme(store.previewScheme)
        }
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
      },
      cancelPreview: () => {
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
        const theme = store.themes[store.themeId]
        if (theme) {
          applyThemeCss(theme, store.themeId, store.mode)
        }
      },
    }
  },
})
