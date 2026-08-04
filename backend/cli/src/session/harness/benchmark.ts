import z from "zod"
import { HarnessPack } from "./pack"

export namespace HarnessBenchmark {
  export const Id = z.enum([
    "statistics",
    "bixbench",
    "lifescience",
    "genebench",
    "biomni",
    "physics",
    "pde",
    "chembench",
    "matscibench",
    "mle",
    "posttrain",
    "ale",
    "weather",
    "researchclaw",
    "paperbench",
    "corebench",
    "scienceagentbench",
    "discoverybench",
    "scicode",
    "labbench",
    "sciagentarena",
    "ainsteinbench",
    "critpt",
  ])
  export type Id = z.infer<typeof Id>

  const Profile = z.enum(["react", "optimize", "reproduce", "theory", "numerical", "training", "forecast"])

  const Date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  const Revision = z.string().regex(/^[a-f0-9]{40}$/)
  const Paths = z
    .array(z.string().min(1).max(500))
    .min(1)
    .max(50)
    .refine((items) => new Set(items).size === items.length, "Required source paths must be unique")

  export const Source = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("official_open"),
          repository: z.string().url(),
          revision: Revision,
          homepage: z.string().url(),
          requiredPaths: Paths,
          dataset: z.string().url().optional(),
          checkedAt: Date,
        })
        .strict(),
      z
        .object({
          status: z.literal("official_subset"),
          repository: z.string().url(),
          revision: Revision,
          homepage: z.string().url(),
          dataset: z.string().url(),
          requiredPaths: Paths,
          publicTasks: z.number().int().positive(),
          totalTasks: z.number().int().positive(),
          scope: z.string().min(1).max(1_000),
          checkedAt: Date,
        })
        .strict(),
      z
        .object({
          status: z.literal("methodology_only"),
          reason: z.string().min(1).max(1_000),
        })
        .strict(),
    ])
    .superRefine((value, ctx) => {
      if (value.status !== "official_subset" || value.publicTasks < value.totalTasks) return
      ctx.addIssue({
        code: "custom",
        path: ["publicTasks"],
        message: "A public subset must be smaller than the full task set",
      })
    })
  export type Source = z.infer<typeof Source>

  export const Manifest = z
    .object({
      id: Id,
      title: z.string().min(1),
      family: z.enum(["data", "biology", "physics", "chemistry", "ml", "generalist"]),
      aliases: z.array(z.string().min(1)).min(1),
      profile: Profile,
      profiles: z.array(Profile).min(1),
      packs: z.array(HarnessPack.Id),
      execution: z.literal("external_runner_required"),
      source: Source,
      task: z.string().min(1),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (!value.profiles.includes(value.profile)) {
        ctx.addIssue({ code: "custom", path: ["profile"], message: "Default profile must be allowed" })
      }
      if (new Set(value.profiles).size !== value.profiles.length) {
        ctx.addIssue({ code: "custom", path: ["profiles"], message: "Allowed profiles must be unique" })
      }
      if (new Set(value.packs).size !== value.packs.length) {
        ctx.addIssue({ code: "custom", path: ["packs"], message: "Required packs must be unique" })
      }
    })
  export type Manifest = z.infer<typeof Manifest>

  const item = (input: Omit<Manifest, "execution">) =>
    Manifest.parse({ ...input, execution: "external_runner_required" })

  const checkedAt = "2026-08-05"
  const source = (repository: string, revision: string, homepage: string, requiredPaths: string[], dataset?: string) =>
    Source.parse({ status: "official_open", repository, revision, homepage, requiredPaths, dataset, checkedAt })
  const subset = (input: Omit<Extract<Source, { status: "official_subset" }>, "status" | "checkedAt">) =>
    Source.parse({ status: "official_subset", ...input, checkedAt })
  const method = (reason: string) => Source.parse({ status: "methodology_only", reason })

  export const catalog: Record<Id, Manifest> = {
    statistics: item({
      id: "statistics",
      title: "Data and statistical methodology",
      family: "data",
      aliases: ["statistics", "stats", "data-stats", "chi-square", "chi2", "p2"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["statistics"],
      source: method("This adapter is a statistical-methodology family, not one versioned external benchmark."),
      task: "Statistical analysis with explicit estimands, assumptions, effect sizes, uncertainty, and replay.",
    }),
    bixbench: item({
      id: "bixbench",
      title: "BixBench",
      family: "biology",
      aliases: ["bixbench", "bix-bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics"],
      source: source(
        "https://github.com/Future-House/BixBench",
        "49311180bdacb324c596f2e07596c126f2004008",
        "https://arxiv.org/abs/2503.00096",
        ["bixbench/graders.py", "scripts/run_agentic.sh"],
        "https://huggingface.co/datasets/futurehouse/BixBench",
      ),
      task: "Computational biology analysis with reproducible data, code, and biological validation.",
    }),
    lifescience: item({
      id: "lifescience",
      title: "Life-science computational tasks",
      family: "biology",
      aliases: ["lifescience", "life-science", "lifescie", "life science", "lifescibench", "life-sci-bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics"],
      source: method("This adapter is a cross-benchmark life-science methodology family."),
      task: "Life-science workflows with design-aware statistical and biological verification.",
    }),
    genebench: item({
      id: "genebench",
      title: "GeneBench-Pro public case studies",
      family: "biology",
      aliases: ["genebench", "gene-bench", "genebench-pro", "gene-bench-pro"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics", "ml"],
      source: subset({
        repository: "https://huggingface.co/datasets/openai/genebench-pro-public-package",
        revision: "eb75a3c0996b3cedcc9af685bad02fd166848fa2",
        homepage: "https://openai.com/index/introducing-genebench-pro/",
        dataset: "https://huggingface.co/datasets/openai/genebench-pro-public-package",
        requiredPaths: ["manifest.json", "checksums.sha256", "problems.csv"],
        publicTasks: 10,
        totalTasks: 129,
        scope: "Public ground truths support reproduction and model analysis, not a hidden-answer leaderboard.",
      }),
      task: "Gene-centric prediction or analysis with identifier, split, leakage, and statistical controls.",
    }),
    biomni: item({
      id: "biomni",
      title: "Biomni-Eval1",
      family: "biology",
      aliases: ["biomni", "biomni-bench", "biomni bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics"],
      source: source(
        "https://github.com/snap-stanford/Biomni",
        "400c1f366b96a35ca253e13c9b06c5076af41d65",
        "https://biomni.stanford.edu/",
        ["biomni/eval/biomni_eval1.py"],
        "https://huggingface.co/datasets/biomni/Eval1",
      ),
      task: "General biomedical agent work with source, method, and biological validity checks.",
    }),
    physics: item({
      id: "physics",
      title: "Pure and agentic physics",
      family: "physics",
      aliases: ["physics", "pure-physics", "physics-intern", "agentic-simulation"],
      profile: "theory",
      profiles: ["react", "reproduce", "theory", "numerical", "optimize"],
      packs: ["physics"],
      source: method("This adapter spans theory and agentic simulation rather than one external benchmark release."),
      task: "Physics reasoning or simulation checked through dimensions, limits, invariants, and independent routes.",
    }),
    pde: item({
      id: "pde",
      title: "PDEBench and numerical simulation",
      family: "physics",
      aliases: ["pde", "pdebench", "pde-bench", "numerical-pde"],
      profile: "numerical",
      profiles: ["reproduce", "numerical", "optimize"],
      packs: ["physics", "pde"],
      source: source(
        "https://github.com/pdebench/PDEBench",
        "4ff3e3a4aa1561721b5571fa3a048a0a463e0568",
        "https://github.com/pdebench/PDEBench",
        ["pdebench/models"],
      ),
      task: "Numerical PDE work with exact problem statements, convergence, stability, and reference checks.",
    }),
    chembench: item({
      id: "chembench",
      title: "ChemBench",
      family: "chemistry",
      aliases: ["chembench", "chem-bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["chemistry"],
      source: source(
        "https://github.com/lamalab-org/chembench",
        "45f8bad062fe552810c52be3a328d5da8597ed30",
        "https://www.chembench.org/",
        ["src/chembench/evaluate.py"],
      ),
      task: "Chemistry reasoning or prediction with identity, representation, conditions, and validity controls.",
    }),
    matscibench: item({
      id: "matscibench",
      title: "MatSciBench",
      family: "chemistry",
      aliases: ["matscibench", "matsci-bench", "materials-bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "numerical", "optimize"],
      packs: ["chemistry", "physics"],
      source: source(
        "https://github.com/Jun-Kai-Zhang/MatSciBench",
        "042be2852ea6005a021d03f6501b0a56349bbda0",
        "https://arxiv.org/abs/2510.12171",
        ["evaluation/eval.py"],
        "https://huggingface.co/datasets/JunkaiZ/MatSciBench",
      ),
      task: "Materials-science reasoning or prediction with structural and physical validity checks.",
    }),
    mle: item({
      id: "mle",
      title: "MLE benchmark",
      family: "ml",
      aliases: ["mle", "mle-bench", "mlebench"],
      profile: "optimize",
      profiles: ["optimize"],
      packs: ["ml"],
      source: source(
        "https://github.com/openai/mle-bench",
        "507f92e1138bb6e40dac5c6ee7a6758e6424bf97",
        "https://arxiv.org/abs/2410.07095",
        ["mlebench/grade.py", "environment/grading_server.py"],
      ),
      task: "Iterative machine-learning engineering against an immutable held-out evaluator and budget.",
    }),
    posttrain: item({
      id: "posttrain",
      title: "Post-training benchmark",
      family: "ml",
      aliases: ["posttrain", "post-training", "posttrain-bench"],
      profile: "training",
      profiles: ["training", "optimize"],
      packs: ["ml"],
      source: source(
        "https://github.com/aisa-group/PostTrainBench",
        "d3496fa7d5788a007d6cd143167471ccdfc688d0",
        "https://posttrainbench.com/",
        ["src/eval/tasks", "src/baselines/run_baseline.sh"],
      ),
      task: "Model post-training with fixed data, model identity, held-out evaluation, and compute accounting.",
    }),
    ale: item({
      id: "ale",
      title: "ALE-Bench algorithm engineering",
      family: "ml",
      aliases: ["ale", "ale-bench", "algorithmic-long-horizon-engineering"],
      profile: "optimize",
      profiles: ["react", "optimize", "training"],
      packs: ["ml"],
      source: source(
        "https://github.com/SakanaAI/ALE-Bench",
        "f7d927906dc1dcd860ee086e4560d576438b1354",
        "https://arxiv.org/abs/2506.09050",
        ["src/ale_bench_eval/evaluate.py", "scripts/run_eval.sh"],
        "https://huggingface.co/datasets/SakanaAI/ALE-Bench",
      ),
      task: "Long-horizon score-based algorithm engineering under fixed contest, compute, and feedback budgets.",
    }),
    weather: item({
      id: "weather",
      title: "WeatherBench 2",
      family: "ml",
      aliases: ["weather", "weather-bench", "weatherbench", "forecast"],
      profile: "forecast",
      profiles: ["reproduce", "training", "forecast", "optimize"],
      packs: ["ml", "forecast"],
      source: source(
        "https://github.com/google-research/weatherbench2",
        "95c36d547b22abc2d191451a580b0b194fde67ef",
        "https://weatherbench2.readthedocs.io/",
        ["weatherbench2/evaluation.py", "scripts/evaluate.py"],
      ),
      task: "Lead-dependent weather forecasting with configuration, calibration, leakage, and baseline controls.",
    }),
    researchclaw: item({
      id: "researchclaw",
      title: "ResearchClawBench",
      family: "generalist",
      aliases: ["researchclaw", "researchclawbench", "research-claw-bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: [],
      source: source(
        "https://github.com/InternScience/ResearchClawBench",
        "595f318eae447b20c440fe4e56cdb62c0c06327e",
        "https://internscience.github.io/ResearchClawBench-Home/",
        ["evaluation/score.py", "evaluation/run_task.py"],
        "https://huggingface.co/datasets/InternScience/ResearchClawBench",
      ),
      task: "General research execution with benchmark-specific packs added without silently changing the evaluator.",
    }),
    paperbench: item({
      id: "paperbench",
      title: "PaperBench",
      family: "ml",
      aliases: ["paperbench", "paper-bench"],
      profile: "reproduce",
      profiles: ["reproduce", "optimize"],
      packs: ["ml"],
      source: source(
        "https://github.com/openai/frontier-evals",
        "51052cede8cc608f95bb00346635e03759013e5a",
        "https://openai.com/index/paperbench/",
        ["project/paperbench/paperbench/grade.py"],
      ),
      task: "End-to-end machine-learning paper replication with immutable artifacts, rubric grading, and compute accounting.",
    }),
    corebench: item({
      id: "corebench",
      title: "CORE-Bench computational reproducibility",
      family: "generalist",
      aliases: ["corebench", "core-bench", "core-repro", "computational-reproducibility-agent-benchmark"],
      profile: "reproduce",
      profiles: ["reproduce", "react"],
      packs: [],
      source: source(
        "https://github.com/siegelz/core-bench",
        "e32a2980e72fe6eb04ee04eb749458f570625663",
        "https://crab.cs.princeton.edu/core-website/",
        ["benchmark/benchmark.py", "benchmark/evaluations.py"],
      ),
      task: "Reproduce published results from supplied code and data under the benchmark's exact difficulty and modality.",
    }),
    scienceagentbench: item({
      id: "scienceagentbench",
      title: "ScienceAgentBench",
      family: "generalist",
      aliases: ["scienceagentbench", "science-agent-bench"],
      profile: "reproduce",
      profiles: ["reproduce", "optimize"],
      packs: ["statistics"],
      source: source(
        "https://github.com/OSU-NLP-Group/ScienceAgentBench",
        "c26e151ed601ba109dc4d35e057ff8e73fec469d",
        "https://arxiv.org/abs/2410.05080",
        ["evaluation/harness/grading.py", "run_eval.py"],
      ),
      task: "Generate and execute self-contained programs for data-driven scientific tasks with result and cost evaluation.",
    }),
    discoverybench: item({
      id: "discoverybench",
      title: "DiscoveryBench",
      family: "data",
      aliases: ["discoverybench", "discovery-bench"],
      profile: "reproduce",
      profiles: ["reproduce", "optimize"],
      packs: ["statistics"],
      source: source(
        "https://github.com/allenai/discoverybench",
        "c31fcf011e070f021a5f5b906896d0821f6880e8",
        "https://github.com/allenai/discoverybench",
        ["eval/eval.py"],
        "https://huggingface.co/datasets/allenai/discoverybench",
      ),
      task: "Perform multi-step data-driven discovery with explicit hypotheses, workflows, verification, and facet scores.",
    }),
    scicode: item({
      id: "scicode",
      title: "SciCode",
      family: "generalist",
      aliases: ["scicode", "sci-code"],
      profile: "react",
      profiles: ["react", "reproduce", "numerical"],
      packs: [],
      source: source(
        "https://github.com/scicode-bench/SciCode",
        "e3158ea011d4235245a547460d3688d7ccbf9900",
        "https://scicode-bench.github.io/docs/",
        ["eval/inspect_ai/scicode.py", "eval/scripts/test_generated_code.py"],
      ),
      task: "Solve scientist-curated research coding problems and their decomposed subproblems against executable tests.",
    }),
    labbench: item({
      id: "labbench",
      title: "LABBench2",
      family: "biology",
      aliases: ["labbench", "lab-bench", "labbench2", "lab-bench-2"],
      profile: "react",
      profiles: ["react", "reproduce"],
      packs: [],
      source: source(
        "https://github.com/EdisonScientific/labbench2",
        "c028ecdcf144b55ffcd92b68be45081df5628c20",
        "https://arxiv.org/abs/2604.09554",
        ["evals/evaluators.py", "evals/run_evals.py"],
        "https://huggingface.co/datasets/futurehouse/labbench2",
      ),
      task: "Answer practical biology research tasks under the official subtask, retrieval, and scoring protocol.",
    }),
    sciagentarena: item({
      id: "sciagentarena",
      title: "SciAgentArena",
      family: "generalist",
      aliases: ["sciagentarena", "sci-agent-arena"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: [],
      source: source(
        "https://github.com/HelloWorldLTY/SciAgentArena",
        "c413f660304bf5def1c54a23619267e3ee2ef6ad",
        "https://sciagentarena.github.io/",
        ["evaluations/dd/evaluate.py"],
        "https://huggingface.co/datasets/iLOVE2D/SciAgentArena",
      ),
      task: "Execute real-world scientific workflows in an interactive environment with stepwise external verification.",
    }),
    ainsteinbench: item({
      id: "ainsteinbench",
      title: "AInsteinBench",
      family: "generalist",
      aliases: ["ainsteinbench", "ainstein-bench", "einsteinbench"],
      profile: "react",
      profiles: ["react", "reproduce", "numerical"],
      packs: [],
      source: source(
        "https://github.com/ByteDance-Seed/AInsteinBench",
        "d9b1383e86c2ae43dcb3ddbcaf34c21ceb786cca",
        "https://arxiv.org/abs/2512.21373",
        ["evaluate_questions.py", "data/eval/et_eval.json"],
      ),
      task: "Implement maintainer-authored changes in scientific repositories against executable scientific tests.",
    }),
    critpt: item({
      id: "critpt",
      title: "CritPt",
      family: "physics",
      aliases: ["critpt", "crit-pt", "critical-physics-tasks"],
      profile: "theory",
      profiles: ["react", "theory", "numerical"],
      packs: ["physics"],
      source: source(
        "https://github.com/CritPt-Benchmark/CritPt",
        "17c2545c302762d2f2d644d923ea4c301605cb08",
        "https://critpt.com/",
        ["src/critpt/evaluation/eval_client.py", "evaluate_all_results.py"],
        "https://huggingface.co/datasets/introvoyz041/CritPt",
      ),
      task: "Solve difficult physics problems with decomposed derivations, independent checks, critique, and exact-answer grading.",
    }),
  }

  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")

  export function resolve(value: string) {
    const target = normalize(value)
    const result = Object.values(catalog).find(
      (entry) =>
        normalize(entry.id) === target ||
        normalize(entry.title) === target ||
        entry.aliases.some((alias) => normalize(alias) === target),
    )
    if (!result) throw new Error(`Unsupported benchmark adapter: ${value}`)
    return result
  }
}
