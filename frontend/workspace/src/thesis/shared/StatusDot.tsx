import { type JSX } from "solid-js"
import { FONT_MONO } from "@/styles/tokens"

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

const CHAR: Record<StatusKind, string> = {
  active: "●",
  pending: "◐",
  error: "×",
  done: "○",
  muted: "·",
}

export function StatusDot(props: StatusDotProps): JSX.Element {
  const size = () => props.size ?? 11
  return (
    <span
      aria-hidden="true"
      class={props.pulse ? "thesis-pulse" : undefined}
      style={{
        "font-family": FONT_MONO,
        "font-size": `${size()}px`,
        color: COLOR[props.status],
        width: `${size() - 1}px`,
        "text-align": "center",
        "flex-shrink": 0,
        "line-height": 1,
        display: "inline-block",
      }}
    >
      {CHAR[props.status]}
    </span>
  )
}
