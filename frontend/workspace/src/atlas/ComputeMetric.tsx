import { createEffect, createMemo, createSignal, type JSX } from "solid-js"

const HISTORY_LIMIT = 20

const valid = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0

/** A deliberately tiny trace of successful inventory readings. The parent
 * advances `sample` only after a poll succeeds, so stale or hidden tabs never
 * manufacture a flat line. No history is persisted or sent back. */
export function ComputeMetric(props: {
  metric: "memory" | "cpu"
  label: string
  value?: number
  sample?: number
}): JSX.Element {
  const [history, setHistory] = createSignal<number[]>([])

  createEffect(() => {
    void props.sample
    const value = props.value
    if (!valid(value)) return
    setHistory((values) => [...values, value].slice(-HISTORY_LIMIT))
  })

  const points = createMemo(() => {
    const values = history()
    if (!values.length) return ""
    const maximum = Math.max(props.metric === "cpu" ? 100 : 1, ...values)
    const positions = values.length === 1 ? [values[0], values[0]] : values
    return positions
      .map((value, index) => {
        const x = (index / (positions.length - 1)) * 56
        const y = 11 - Math.min(1, value / maximum) * 9
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(" ")
  })

  return (
    <span class="compute-row__metric" data-metric={props.metric}>
      <span>{props.label}</span>
      <svg viewBox="0 0 56 12" aria-hidden="true">
        <path d="M0 11.5H56" />
        <polyline points={points()} />
      </svg>
    </span>
  )
}
