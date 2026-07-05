/**
 * Shared top header shell so the home and session views use one consistent
 * strip (height, padding, border) and one icon-button treatment instead of
 * two hand-rolled headers that drift apart.
 */
import { type JSX } from "solid-js"

export function AppHeader(props: { children: JSX.Element }): JSX.Element {
  return (
    <header
      class="g-strip"
      style={{
        display: "flex",
        "align-items": "center",
        gap: "12px",
        padding: "12px 24px",
        "flex-shrink": 0,
        position: "relative",
        "z-index": 10,
      }}
    >
      {props.children}
    </header>
  )
}

export function HeaderIconButton(props: { onClick: () => void; title: string; children: JSX.Element }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      style={{
        all: "unset",
        "box-sizing": "border-box",
        cursor: "pointer",
        width: "32px",
        height: "32px",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        "border-radius": "4px",
        border: "1px solid var(--color-border)",
        color: "var(--color-text-muted)",
        background: "var(--color-surface-solid)",
        transition: "background 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-bg-elevated)"
        e.currentTarget.style.color = "var(--color-text)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--color-surface-solid)"
        e.currentTarget.style.color = "var(--color-text-muted)"
      }}
    >
      {props.children}
    </button>
  )
}

export function HeaderDivider(): JSX.Element {
  return <span style={{ width: "1px", height: "16px", background: "var(--color-border)" }} />
}
