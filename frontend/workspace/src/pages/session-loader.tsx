import { Show, createSignal, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

type Shell = typeof import("@/pages/session-shell")

let pending: Promise<Shell> | undefined
let loaded: Shell["default"] | undefined

const loadSession = () => {
  pending ??= import("@/pages/session-shell")
    .then((module) => {
      loaded = module.default
      return module
    })
    .catch((error) => {
      pending = undefined
      throw error
    })
  return pending
}

/**
 * Loads the session page without a Suspense boundary.
 *
 * Every resource read under a Suspense boundary re-suspends on refetch, so a
 * `lazy()` page wrapped in `<Suspense>` let any background refresh inside the
 * conversation (an approval that changed project access, a filesystem grant,
 * a receipt check) swap the whole transcript for the loading fallback, and a
 * refresh that never settled left it blank until the project was reopened.
 * Only the module import is gated here; resources inside render in place.
 */
export function Session(props: { fallback?: JSX.Element }) {
  const [page, setPage] = createSignal<Component | undefined>(loaded)
  const [failure, setFailure] = createSignal<Error>()
  if (!page()) {
    loadSession().then(
      (module) => setPage(() => module.default),
      (error: unknown) => setFailure(error instanceof Error ? error : new Error(String(error))),
    )
  }
  return (
    <>
      <Show when={failure()}>
        {(error) => {
          // Rendered so the error reaches the app's ErrorBoundary like a
          // failed lazy() import would, instead of a spinner that never ends.
          throw error()
        }}
      </Show>
      <Show when={page()} fallback={props.fallback}>
        {(component) => <Dynamic component={component()} />}
      </Show>
    </>
  )
}

export const preloadSession = () => {
  void loadSession().catch(() => undefined)
}
