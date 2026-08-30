import { createRoot } from "react-dom/client"
import Download from "./pages/Download"
import Landing from "./pages/Landing"
import "./index.css"

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
  return path === "/download" ? <Download /> : <Landing />
}

createRoot(document.getElementById("root")!).render(<App />)
