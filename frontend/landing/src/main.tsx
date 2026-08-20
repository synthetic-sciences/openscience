import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Analytics } from "@vercel/analytics/react"
import Landing from "./pages/Landing"
import "./index.css"

const ANALYTICS_PREFERENCE = "openscience.websiteAnalytics"

function App() {
  const [analyticsEnabled, setAnalyticsEnabled] = useState(
    () => window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off",
  )

  return (
    <>
      <Landing
        analyticsEnabled={analyticsEnabled}
        onAnalyticsToggle={() => {
          const next = !analyticsEnabled
          window.localStorage.setItem(ANALYTICS_PREFERENCE, next ? "on" : "off")
          setAnalyticsEnabled(next)
        }}
      />
      {analyticsEnabled ? <Analytics /> : null}
    </>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
