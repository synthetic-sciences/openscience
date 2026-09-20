import type { JSX } from "solid-js"
import type { SynSciLoader } from "./synsci-loader.js"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "synsci-loader": JSX.HTMLAttributes<SynSciLoader> & {
        "attr:size"?: number
        "attr:caption"?: string
        "attr:progress"?: number
        "attr:aria-valuenow"?: number
        "attr:aria-valuetext"?: string
      }
    }
  }
}

/**
 * The loader draws on a 2D canvas from a `Path2D` of the mark, so its module
 * can only evaluate where those exist. Unit-test DOMs (happy-dom, jsdom) and
 * hardened renderers have neither; there the element stays undefined and the
 * caption below reads as plain text instead of throwing at import.
 */
const drawable = () =>
  typeof window !== "undefined" &&
  typeof customElements !== "undefined" &&
  typeof Path2D === "function" &&
  typeof matchMedia === "function" &&
  typeof HTMLCanvasElement === "function" &&
  document.createElement("canvas").getContext("2d")?.getImageData(0, 0, 1, 1).data.length === 4

if (drawable()) void import("./synsci-loader.js")

/** The component animates its own ellipsis, so a caption ends without one. */
const caption = (value: string | undefined) => (value ?? "Loading").replace(/[.…]+$/, "")

/**
 * A real 0-1 fraction, as the percentage the component's own canvas reports in
 * `aria-valuenow` (the ARIA default range for a progressbar is 0-100).
 */
const percent = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined

/**
 * The atom mark assembling itself, with a caption underneath.
 *
 * Colour comes from the surrounding `color` (the theme's strong text token by
 * default), never from a hex value. Indeterminate unless a real 0–1 `progress`
 * exists. Sizes: 180–220 for a full surface, 120–160 for a pane, never below 64.
 */
export function AtomLoader(props: { size?: number; caption?: string; progress?: number; class?: string }) {
  const size = () => props.size ?? 160
  const text = () => caption(props.caption)
  const value = () => percent(props.progress)
  // The component keeps its own caption out of the accessibility tree and
  // names its canvas "Loading", so the host carries the caption as the mark's
  // alternative text; that is what a screen reader voices for the status
  // region around it. A label on a role-less element would sit on a generic
  // node, which readers pass over.
  //
  // `img` has presentational children, so it would also prune the canvas the
  // component labels as a progressbar: a determinate caller's value would
  // reach nothing. Such a caller gets the host as the progressbar instead,
  // carrying the value it was given.
  //
  // Light-DOM text is never rendered once the shadow root attaches, so it
  // duplicates nothing on screen; it is what shows before the element upgrades
  // and what a test can read.
  return (
    <synsci-loader
      class={props.class}
      data-component="atom-loader"
      role={value() === undefined ? "img" : "progressbar"}
      aria-label={text()}
      attr:aria-valuenow={value()}
      attr:aria-valuetext={value() === undefined ? undefined : `${value()}%`}
      style={{ "--atom-loader-size": `${size()}px` }}
      attr:size={size()}
      attr:caption={text()}
      attr:progress={props.progress}
    >
      {text()}
    </synsci-loader>
  )
}

/** A whole surface that is loading: the mark centred on the app background. */
export function LoadingScreen(props: { caption?: string; size?: number; class?: string }) {
  return (
    <div data-component="loading-screen" class={props.class} role="status" aria-live="polite">
      <AtomLoader size={props.size ?? 180} caption={props.caption} />
    </div>
  )
}
