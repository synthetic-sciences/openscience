// The state and the colours arrive in the URL from main.mjs (appearance.mjs),
// so this page holds no palette of its own and always paints what the
// workspace window will.
;(() => {
  const params = new URLSearchParams(location.search)
  const hex = (value) => (/^#[0-9a-f]{6}$/i.test(value ?? "") ? value : undefined)
  const root = document.documentElement
  root.dataset.colorScheme = params.get("scheme") === "light" ? "light" : "dark"
  const background = hex(params.get("background"))
  const foreground = hex(params.get("foreground"))
  if (background) root.style.setProperty("--background-base", background)
  if (foreground) root.style.setProperty("--text-strong", foreground)
  const captions = { start: "Starting your local workspace", install: "Installing in Applications" }
  document.querySelector("synsci-loader").setAttribute("caption", captions[params.get("state")] ?? captions.start)
})()
