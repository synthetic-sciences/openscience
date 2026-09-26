import type { Benchmark } from "@/data/benchmarks"
import { BIO_MEANS, BIO_TASKS, TB4_ALL, TBS_DOMAINS, type Harness } from "@/data/benchmark"

/* Three figures, three chart forms, one colour language: turquoise for
   OpenScience, slate for Codex, ochre for Claude Code, graphite for other
   agents. Only OpenScience is labelled in strong ink. */

const W = 300
const H = 210
const COLOUR: Record<Harness, string> = {
  os: "var(--color-accent)",
  codex: "var(--color-chart-codex)",
  cc: "var(--color-chart-cc)",
  oth: "var(--color-chart-other)",
}
const grid = "var(--color-border-weak)"
const weak = "var(--color-text-weak)"
const strong = "var(--color-text-strong)"
const tick = { fontSize: 9.5, fill: weak } as const

function Legend({ items }: { items: readonly { label: string; harness: Harness; dashed?: boolean }[] }) {
  let x = 0
  return (
    <g>
      {items.map((item) => {
        const at = x
        x += 30 + item.label.length * 5.1
        return (
          <g key={item.label}>
            <line
              x1={at}
              x2={at + 14}
              y1={8}
              y2={8}
              stroke={COLOUR[item.harness]}
              strokeWidth={item.harness === "os" ? 2 : 1.4}
              strokeDasharray={item.dashed ? "3 2" : undefined}
            />
            <text x={at + 18} y={11} {...tick}>
              {item.label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* Terminal-Bench Science: resolution rate by domain, one line per harness. */
function Domains() {
  const L = 28
  const R = W - 8
  const T = 30
  const B = H - 28
  const lo = 40
  const hi = 100
  const n = TBS_DOMAINS.domains.length
  const sx = (i: number) => L + 14 + (i / (n - 1)) * (R - L - 44)
  const sy = (v: number) => B - ((v - lo) / (hi - lo)) * (B - T)
  const path = (values: readonly number[]) => values.map((v, i) => `${i ? "L" : "M"}${sx(i)} ${sy(v)}`).join(" ")
  const ours = TBS_DOMAINS.series[0]
  return (
    <>
      <Legend
        items={[
          { label: "OpenScience", harness: "os" },
          { label: "Codex", harness: "codex" },
          { label: "Claude Code", harness: "cc", dashed: true },
        ]}
      />
      {[50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={L} x2={R} y1={sy(v)} y2={sy(v)} stroke={grid} />
          <text x={L - 6} y={sy(v) + 3} textAnchor="end" {...tick}>
            {v}
          </text>
        </g>
      ))}
      {TBS_DOMAINS.domains.map((d, i) => (
        <text key={d} x={sx(i)} y={B + 16} textAnchor="middle" {...tick}>
          {d}
        </text>
      ))}
      <path d={`${path(ours.values)} L${sx(n - 1)} ${B} L${sx(0)} ${B} Z`} fill="var(--color-accent-soft)" />
      {TBS_DOMAINS.series
        .slice()
        .reverse()
        .map((s) => (
          <g key={s.name}>
            <path
              d={path(s.values)}
              fill="none"
              stroke={COLOUR[s.harness]}
              strokeWidth={s.harness === "os" ? 2 : 1.3}
              strokeDasharray={s.harness === "cc" ? "4 3" : undefined}
              strokeLinejoin="round"
            />
            {s.values.map((v, i) => (
              <circle
                key={i}
                cx={sx(i)}
                cy={sy(v)}
                r={s.harness === "os" ? 3 : 2.2}
                fill={s.harness === "os" ? COLOUR.os : "var(--color-background)"}
                stroke={COLOUR[s.harness]}
                strokeWidth={1.3}
              />
            ))}
          </g>
        ))}
      {ours.values.map((v, i) => (
        <text key={i} x={sx(i)} y={sy(v) - 7} textAnchor="middle" fontSize="9.5" fill={strong}>
          {v}
        </text>
      ))}
    </>
  )
}

/* Terminal-Bench 4.0 (science): every public entry ranked as one curve;
   OpenScience's score is the line above all of them. */
function Ranked() {
  const L = 28
  const R = W - 8
  const T = 30
  const B = H - 28
  const hi = 80
  const n = TB4_ALL.length
  const sx = (i: number) => L + 6 + (i / (n - 1)) * (R - L - 12)
  const sy = (v: number) => B - (v / hi) * (B - T)
  const curve = TB4_ALL.map((e, i) => `${i ? "L" : "M"}${sx(i)} ${sy(e.v)}`).join(" ")
  const ours = 71.4
  return (
    <>
      <Legend
        items={[
          { label: "Claude Code", harness: "cc" },
          { label: "Codex", harness: "codex" },
          { label: "other agents", harness: "oth" },
        ]}
      />
      {[20, 40, 60, 80].map((v) => (
        <g key={v}>
          <line x1={L} x2={R} y1={sy(v)} y2={sy(v)} stroke={grid} />
          <text x={L - 6} y={sy(v) + 3} textAnchor="end" {...tick}>
            {v}
          </text>
        </g>
      ))}
      <path d={`${curve} L${sx(n - 1)} ${B} L${sx(0)} ${B} Z`} fill="var(--color-chart-other)" opacity="0.12" />
      <path d={curve} fill="none" stroke="var(--color-chart-other)" strokeWidth="1" opacity="0.7" />
      {TB4_ALL.map((e, i) => (
        <circle key={i} cx={sx(i)} cy={sy(e.v)} r="2.3" fill={COLOUR[e.h]} />
      ))}
      <line x1={L} x2={R} y1={sy(ours)} y2={sy(ours)} stroke={COLOUR.os} strokeWidth="1.6" />
      <line
        x1={sx(0)}
        x2={sx(0)}
        y1={sy(ours)}
        y2={sy(TB4_ALL[0].v)}
        stroke={COLOUR.os}
        strokeWidth="1"
        strokeDasharray="2 2"
      />
      <text x={R} y={sy(ours) - 6} textAnchor="end" fontSize="10" fill={strong}>
        OpenScience {ours}
      </text>
      <text x={sx(0) + 6} y={sy(TB4_ALL[0].v) - 4} {...tick}>
        best public entry {TB4_ALL[0].v}
      </text>
      <text x={(L + R) / 2} y={B + 16} textAnchor="middle" {...tick}>
        {n} public entries, ranked
      </text>
    </>
  )
}

/* BiomniBench-DA: OpenScience's 50 task scores as stacked dots, then each
   published mean on its own row of the same scale. */
function Distribution() {
  const L = 10
  const R = W - 10
  const lo = 20
  const hi = 100
  const axis = 118
  const dot = 4.4
  const sx = (v: number) => L + ((v - lo) / (hi - lo)) * (R - L)
  const bins = new Map<number, number>()
  const dots = BIO_TASKS.map((v) => {
    const bin = Math.min(hi, Math.round(v / 4) * 4)
    const k = bins.get(bin) ?? 0
    bins.set(bin, k + 1)
    return { x: sx(bin), y: axis - 6 - k * dot }
  })
  const ours = BIO_MEANS[0]
  const rows = 146
  const step = 14
  return (
    <>
      <text x={L} y={11} {...tick}>
        50 tasks, one dot each
      </text>
      {[20, 40, 60, 80, 100].map((v) => (
        <g key={v}>
          <line x1={sx(v)} x2={sx(v)} y1={axis} y2={rows + step * (BIO_MEANS.length - 1) + 4} stroke={grid} />
          <text x={sx(v)} y={axis + 13} textAnchor="middle" {...tick}>
            {v}
          </text>
        </g>
      ))}
      <line x1={L} x2={R} y1={axis} y2={axis} stroke="var(--color-border)" />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="1.8" fill={COLOUR.os} opacity="0.85" />
      ))}
      <line
        x1={sx(ours.value)}
        x2={sx(ours.value)}
        y1={axis - 6 - 19 * dot}
        y2={rows}
        stroke={COLOUR.os}
        strokeDasharray="2 2"
      />
      {BIO_MEANS.map((m, i) => {
        const y = rows + i * step
        const x = sx(m.value)
        const mine = m.harness === "os"
        return (
          <g key={m.name}>
            <line
              x1={sx(lo)}
              x2={x}
              y1={y}
              y2={y}
              stroke={COLOUR[m.harness]}
              strokeWidth={mine ? 1.6 : 1}
              opacity={mine ? 1 : 0.7}
            />
            <circle cx={x} cy={y} r={mine ? 3.2 : 2.5} fill={COLOUR[m.harness]} />
            <text
              x={x - 6}
              y={y - 3.5}
              textAnchor="end"
              fontSize="9.5"
              fill={mine ? strong : weak}
              stroke="var(--color-background)"
              strokeWidth="3"
              paintOrder="stroke"
            >
              {m.name} {m.value}
            </text>
          </g>
        )
      })}
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
          aria-label={`${benchmark.name}: OpenScience ${benchmark.score}${benchmark.unit}, ${benchmark.lead}`}
        >
          {benchmark.chart === "domains" ? <Domains /> : null}
          {benchmark.chart === "ranked" ? <Ranked /> : null}
          {benchmark.chart === "distribution" ? <Distribution /> : null}
        </svg>
      </div>
      <div data-slot="figure-stat">
        <strong>
          {benchmark.score}
          {benchmark.unit ? <small>{benchmark.unit}</small> : null}
        </strong>
        <span>{benchmark.lead}</span>
      </div>
      <span>
        <span data-slot="fig">Fig {index}.</span>
        <a href={benchmark.href} target="_blank" rel="noreferrer">
          {benchmark.name}
        </a>
      </span>
    </div>
  )
}
