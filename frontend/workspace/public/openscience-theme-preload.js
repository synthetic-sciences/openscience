;(function () {
  // OpenScience currently ships one canonical product theme. Pin it before the
  // application mounts so an older saved gallery theme cannot flash or leave
  // the workspace on an incompatible near-black token set.
  var themeId = "openscience"
  localStorage.setItem("openscience-theme-id", themeId)

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

  // Keep in lockstep with themeCssKey() in ui/src/theme/context.tsx. Theme id
  // is part of the cache key so CSS from a previously selected theme can never
  // be replayed during startup.
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
