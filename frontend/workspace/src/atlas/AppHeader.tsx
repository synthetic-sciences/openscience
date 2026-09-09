/**
 * Shared top header shell so the home and session views use one consistent
 * strip (height, padding, border) instead of two hand-rolled headers that
 * drift apart.
 */
import { type JSX } from "solid-js"

export function AppHeader(props: { children: JSX.Element; class?: string }): JSX.Element {
  return (
    <header
      class={`g-strip${props.class ? ` ${props.class}` : ""}`}
      style={{
        display: "flex",
        "align-items": "center",
        gap: "12px",
        padding: "10px 20px",
        "flex-shrink": 0,
        position: "relative",
        "z-index": 10,
      }}
    >
      {props.children}
    </header>
  )
}
