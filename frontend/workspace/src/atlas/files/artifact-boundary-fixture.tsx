import { ErrorBoundary, Suspense, type JSX } from "solid-js"

/**
 * The two boundaries RightPane.tsx:351 puts the Files pane inside, in one
 * component so a test can mount through them.
 *
 * It has to live in the app's own module graph: importing solid-js separately
 * from a test file yields a second Solid instance whose Suspense and
 * ErrorBoundary share no runtime with the component under test, which fails with
 * "computations created outside a createRoot" rather than with a useful result.
 */
export function Guarded(props: { view: () => JSX.Element }): JSX.Element {
  return (
    <ErrorBoundary fallback={() => "BOUNDARY-CAUGHT"}>
      <Suspense fallback="PANE-REPLACED-BY-SPINNER">{props.view()}</Suspense>
    </ErrorBoundary>
  )
}
