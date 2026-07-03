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

interface BlockProgressProps {
  progress: number
  width?: number
  label?: string
}

export function BlockProgress(props: BlockProgressProps): JSX.Element {
  const filled = () => {
    const w = props.width ?? 12
    const p = Math.max(0, Math.min(1, props.progress))
    return Math.round(p * w)
  }
  const total = () => props.width ?? 12
  const bar = () => "▓".repeat(filled()) + "░".repeat(total() - filled())
  return (
    <span
      style={{
        "font-family": FONT_MONO,
        "font-size": "11px",
        color: "var(--color-text-muted)",
        display: "inline-flex",
        "align-items": "center",
        gap: "8px",
      }}
    >
      <span style={{ "letter-spacing": "0.04em" }}>[{bar()}]</span>
      <Show when={props.label}>
        <span style={{ color: "var(--color-text-faint)", "font-size": "10px" }}>{props.label}</span>
      </Show>
    </span>
  )
}

interface BlinkCursorProps {
  char?: string
}

export function BlinkCursor(props: BlinkCursorProps): JSX.Element {
  return (
    <span
      class="thesis-blink"
      style={{
        "font-family": FONT_MONO,
        "font-size": "inherit",
        color: "currentColor",
        display: "inline-block",
        "margin-left": "2px",
      }}
    >
      {props.char ?? "_"}
    </span>
  )
}
