;(function () {
  var themeId = localStorage.getItem("openscience-theme-id")
  if (!themeId) return

  var scheme = localStorage.getItem("openscience-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "openscience-1") return

  // Keep in lockstep with STORAGE_KEYS.THEME_CSS_* in ui/src/theme/context.tsx —
  // the cache is keyed by mode only, not by theme id.
  var css = localStorage.getItem("openscience-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "openscience-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
