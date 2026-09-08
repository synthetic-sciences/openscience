/* Benchmark figures shown on the landing page.

   PLACEHOLDER VALUES. Replace every number here with the published results
   before launch, then flip `PRELIMINARY` to false so the paragraph stops
   saying "preliminary". Every number rendered on the page comes from this
   file. */

export const PRELIMINARY = true

/** The model the headline scores were run with. */
export const BENCHMARK_MODEL = "Claude Opus 5"

export type Chart =
  /** Score against cost per task; OpenScience should sit on the Pareto front. */
  | { kind: "pareto"; points: readonly { name: string; cost: number; score: number }[] }
  /** Score per model with the OpenScience harness and with the baseline harness. */
  | { kind: "frontier"; series: readonly { model: string; ours: number; baseline: number }[] }
  /** Ranked comparison against named agents. */
  | { kind: "comparison"; rows: readonly { name: string; score: number }[] }

export type Benchmark = {
  id: string
  name: string
  /** What the figure shows, for the caption. */
  figure: string
  /** OpenScience score, in percent. */
  score: number
  /** The benchmark's own page. Omitted for internal benchmarks. */
  href?: string
  chart: Chart
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: "terminal-bench-science",
    name: "Terminal-Bench Science",
    figure: "Pareto frontier",
    /* Resolution rate, in percent; cost is total cost in thousands of dollars,
       laid out roughly like the public leaderboard's Pareto view. */
    score: 38.0,
    href: "https://terminal-bench-science.ai/",
    chart: {
      kind: "pareto",
      points: [
        { name: "OpenScience", cost: 2.8, score: 38.0 },
        { name: "DeepSeek V4 Pro · Codex", cost: 0.4, score: 4.0 },
        { name: "GPT-5.6 Luna · Codex", cost: 0.6, score: 4.6 },
        { name: "Gemini 3.8 Flash · mini-SWE-agent", cost: 1.1, score: 12.2 },
        { name: "GPT-5.6 Sol · Codex", cost: 4.2, score: 22.0 },
        { name: "Opus 5 · Claude Code", cost: 7.0, score: 30.0 },
        { name: "Agent A", cost: 1.3, score: 6.0 },
        { name: "Agent B", cost: 1.5, score: 8.2 },
        { name: "Agent C", cost: 1.9, score: 9.0 },
        { name: "Agent D", cost: 2.6, score: 7.1 },
        { name: "Agent E", cost: 3.3, score: 7.0 },
        { name: "Agent F", cost: 5.8, score: 10.5 },
        { name: "Agent G", cost: 14.0, score: 21.4 },
      ],
    },
  },
  {
    id: "terminal-bench-4-science",
    name: "Terminal-Bench 4.0 (science)",
    figure: "Performance frontier on the science tasks in Terminal-Bench 4.0",
    score: 44.7,
    href: "https://www.tbench.ai/",
    chart: {
      kind: "frontier",
      series: [
        { model: "Haiku 4.5", ours: 21.3, baseline: 14.8 },
        { model: "Sonnet 5", ours: 31.9, baseline: 24.1 },
        { model: "GPT-5.6", ours: 39.4, baseline: 31.7 },
        { model: "Opus 5", ours: 44.7, baseline: 36.2 },
      ],
    },
  },
  {
    id: "openscience-bench",
    name: "OpenScience Bench (internal)",
    figure: "Internal; against Claude Science, K-Dense (BYOK), and Codex",
    score: 58.3,
    chart: {
      kind: "comparison",
      rows: [
        { name: "OpenScience", score: 58.3 },
        { name: "Claude Science", score: 52.1 },
        { name: "K-Dense (BYOK)", score: 47.6 },
        { name: "Codex", score: 44.9 },
      ],
    },
  },
]
