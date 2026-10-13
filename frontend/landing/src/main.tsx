import { createRoot, hydrateRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

const root = document.getElementById("root")!
const app = <App path={window.location.pathname} />

// Production builds ship prerendered markup for each page (scripts/prerender.mjs); the dev server doesn't.
if (root.hasChildNodes()) hydrateRoot(root, app)
else createRoot(root).render(app)
