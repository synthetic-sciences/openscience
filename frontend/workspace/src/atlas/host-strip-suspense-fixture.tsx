import { Suspense, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { HostStrip } from "@/atlas/HostStrip"

// Test-only fixture. Suspense's internal resumeEffects() touches module-level
// reactive state (Effects) that must belong to the very same solid-js module
// instance as the render() root it lives under — see HostStrip.test.ts for
// why. Importing Suspense, render, and HostStrip together in one file, loaded
// as one unit through vite's SSR module graph, keeps them on one instance;
// loading "solid-js" and "solid-js/web" as separate bare-specifier
// ssrLoadModule calls (as the rest of this suite's ErrorBoundary-based guard
// does) does not, and crashes the moment Suspense tries to resume effects.
type Transport = (path: string) => Promise<Response>

export function mountHostStripInSuspense(
  request: Transport,
  fallback: () => JSX.Element,
  host: HTMLElement,
): () => void {
  return render(
    () => (
      <Suspense fallback={fallback()}>
        <HostStrip request={request} />
      </Suspense>
    ),
    host,
  )
}
