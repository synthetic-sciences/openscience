import React from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { App } from "./App"
import { movedHref } from "./navigation"
import "./styles/index.css"

const moved = movedHref(window.location.pathname, window.location.hash)
if (moved) {
  window.location.replace(moved)
} else {
  const root = document.getElementById("root")!
  const app = (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
  // Production builds ship every page prerendered (script/prerender.ts); the dev server doesn't.
  if (root.hasChildNodes()) hydrateRoot(root, app)
  else createRoot(root).render(app)
}
