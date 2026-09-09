import { createSignal, onCleanup, onMount, type JSX, Show } from "solid-js"
import { FONT_MONO } from "@/styles/tokens"

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

interface AsciiSpinnerProps {
  label?: string
  size?: number
  color?: string
  speed?: number
}

export function AsciiSpinner(props: AsciiSpinnerProps): JSX.Element {
  const [frame, setFrame] = createSignal(0)
  onMount(() => {
    const speed = props.speed ?? 80
    const id = setInterval(() => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length), speed)
    onCleanup(() => clearInterval(id))
  })
  return (
    <span
      style={{
        "font-family": FONT_MONO,
        "font-size": `${props.size ?? 11}px`,
        color: props.color ?? "var(--color-text-muted)",
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
      }}
    >
      <span style={{ width: "10px", "text-align": "center" }}>{BRAILLE_FRAMES[frame()]}</span>
      <Show when={props.label}>
        <span>{props.label}</span>
      </Show>
    </span>
  )
}
