import { createRoot } from "react-dom/client"
import { Analytics } from "@vercel/analytics/react"
import Download from "./pages/Download"
import Landing from "./pages/Landing"
import "./index.css"

const ANALYTICS_PREFERENCE = "openscience.websiteAnalytics"

function App() {
  const analyticsEnabled = window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off"
  const path = window.location.pathname.replace(/\/+$/, "") || "/"

  return (
    <>
      {path === "/download" ? <Download /> : <Landing />}
      {analyticsEnabled ? <Analytics /> : null}
    </>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
