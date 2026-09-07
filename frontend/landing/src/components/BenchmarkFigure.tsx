import type { Benchmark, Chart } from "@/data/benchmarks"

/* Three figures in one chart language, after the terminal-bench-science.ai
   Pareto view: a light grid, quiet ticks, ochre square markers for other
   agents, and turquoise for OpenScience, the only thing labelled. */

const W = 300
const H = 240
const L = 44
const R = W - 14
const T = 30
const B = H - 40
const ink = "var(--color-text-strong)"
const accent = "var(--color-accent)"
const other = "var(--color-chart-other)"
const soft = "var(--color-accent-soft)"
const grid = "var(--color-border-weak)"
const tick = { fontSize: 11, fill: "var(--color-text-weak)" } as const

function Frame({
  xs,
  ys,
  xLabel,
  yLabel,
}: {
  xs: [number, string][]
  ys: [number, string][]
  xLabel: string
  yLabel: string
}) {
  return (
    <>
      {ys.map(([y, label]) => (
        <g key={label}>
          <line x1={L} y1={y} x2={R} y2={y} stroke={grid} />
          <text x={L - 8} y={y + 4} textAnchor="end" {...tick}>
            {label}
          </text>
        </g>
      ))}
      {xs.map(([x, label]) => (
        <g key={label}>
          <line x1={x} y1={T} x2={x} y2={B} stroke={grid} />
          <text x={x} y={B + 17} textAnchor="middle" {...tick}>
            {label}
          </text>
        </g>
      ))}
      <line x1={L} y1={B + 0.5} x2={R} y2={B + 0.5} stroke="var(--color-text)" />
      <line x1={L + 0.5} y1={T} x2={L + 0.5} y2={B} stroke="var(--color-text)" />
      {xLabel ? (
        <text x={(L + R) / 2} y={H - 6} textAnchor="middle" {...tick}>
          {xLabel}
        </text>
      ) : null}
      <text x={L} y={T - 12} {...tick}>
        {yLabel}
      </text>
    </>
  )
}

function Square({ x, y, mine }: { x: number; y: number; mine?: boolean }) {
  const s = mine ? 10 : 6
  return <rect x={x - s / 2} y={y - s / 2} width={s} height={s} fill={mine ? accent : other} opacity={mine ? 1 : 0.8} />
}

/* Resolution rate against total cost. Ochre squares are the public agents and
   the dashed line is their Pareto front; OpenScience is the turquoise square,
   sitting beyond it. */
function Pareto({ points }: Extract<Chart, { kind: "pareto" }>) {
  const maxCost = 20
  const maxScore = 45
  const sx = (cost: number) => L + (cost / maxCost) * (R - L)
  const sy = (score: number) => B - (score / maxScore) * (B - T)
  const others = points.filter((p) => p.name !== "OpenScience")
  const front = [...others]
    .sort((a, b) => a.cost - b.cost)
    .filter(
      (p) =>
        !others.some(
          (q) => q !== p && q.cost <= p.cost && q.score >= p.score && (q.cost < p.cost || q.score > p.score),
        ),
    )
  const path = front.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.cost)} ${sy(p.score)}`).join(" ")
  const ours = points.find((p) => p.name === "OpenScience")
  return (
    <>
      <Frame
        xs={[5, 10, 15].map((c) => [sx(c), `$${c}k`])}
        ys={[10, 20, 30, 40].map((v) => [sy(v), `${v}%`])}
        xLabel="total cost"
        yLabel="resolution rate"
      />
      <path d={path} fill="none" stroke={other} strokeWidth="1" strokeDasharray="3 3" opacity="0.9" />
      {others.map((p) => (
        <Square key={p.name} x={sx(p.cost)} y={sy(p.score)} />
      ))}
      {ours ? (
        <>
          <circle cx={sx(ours.cost)} cy={sy(ours.score)} r="11" fill={soft} />
          <Square x={sx(ours.cost)} y={sy(ours.score)} mine />
          <text x={sx(ours.cost) + 12} y={sy(ours.score) + 4} fontSize="12" fill={ink}>
            OpenScience
          </text>
        </>
      ) : null}
    </>
  )
}

function Frontier({ series }: Extract<Chart, { kind: "frontier" }>) {
  const sx = (i: number) => L + 22 + (i / (series.length - 1)) * (R - L - 44)
  const sy = (v: number) => B - (v / 60) * (B - T)
  const line = (key: "ours" | "baseline") =>
    series.map((s, i) => `${i === 0 ? "M" : "L"}${sx(i)} ${sy(s[key])}`).join(" ")
  const last = series[series.length - 1]
  return (
    <>
      <Frame
        xs={series.map((s, i) => [sx(i), s.model])}
        ys={[15, 30, 45].map((v) => [sy(v), `${v}%`])}
        xLabel=""
        yLabel="solved"
      />
      <path d={`${line("ours")} L${sx(series.length - 1)} ${B} L${sx(0)} ${B} Z`} fill={soft} stroke="none" />
      <path d={line("baseline")} fill="none" stroke={other} strokeWidth="1" strokeDasharray="3 3" opacity="0.9" />
      <path d={line("ours")} fill="none" stroke={accent} strokeWidth="1.25" />
      {series.map((s, i) => (
        <g key={s.model}>
          <Square x={sx(i)} y={sy(s.baseline)} />
          <Square x={sx(i)} y={sy(s.ours)} mine />
        </g>
      ))}
      <text x={sx(series.length - 1) - 12} y={sy(last.ours) - 11} textAnchor="end" fontSize="12" fill={ink}>
        OpenScience
      </text>
    </>
  )
}

function Comparison({ rows }: Extract<Chart, { kind: "comparison" }>) {
  const sorted = [...rows].sort((a, b) => b.score - a.score)
  const slot = (R - L) / sorted.length
  const bar = slot * 0.46
  const sy = (v: number) => B - (v / 70) * (B - T)
  return (
    <>
      <Frame xs={[]} ys={[20, 40, 60].map((v) => [sy(v), `${v}%`])} xLabel="" yLabel="solved" />
      {sorted.map((row, i) => {
        const mine = row.name === "OpenScience"
        const x = L + slot * i + (slot - bar) / 2
        return (
          <g key={row.name}>
            <rect
              x={x}
              y={sy(row.score)}
              width={bar}
              height={B - sy(row.score)}
              fill={mine ? accent : other}
              opacity={mine ? 1 : 0.55}
            />
            <text
              x={x + bar / 2}
              y={B + 17}
              textAnchor="middle"
              fontSize="11"
              fill={mine ? ink : "var(--color-text-weak)"}
            >
              {row.name.split(" ").map((word, w) => (
                <tspan key={word} x={x + bar / 2} dy={w === 0 ? 0 : 13}>
                  {word}
                </tspan>
              ))}
            </text>
          </g>
        )
      })}
    </>
  )
}

export function BenchmarkFigure({ benchmark, index }: { benchmark: Benchmark; index: number }) {
  const { chart } = benchmark
  return (
    <div data-component="benchmark">
      <div data-component="stat-illustration">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${benchmark.name}: OpenScience ${benchmark.score}%`}>
          {chart.kind === "pareto" ? <Pareto {...chart} /> : null}
          {chart.kind === "frontier" ? <Frontier {...chart} /> : null}
          {chart.kind === "comparison" ? <Comparison {...chart} /> : null}
        </svg>
      </div>
      <span>
        <span data-slot="fig">Fig {index}.</span>
        {benchmark.name}
      </span>
    </div>
  )
}
