import { type JSX } from "solid-js"
import { IconResearch } from "./Icon"

interface AgentIconProps {
  size?: number
  strokeWidth?: number
  class?: string
  style?: JSX.CSSProperties
}

export function AgentIcon(props: AgentIconProps): JSX.Element {
  const size = () => props.size ?? 16
  const strokeWidth = () => props.strokeWidth ?? 1.4
  return (
    <span
      class={props.class}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        ...(props.style ?? {}),
      }}
      aria-hidden="true"
    >
      <IconResearch size={size()} strokeWidth={strokeWidth()} />
    </span>
  )
}
