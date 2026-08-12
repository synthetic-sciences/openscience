import { type JSX } from "solid-js"

export type StatusKind = "active" | "pending" | "error" | "done" | "muted"

interface StatusDotProps {
  status: StatusKind
  pulse?: boolean
  size?: number
}

const COLOR: Record<StatusKind, string> = {
  active: "var(--color-success)",
  pending: "var(--color-warning)",
  error: "var(--color-error)",
  done: "var(--color-text-muted)",
  muted: "var(--color-text-faint)",
}

export function StatusDot(props: StatusDotProps): JSX.Element {
  const size = () => props.size ?? 11
  const outlined = () => props.status === "pending" || props.status === "done"
  return (
    <span
      aria-hidden="true"
      class={props.pulse ? "atlas-pulse" : undefined}
      data-status={props.status}
      style={{
        color: COLOR[props.status],
        width: `${size()}px`,
        height: `${size()}px`,
        border: outlined() ? "1.25px solid currentColor" : "1.25px solid transparent",
        "border-radius": "999px",
        "background-color": outlined() ? "transparent" : "currentColor",
        opacity: props.status === "muted" ? 0.6 : 1,
        "box-sizing": "border-box",
        "flex-shrink": 0,
        display: "inline-block",
      }}
    />
  )
}
