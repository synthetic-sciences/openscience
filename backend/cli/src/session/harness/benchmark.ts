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
  ])
  export type Id = z.infer<typeof Id>

  const Profile = z.enum(["react", "optimize", "reproduce", "theory", "numerical", "training", "forecast"])

  export const Manifest = z
    .object({
      id: Id,
      title: z.string().min(1),
      family: z.enum(["data", "biology", "physics", "chemistry", "ml", "generalist"]),
      aliases: z.array(z.string().min(1)).min(1),
      profile: Profile,
      profiles: z.array(Profile).min(1),
      packs: z.array(HarnessPack.Id),
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

  const item = (input: Manifest) => Manifest.parse(input)

  export const catalog: Record<Id, Manifest> = {
    statistics: item({
      id: "statistics",
      title: "Data and statistical methodology",
      family: "data",
      aliases: ["statistics", "stats", "data-stats", "chi-square", "chi2", "p2"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["statistics"],
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
      task: "Computational biology analysis with reproducible data, code, and biological validation.",
    }),
    lifescience: item({
      id: "lifescience",
      title: "Life-science computational tasks",
      family: "biology",
      aliases: ["lifescience", "life-science", "lifescie", "life science"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics"],
      task: "Life-science workflows with design-aware statistical and biological verification.",
    }),
    genebench: item({
      id: "genebench",
      title: "GeneBench",
      family: "biology",
      aliases: ["genebench", "gene-bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics", "ml"],
      task: "Gene-centric prediction or analysis with identifier, split, leakage, and statistical controls.",
    }),
    biomni: item({
      id: "biomni",
      title: "BioMni benchmark",
      family: "biology",
      aliases: ["biomni", "biomni-bench", "biomni bench"],
      profile: "reproduce",
      profiles: ["react", "reproduce", "optimize"],
      packs: ["biology", "statistics"],
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
      task: "Physics reasoning or simulation checked through dimensions, limits, invariants, and independent routes.",
    }),
    pde: item({
      id: "pde",
      title: "PDE and numerical simulation",
      family: "physics",
      aliases: ["pde", "pdebench", "pde-bench", "numerical-pde"],
      profile: "numerical",
      profiles: ["reproduce", "numerical", "optimize"],
      packs: ["physics", "pde"],
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
      task: "Model post-training with fixed data, model identity, held-out evaluation, and compute accounting.",
    }),
    ale: item({
      id: "ale",
      title: "Agent learning environment",
      family: "ml",
      aliases: ["ale", "ale-bench", "agent-learning-environment"],
      profile: "optimize",
      profiles: ["react", "optimize", "training"],
      packs: ["ml"],
      task: "Agent learning and adaptation under fixed environment, evaluation, and interaction budgets.",
    }),
    weather: item({
      id: "weather",
      title: "Weather forecasting benchmark",
      family: "ml",
      aliases: ["weather", "weather-bench", "weatherbench", "forecast"],
      profile: "forecast",
      profiles: ["reproduce", "training", "forecast", "optimize"],
      packs: ["ml", "forecast"],
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
      task: "General research execution with benchmark-specific packs added without silently changing the evaluator.",
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
