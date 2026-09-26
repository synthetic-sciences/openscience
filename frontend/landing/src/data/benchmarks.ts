/* Benchmark figures shown on the landing page.

   Every number here comes from `src/data/benchmark.ts`, the snapshot of the
   launch post's data, so the front page and /benchmark cannot disagree. */

import { BIO_BOARD, NUMBERS, TB4_BOARD, TBS_BOARD, type BoardRow } from "./benchmark"

/** The lead model the headline scores were run with. */
export const BENCHMARK_MODEL = "GPT-6 Astra"

export type Chart = {
  /** Ranked comparison: one bar per harness and model, OpenScience first. */
  kind: "board"
  rows: readonly BoardRow[]
  /** The scale's right edge. */
  max: number
  /** Appended to the value label. */
  unit: "%" | ""
}

export type Benchmark = {
  id: string
  name: string
  /** OpenScience's score, in the benchmark's own metric. */
  score: number
  unit: "%" | ""
  /** The one line under the figure. */
  note: string
  /** The benchmark's own page. Omitted for internal benchmarks. */
  href?: string
  chart: Chart
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: "terminal-bench-science",
    name: "Terminal-Bench Science",
    score: NUMBERS.tbs_pct,
    unit: "%",
    note: `${NUMBERS.tbs_n} tasks; all ${NUMBERS.lb_n} public entries shown on /benchmark`,
    href: "https://www.terminal-bench-science.ai/",
    chart: { kind: "board", rows: TBS_BOARD.slice(0, 6), max: 100, unit: "%" },
  },
  {
    id: "terminal-bench-4-science",
    name: "Terminal-Bench 4.0, science tasks",
    score: NUMBERS.tb4_pct,
    unit: "%",
    note: `${NUMBERS.tb4_n} tasks; ${NUMBERS.lb4_n} public entries re-scored on them`,
    href: "https://www.tbench.ai/leaderboard",
    chart: { kind: "board", rows: TB4_BOARD.slice(0, 6), max: 100, unit: "%" },
  },
  {
    id: "biomnibench-da",
    name: "BiomniBench-DA",
    score: NUMBERS.bio_mean,
    unit: "",
    note: `${NUMBERS.bio_n} tasks, Gemini 3.1 Pro judge`,
    href: "https://github.com/omicverse/BiomniBench-AI4S",
    chart: { kind: "board", rows: BIO_BOARD.slice(0, 6), max: 100, unit: "" },
  },
]

/** Benchmarks whose results are still coming in. */
export const FORTHCOMING = ["OpenScience Bench", "ResearchClawBench", "BixBench 3"] as const
