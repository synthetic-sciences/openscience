/* Every number on /benchmark and in the landing's benchmark figures.

   The values are the `export/numbers.json` and `data/*.json` of the launch
   post's generator (scripts/build.py in openscience-launch), snapshotted at
   OpenScience `132dfdf` and benchmarks-openscience `61328d9` on 2026-09-26.
   Refresh them from that generator; do not retype them here. */

export const SNAPSHOT = {
  date: "2026-09-26",
  openscience: "132dfdf",
  benchmarks: "61328d9",
} as const

/** Which harness a row belongs to; the colour mapping is fixed everywhere. */
export type Harness = "os" | "codex" | "cc" | "oth"

export const NUMBERS = {
  skills_total: 371,
  skills_ncat: 18,
  connectors_total: 42,
  connectors_ndom: 6,
  tbs_solved: 53,
  tbs_n: 70,
  tbs_pct: 75.7,
  bio_mean: 82.2,
  bio_perfect: 20,
  bio_n: 50,
  tb4_solved: 10,
  tb4_n: 14,
  tb4_pct: 71.4,
  codex_tbs: 68.1,
  cc_tbs: 63.3,
  cc_tbs_model: "Opus 5.5",
  tbs_margin: 7.6,
  bio_margin: 1.2,
  bio_other_short: "AIPOCH",
  tb4_margin: 11.4,
  lb_n: 17,
  lb4_n: 27,
  only_os_n: 2,
  only_os: ["cmb-cross-inference", "variable-star-vetting"],
  n_attempts: 51,
  life_os: 73.7,
  life_codex: 59.6,
  eng_os: 55.6,
  eng_codex: 70.4,
  tb4_other: 60.0,
  tb4_other_name: "Claude Code with Fable 5.1 (high)",
  tb4_codex: 45.7,
  bio_other: 81.04,
  bio_other_name: "AIPOCH Open Science",
  bio_third: 76.6,
  bio_third_name: "OmicOS",
  bio_os2: 62.2,
  raster_task: "hysteretic-aquifer-control",
  raster_hours: 3.1,
  raster_workers: ["ml", "data", "physics"],
  t_split: 24.5,
} as const

/** A ranked row on one of the landing's board figures. */
export type BoardRow = { name: string; model: string; value: number; harness: Harness }

/** The public Terminal-Bench Science leaderboard (17 entries) with our row. */
export const TBS_BOARD: readonly BoardRow[] = [
  { name: "OpenScience", model: "GPT-6 Astra", value: 75.7, harness: "os" },
  { name: "Codex", model: "GPT-6 Astra", value: 68.1, harness: "codex" },
  { name: "Claude Code", model: "Opus 5.5", value: 63.3, harness: "cc" },
  { name: "Claude Code", model: "Fable 5.1", value: 40.0, harness: "cc" },
  { name: "Claude Code", model: "Opus 5", value: 30.0, harness: "cc" },
  { name: "Codex", model: "GPT-5.6 Sol", value: 22.4, harness: "codex" },
  { name: "Claude Code", model: "Fable 5", value: 21.4, harness: "cc" },
  { name: "Codex", model: "DeepSeek V4.1 Flash", value: 15.7, harness: "codex" },
  { name: "Grok Build", model: "Grok 4.7", value: 14.3, harness: "oth" },
  { name: "mini-SWE-agent", model: "Gemini 3.8 Flash", value: 12.4, harness: "oth" },
]

/** Every public Terminal-Bench 4.0 entry re-scored on the 14 science tasks; the top rows. */
export const TB4_BOARD: readonly BoardRow[] = [
  { name: "OpenScience", model: "GPT-6 Astra", value: 71.4, harness: "os" },
  { name: "Claude Code", model: "Fable 5.1 (high)", value: 60.0, harness: "cc" },
  { name: "Claude Code", model: "Fable 5.1 (max)", value: 52.9, harness: "cc" },
  { name: "Claude Code", model: "Opus 5 (xhigh)", value: 50.0, harness: "cc" },
  { name: "Codex", model: "GPT-6 Astra (high)", value: 45.7, harness: "codex" },
  { name: "Claude Code", model: "GLM-5.3", value: 44.3, harness: "cc" },
  { name: "Codex", model: "GPT-6 Astra (max)", value: 42.9, harness: "codex" },
]

/** BiomniBench-DA, Gemini 3.1 Pro judge, the same 50 tasks. */
export const BIO_BOARD: readonly BoardRow[] = [
  { name: "OpenScience", model: "GPT-6 Sol", value: 82.2, harness: "os" },
  { name: "AIPOCH Open Science", model: "GPT-5.6 Sol", value: 81.04, harness: "oth" },
  { name: "OmicOS", model: "DeepSeek V4 Pro", value: 76.6, harness: "oth" },
  { name: "Claude Code", model: "DeepSeek V4 Pro", value: 68.6, harness: "cc" },
  { name: "EvoScientist", model: "DeepSeek V4 Pro", value: 65.3, harness: "oth" },
  { name: "Biomni", model: "DeepSeek V4 Pro", value: 62.6, harness: "oth" },
]

/** Figure 8: three benchmarks whose results are still coming in. Add rows
 * when they are final; an empty list draws the frame with a note. */
export type PendingBenchmark = {
  id: string
  title: string
  metric: string
  max: number
  about: string
  rows: readonly BoardRow[]
}

export const PENDING: readonly PendingBenchmark[] = [
  {
    id: "openscience-bench",
    title: "OpenScience Bench",
    metric: "score (%)",
    max: 100,
    about: "Our internal benchmark.",
    rows: [],
  },
  {
    id: "researchclawbench",
    title: "ResearchClawBench",
    metric: "rubric score",
    max: 100,
    about: "40 tasks in 10 domains, each built on a published paper that is hidden during evaluation.",
    rows: [],
  },
  {
    id: "bixbench-3",
    title: "BixBench 3",
    metric: "score (%)",
    max: 100,
    about: "v1.0.0, 20 tasks, native Inspect AI environment with host-side artifact grading.",
    rows: [],
  },
]

export const TRACES = "https://github.com/synthetic-sciences/benchmarks-openscience"

/** Terminal-Bench Science resolution rate by domain: ours against the
 * strongest Codex and Claude Code entries. */
export const TBS_DOMAINS = {
  domains: ["Life", "Physical", "Earth", "Math", "Engineering"],
  series: [
    { name: "OpenScience", harness: "os", values: [73.7, 76.5, 87.5, 82.4, 55.6] },
    { name: "Codex · GPT-6 Astra", harness: "codex", values: [59.6, 58.8, 79.2, 80.4, 70.4] },
    { name: "Claude Code · Opus 5.5", harness: "cc", values: [54.4, 60.8, 62.5, 76.5, 63.0] },
  ],
} as const satisfies {
  domains: readonly string[]
  series: readonly { name: string; harness: Harness; values: readonly number[] }[]
}

/** Every public Terminal-Bench 4.0 entry on the 14 science tasks, ranked. */
export const TB4_ALL: readonly { v: number; h: Harness }[] = [
  { v: 60.0, h: "cc" },
  { v: 52.9, h: "cc" },
  { v: 52.9, h: "cc" },
  { v: 50.0, h: "cc" },
  { v: 50.0, h: "cc" },
  { v: 47.1, h: "cc" },
  { v: 45.7, h: "codex" },
  { v: 44.3, h: "codex" },
  { v: 44.3, h: "cc" },
  { v: 42.9, h: "codex" },
  { v: 42.9, h: "cc" },
  { v: 42.9, h: "cc" },
  { v: 40.0, h: "codex" },
  { v: 38.6, h: "cc" },
  { v: 38.6, h: "cc" },
  { v: 38.6, h: "codex" },
  { v: 34.3, h: "codex" },
  { v: 34.3, h: "cc" },
  { v: 31.4, h: "cc" },
  { v: 30.0, h: "oth" },
  { v: 21.4, h: "codex" },
  { v: 20.0, h: "codex" },
  { v: 20.0, h: "oth" },
  { v: 15.7, h: "oth" },
  { v: 14.3, h: "oth" },
  { v: 11.4, h: "cc" },
  { v: 10.0, h: "oth" },
]

/** OpenScience's rubric score on each of the 50 BiomniBench-DA tasks. */
export const BIO_TASKS: readonly number[] = [
  23, 35, 43, 45, 46, 48, 56, 57, 59, 60, 65, 67, 72, 73, 76, 76, 80, 80, 80, 84, 84, 85, 85, 86, 87, 88, 90, 91, 92,
  95, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
]

/** Mean BiomniBench-DA scores under the same judge, harness names only. */
export const BIO_MEANS: readonly { name: string; value: number; harness: Harness }[] = [
  { name: "OpenScience", value: 82.2, harness: "os" },
  { name: "AIPOCH", value: 81.04, harness: "oth" },
  { name: "OmicOS", value: 76.6, harness: "oth" },
  { name: "Claude Code", value: 68.6, harness: "cc" },
]
