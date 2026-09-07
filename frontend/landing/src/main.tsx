import { createRoot } from "react-dom/client"
import Ace from "./pages/Ace"
import Download from "./pages/Download"
import Landing from "./pages/Landing"
import Privacy from "./pages/Privacy"
import "./index.css"

const ROUTES: Record<string, () => JSX.Element> = {
  "/": Landing,
  "/download": Download,
  "/ace": Ace,
  "/privacy": Privacy,
  "/legal/privacy": Privacy,
  "/legal/privacy-policy": Privacy,
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
  const Page = ROUTES[path] ?? Landing
  return <Page />
}

createRoot(document.getElementById("root")!).render(<App />)
