import { useEffect, useState } from "react"

export type Theme = "light" | "dark"

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light"
  try {
    const stored = window.localStorage.getItem("docs-theme")
    if (stored === "light" || stored === "dark") return stored
  } catch {
    /* localStorage unavailable */
  }
  return "light"
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  useEffect(() => {
    applyTheme(theme)
    try {
      window.localStorage.setItem("docs-theme", theme)
    } catch {
      /* ignore */
    }
  }, [theme])
  const toggle = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"))
  return { theme, toggle }
}
