import Ace from "./pages/Ace"
import Benchmark from "./pages/Benchmark"
import Download from "./pages/Download"
import Landing from "./pages/Landing"
import Privacy from "./pages/Privacy"

/* Old paths (/benchmarks, /blog/launch, /legal/privacy, ...) are 308s in vercel.json. */
export const ROUTES: Record<string, () => JSX.Element> = {
  "/": Landing,
  "/download": Download,
  "/ace": Ace,
  "/benchmark": Benchmark,
  "/privacy": Privacy,
}

export default function App({ path }: { path: string }) {
  const Page = ROUTES[path.replace(/\/+$/, "") || "/"] ?? Landing
  return <Page />
}
