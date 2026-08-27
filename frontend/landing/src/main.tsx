import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Analytics } from "@vercel/analytics/react"
import Download from "./pages/Download"
import Landing from "./pages/Landing"
import "./index.css"

const ANALYTICS_PREFERENCE = "openscience.websiteAnalytics"

function App() {
  const [analyticsEnabled, setAnalyticsEnabled] = useState(
    () => window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off",
  )
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
  const toggle = () => {
    const next = !analyticsEnabled
    window.localStorage.setItem(ANALYTICS_PREFERENCE, next ? "on" : "off")
    setAnalyticsEnabled(next)
  }

  return (
    <>
      {path === "/download" ? (
        <Download analyticsEnabled={analyticsEnabled} onAnalyticsToggle={toggle} />
      ) : (
        <Landing analyticsEnabled={analyticsEnabled} onAnalyticsToggle={toggle} />
      )}
      {analyticsEnabled ? <Analytics /> : null}
    </>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
