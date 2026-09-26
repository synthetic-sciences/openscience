import type { Benchmark } from "@/data/benchmarks"
import type { Harness } from "@/data/benchmark"

/* Three boards in the launch post's chart language: one row per harness and
   model, ranked, a light grid, and the harness colours kept everywhere:
   turquoise for OpenScience, slate for Codex, ochre for Claude Code, grey for
   other agents. Only OpenScience's row is set in strong ink. */

const W = 300
const ROW = 30
const TOP = 8
const LABEL = 118
const RIGHT = 34
const tick = { fontSize: 10, fill: "var(--color-text-weak)" } as const

const COLOUR: Record<Harness, string> = {
  os: "var(--color-accent)",
  codex: "var(--color-chart-codex)",
  cc: "var(--color-chart-cc)",
  oth: "var(--color-chart-other)",
}

export function BenchmarkFigure({ benchmark, index }: { benchmark: Benchmark; index: number }) {
  const { chart } = benchmark
  const rows = [...chart.rows].sort((a, b) => b.value - a.value)
  const height = TOP + rows.length * ROW + 18
  const x0 = LABEL
  const x1 = W - RIGHT
  const scale = (value: number) => x0 + ((x1 - x0) * value) / chart.max
  return (
    <div data-component="benchmark">
      <div data-component="stat-illustration">
        <svg
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          aria-label={`${benchmark.name}: OpenScience ${benchmark.score}${benchmark.unit}`}
        >
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line
                x1={scale(t * chart.max)}
                x2={scale(t * chart.max)}
                y1={TOP}
                y2={TOP + rows.length * ROW}
                stroke="var(--color-border-weak)"
              />
              <text x={scale(t * chart.max)} y={height - 3} textAnchor="middle" {...tick}>
                {Math.round(t * chart.max)}
                {chart.unit}
              </text>
            </g>
          ))}
          {rows.map((row, i) => {
            const y = TOP + i * ROW
            const mine = row.harness === "os"
            return (
              <g key={`${row.name}-${row.model}`}>
                <text
                  x={x0 - 8}
                  y={y + 12}
                  textAnchor="end"
                  fontSize="10.5"
                  fill={mine ? "var(--color-text-strong)" : "var(--color-text)"}
                >
                  {row.name}
                </text>
                <text x={x0 - 8} y={y + 23} textAnchor="end" fontSize="9" fill="var(--color-text-weak)">
                  {row.model}
                </text>
                <rect
                  x={x0}
                  y={y + 8}
                  width={Math.max(0, scale(row.value) - x0)}
                  height={12}
                  fill={COLOUR[row.harness]}
                />
                <text
                  x={scale(row.value) + 5}
                  y={y + 18}
                  fontSize="10.5"
                  fill={mine ? "var(--color-text-strong)" : "var(--color-text-weak)"}
                >
                  {row.value}
                  {chart.unit}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <span>
        <span data-slot="fig">Fig {index}.</span>
        {benchmark.href ? (
          <a href={benchmark.href} target="_blank" rel="noreferrer">
            {benchmark.name}
          </a>
        ) : (
          benchmark.name
        )}
        <small>{benchmark.note}</small>
      </span>
    </div>
  )
}
