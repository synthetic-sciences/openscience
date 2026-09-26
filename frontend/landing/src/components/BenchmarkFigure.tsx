import type { Benchmark } from "@/data/benchmarks"
import { BIO_TASKS, NUMBERS, TB4_BEST, TBS_DOMAINS } from "@/data/benchmark"

/* Three figures in one chart language, after the terminal-bench-science.ai
   view: a light grid, quiet ticks, ochre square markers for other agents,
   and turquoise for OpenScience, the only thing labelled. */

const W = 300
const H = 240
const L = 44
const R = W - 14
const T = 30
const B = H - 40
const ink = "var(--color-text-strong)"
const accent = "var(--color-accent)"
const other = "var(--color-chart-cc)"
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

/* Terminal-Bench Science by domain: OpenScience against the strongest
   public entry (Codex, same lead model), dashed. */
function Domains() {
  const [ours, best] = TBS_DOMAINS.series
  const n = TBS_DOMAINS.domains.length
  const sx = (i: number) => L + 18 + (i / (n - 1)) * (R - L - 36)
  const sy = (v: number) => B - ((v - 40) / 60) * (B - T)
  const line = (values: readonly number[]) => values.map((v, i) => `${i ? "L" : "M"}${sx(i)} ${sy(v)}`).join(" ")
  const top = ours.values.reduce((a, v, i) => (v > ours.values[a] ? i : a), 0)
  return (
    <>
      <Frame
        xs={TBS_DOMAINS.domains.map((d, i) => [sx(i), d === "Engineering" ? "Eng." : d])}
        ys={[50, 70, 90].map((v) => [sy(v), `${v}%`])}
        xLabel=""
        yLabel="solved, by domain"
      />
      <path d={`${line(ours.values)} L${sx(n - 1)} ${B} L${sx(0)} ${B} Z`} fill={soft} stroke="none" />
      <path d={line(best.values)} fill="none" stroke={other} strokeWidth="1" strokeDasharray="3 3" opacity="0.9" />
      <path d={line(ours.values)} fill="none" stroke={accent} strokeWidth="1.25" />
      {ours.values.map((v, i) => (
        <g key={i}>
          <Square x={sx(i)} y={sy(best.values[i])} />
          <Square x={sx(i)} y={sy(v)} mine />
        </g>
      ))}
      <text x={sx(top)} y={sy(ours.values[top]) - 12} textAnchor="middle" fontSize="12" fill={ink}>
        OpenScience
      </text>
    </>
  )
}

/* Terminal-Bench 4.0 (science): the best public entry of each harness. */
function Comparison() {
  const rows = TB4_BEST
  const slot = (R - L) / rows.length
  const bar = slot * 0.46
  const sy = (v: number) => B - (v / 80) * (B - T)
  return (
    <>
      <Frame xs={[]} ys={[20, 40, 60].map((v) => [sy(v), `${v}%`])} xLabel="" yLabel="solved, best entry" />
      {rows.map((row, i) => {
        const mine = row.harness === "os"
        const x = L + slot * i + (slot - bar) / 2
        return (
          <g key={row.name}>
            <rect
              x={x}
              y={sy(row.value)}
              width={bar}
              height={B - sy(row.value)}
              fill={mine ? accent : other}
              opacity={mine ? 1 : 0.55}
            />
            <text
              x={x + bar / 2}
              y={sy(row.value) - 6}
              textAnchor="middle"
              fontSize="10"
              fill={mine ? ink : "var(--color-text-weak)"}
            >
              {row.value}%
            </text>
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

/* BiomniBench-DA: one dot per task, highest first; OpenScience's mean is
   the solid line and AIPOCH's the dashed one. */
function Dots() {
  const scores = [...BIO_TASKS].sort((a, b) => b - a)
  const n = scores.length
  const sx = (i: number) => L + 8 + (i / (n - 1)) * (R - L - 16)
  const sy = (v: number) => B - (v / 100) * (B - T)
  const ours = NUMBERS.bio_mean
  const theirs = NUMBERS.bio_other
  return (
    <>
      <Frame
        xs={[0, 24, 49].map((i) => [sx(i), `${i + 1}`])}
        ys={[25, 50, 75, 100].map((v) => [sy(v), String(v)])}
        xLabel="50 tasks, by score"
        yLabel="score"
      />
      <line x1={L} x2={R} y1={sy(theirs)} y2={sy(theirs)} stroke={other} strokeDasharray="3 3" opacity="0.9" />
      <line x1={L} x2={R} y1={sy(ours)} y2={sy(ours)} stroke={accent} strokeWidth="1.25" />
      {scores.map((v, i) => (
        <circle key={i} cx={sx(i)} cy={sy(v)} r="2.4" fill={accent} opacity={0.9} />
      ))}
      <text x={L + 8} y={sy(ours) - 7} fontSize="12" fill={ink}>
        OpenScience {ours}
      </text>
      <text x={L + 8} y={sy(theirs) + 14} {...tick}>
        AIPOCH {theirs}
      </text>
    </>
  )
}

export function BenchmarkFigure({ benchmark, index }: { benchmark: Benchmark; index: number }) {
  return (
    <div data-component="benchmark">
      <div data-component="stat-illustration">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${benchmark.name}: OpenScience ${benchmark.score}${benchmark.unit}`}
        >
          {benchmark.chart === "domains" ? <Domains /> : null}
          {benchmark.chart === "ranked" ? <Comparison /> : null}
          {benchmark.chart === "distribution" ? <Dots /> : null}
        </svg>
      </div>
      <span>
        <span data-slot="fig">Fig {index}.</span>
        <strong>
          {benchmark.score}
          {benchmark.unit}
        </strong>
        <a href={benchmark.href} target="_blank" rel="noreferrer">
          {benchmark.name}
        </a>
      </span>
    </div>
  )
}
