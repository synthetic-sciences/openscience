import { createMemo, createSignal, For, Show, type JSX } from "solid-js"

export type ChartSeries = {
  id: string
  label: string
  color: string
  points: Array<{ step: number; value: number }>
}

const PALETTE = [
  "#5b8def",
  "#e8873a",
  "#4cb782",
  "#d05fbf",
  "#e0c341",
  "#4fb8c9",
  "#e0605e",
  "#9b7fe0",
  "#7fa64a",
  "#c98857",
]

export function colorFor(index: number) {
  return PALETTE[index % PALETTE.length]!
}

/** Exponential smoothing in the style of experiment trackers: 0 is raw, 0.9 is heavy. */
function smooth(points: Array<{ step: number; value: number }>, factor: number) {
  if (factor <= 0 || points.length < 3) return points
  const out: Array<{ step: number; value: number }> = []
  let last: number | undefined
  for (const point of points) {
    last = last === undefined ? point.value : last * factor + point.value * (1 - factor)
    out.push({ step: point.step, value: last })
  }
  return out
}

export function formatValue(value: number) {
  if (!Number.isFinite(value)) return String(value)
  const abs = Math.abs(value)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return value.toExponential(2)
  if (abs >= 100) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(3)
  return Number(value.toPrecision(4)).toString()
}

function ticks(min: number, max: number, count: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const span = max - min
  const rough = span / Math.max(1, count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let value = start; value <= max + step / 2 && out.length < 12; value += step) out.push(Number(value.toFixed(12)))
  return out
}

/**
 * A multi-run line chart without a charting dependency: SVG paths, a shared
 * hover cursor with the nearest value per series, optional log scale and
 * smoothing. Sized by its container; redraws are cheap at the downsampled
 * point counts the server returns.
 */
export function MetricChart(props: {
  series: ChartSeries[]
  height?: number
  log?: boolean
  smoothing?: number
  xLabel?: string
  emphasize?: string
}): JSX.Element {
  const [width, setWidth] = createSignal(480)
  const [hover, setHover] = createSignal<number>()
  const height = () => props.height ?? 200
  const margin = { top: 10, right: 12, bottom: 24, left: 46 }

  const shown = createMemo(() =>
    props.series.map((series) => ({ ...series, points: smooth(series.points, props.smoothing ?? 0) })),
  )
  const domain = createMemo(() => {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const series of shown()) {
      for (const point of series.points) {
        if (props.log && point.value <= 0) continue
        minX = Math.min(minX, point.step)
        maxX = Math.max(maxX, point.step)
        minY = Math.min(minY, point.value)
        maxY = Math.max(maxY, point.value)
      }
    }
    if (!Number.isFinite(minX)) return undefined
    if (minY === maxY) {
      minY -= Math.abs(minY) * 0.05 || 1
      maxY += Math.abs(maxY) * 0.05 || 1
    }
    return { minX, maxX: maxX === minX ? minX + 1 : maxX, minY, maxY }
  })
  const scaleY = (value: number) => {
    const range = domain()
    if (!range) return 0
    const inner = height() - margin.top - margin.bottom
    if (props.log) {
      const lo = Math.log10(range.minY)
      const hi = Math.log10(range.maxY)
      return margin.top + inner - ((Math.log10(Math.max(value, range.minY)) - lo) / (hi - lo || 1)) * inner
    }
    return margin.top + inner - ((value - range.minY) / (range.maxY - range.minY || 1)) * inner
  }
  const scaleX = (step: number) => {
    const range = domain()
    if (!range) return 0
    const inner = width() - margin.left - margin.right
    return margin.left + ((step - range.minX) / (range.maxX - range.minX || 1)) * inner
  }
  const path = (points: Array<{ step: number; value: number }>) =>
    points
      .filter((point) => !props.log || point.value > 0)
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${scaleX(point.step).toFixed(1)} ${scaleY(point.value).toFixed(1)}`,
      )
      .join(" ")
  const yTicks = createMemo(() => {
    const range = domain()
    if (!range) return []
    if (props.log) {
      const lo = Math.floor(Math.log10(range.minY))
      const hi = Math.ceil(Math.log10(range.maxY))
      return Array.from({ length: Math.min(8, hi - lo + 1) }, (_, index) => 10 ** (lo + index))
    }
    return ticks(range.minY, range.maxY, 5)
  })
  const xTicks = createMemo(() => {
    const range = domain()
    return range ? ticks(range.minX, range.maxX, 6) : []
  })
  const cursor = createMemo(() => {
    const step = hover()
    if (step === undefined) return
    const values = shown().flatMap((series) => {
      if (!series.points.length) return []
      let best = series.points[0]!
      for (const point of series.points) {
        if (Math.abs(point.step - step) < Math.abs(best.step - step)) best = point
      }
      return [{ id: series.id, label: series.label, color: series.color, point: best }]
    })
    const nearest = values.reduce<number | undefined>(
      (acc, item) =>
        acc === undefined || Math.abs(item.point.step - step) < Math.abs(acc - step) ? item.point.step : acc,
      undefined,
    )
    return nearest === undefined ? undefined : { step: nearest, values }
  })

  const track = (event: MouseEvent) => {
    const range = domain()
    const target = event.currentTarget as SVGSVGElement
    const rect = target.getBoundingClientRect()
    if (!range) return
    const x = event.clientX - rect.left
    const inner = width() - margin.left - margin.right
    const step = range.minX + ((x - margin.left) / (inner || 1)) * (range.maxX - range.minX)
    setHover(step)
  }

  return (
    <div
      class="metric-chart"
      ref={(element) => {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0]
          if (entry) setWidth(Math.max(200, Math.floor(entry.contentRect.width)))
        })
        observer.observe(element)
      }}
    >
      <svg
        class="metric-chart__svg"
        width={width()}
        height={height()}
        viewBox={`0 0 ${width()} ${height()}`}
        role="img"
        aria-label={`${props.series.length} series`}
        onMouseMove={track}
        onMouseLeave={() => setHover(undefined)}
      >
        <Show when={domain()}>
          <g class="metric-chart__grid">
            <For each={yTicks()}>
              {(tick) => (
                <g>
                  <line x1={margin.left} x2={width() - margin.right} y1={scaleY(tick)} y2={scaleY(tick)} />
                  <text x={margin.left - 6} y={scaleY(tick) + 3} text-anchor="end">
                    {formatValue(tick)}
                  </text>
                </g>
              )}
            </For>
            <For each={xTicks()}>
              {(tick) => (
                <text x={scaleX(tick)} y={height() - 6} text-anchor="middle">
                  {Number.isInteger(tick) ? tick : tick.toFixed(1)}
                </text>
              )}
            </For>
          </g>
          <For each={shown()}>
            {(series) => (
              <path
                class="metric-chart__line"
                d={path(series.points)}
                stroke={series.color}
                data-emphasis={props.emphasize === undefined ? undefined : props.emphasize === series.id ? "on" : "off"}
                fill="none"
              />
            )}
          </For>
          <Show when={cursor()}>
            {(current) => (
              <g class="metric-chart__cursor">
                <line
                  x1={scaleX(current().step)}
                  x2={scaleX(current().step)}
                  y1={margin.top}
                  y2={height() - margin.bottom}
                />
                <For each={current().values}>
                  {(item) => (
                    <circle cx={scaleX(item.point.step)} cy={scaleY(item.point.value)} r="3" fill={item.color} />
                  )}
                </For>
              </g>
            )}
          </Show>
        </Show>
      </svg>
      <Show when={cursor()}>
        {(current) => (
          <div class="metric-chart__tooltip" role="status">
            <span class="metric-chart__tooltip-step">step {Math.round(current().step)}</span>
            <For each={current().values}>
              {(item) => (
                <span class="metric-chart__tooltip-row">
                  <i style={{ background: item.color }} />
                  <span class="metric-chart__tooltip-label">{item.label}</span>
                  <b>{formatValue(item.point.value)}</b>
                </span>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={!domain()}>
        <div class="metric-chart__empty">No points yet</div>
      </Show>
    </div>
  )
}
