/**
 * The `<synsci-loader>` web component: particles stream along the mark's
 * three orbits and assemble into it. Registered on import when the page can
 * draw on a 2D canvas; `atom-loader.tsx` decides whether to load it.
 */
export declare class SynSciLoader extends HTMLElement {
  /** A 0–1 value while determinate, `null` while indeterminate. */
  get progress(): number | null
  set progress(value: number | null)
  /** Settles the mark and plays the burst ending. */
  complete(): void
  reset(): void
}
