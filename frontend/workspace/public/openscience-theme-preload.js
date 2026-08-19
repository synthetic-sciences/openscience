;(function () {
  // Apply the saved theme before the application mounts. The runtime validates
  // it against the bundled gallery; this small guard only prevents malformed
  // storage values from becoming selectors or cache keys during startup.
  var savedTheme = localStorage.getItem("openscience-theme-id") || "openscience"
  var themeId = /^[a-z0-9-]+$/i.test(savedTheme) ? savedTheme : "openscience"

  // Respect the explicit display mode, or mirror the OS when set to System.
  // Validate the stored value so an obsolete preference cannot strand startup.
  // Dark is the first-run default. Existing System and Light choices remain
  // authoritative and are never overwritten here.
  var scheme = localStorage.getItem("openscience-color-scheme") || "dark"
  if (scheme !== "system" && scheme !== "light" && scheme !== "dark") scheme = "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  // Keep in lockstep with themeCssKey() in ui/src/theme/context.tsx.
  var css = localStorage.getItem("openscience-theme-css-" + themeId + "-" + mode)
  if (css) {
    var background = css.match(/--background-base:\s*([^;]+);/)
    if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background[1].trim())
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
