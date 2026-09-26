/* Benchmark figures shown on the landing page.

   Every number here comes from `src/data/benchmark.ts`, the snapshot of the
   launch post's data, so the front page and /benchmark cannot disagree. */

import { NUMBERS } from "./benchmark"

export type Benchmark = {
  id: string
  name: string
  /** OpenScience's score, in the benchmark's own metric. */
  score: number
  unit: "%" | ""
  /** The margin over the strongest other entry, and who that is. */
  lead: string
  /** The benchmark's own page. */
  href: string
  chart: "domains" | "ranked" | "distribution"
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: "terminal-bench-science",
    name: "Terminal-Bench Science",
    score: NUMBERS.tbs_pct,
    unit: "%",
    lead: `+${NUMBERS.tbs_margin} over Codex`,
    href: "https://www.terminal-bench-science.ai/",
    chart: "domains",
  },
  {
    id: "terminal-bench-4-science",
    name: "Terminal-Bench 4.0 (science)",
    score: NUMBERS.tb4_pct,
    unit: "%",
    lead: `+${NUMBERS.tb4_margin} over Claude Code`,
    href: "https://www.tbench.ai/leaderboard",
    chart: "ranked",
  },
  {
    id: "biomnibench-da",
    name: "BiomniBench-DA",
    score: NUMBERS.bio_mean,
    unit: "",
    lead: `+${NUMBERS.bio_margin} over ${NUMBERS.bio_other_short}`,
    href: "https://github.com/omicverse/BiomniBench-AI4S",
    chart: "distribution",
  },
]
