import z from "zod"

export namespace SkillCatalog {
  export const Role = z.enum(["workflow", "support"])
  export type Role = z.infer<typeof Role>
  export const Status = z.enum(["verified", "experimental", "review_required", "blocked"])
  export type Status = z.infer<typeof Status>

  export const Requirement = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  export const Upstream = z.object({
    repository: z.string().url(),
    ref: z.string(),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string(),
    license: z.string(),
  })

  export const Entry = z.object({
    name: z.string(),
    capability: z.string(),
    role: Role,
    status: Status,
    requirements: z
      .object({ all: Requirement.array().default([]), any: Requirement.array().default([]) })
      .default(() => ({ all: [], any: [] })),
    upstream: Upstream.optional(),
    replaced_by: z.string().optional(),
  })
  export type Entry = z.infer<typeof Entry>

  const BIONEMO = {
    repository: "https://github.com/NVIDIA-BioNeMo/bionemo-agent-toolkit",
    ref: "main",
    sha: "0e67a612e4045f007e38fa77adc8f3ebfc5616b6",
    license: "CC-BY-4.0 skills and documentation; Apache-2.0 code; model-specific terms apply",
  } as const
  const KDENSE = {
    repository: "https://github.com/K-Dense-AI/scientific-agent-skills",
    ref: "v2.64.0",
    sha: "9e8b0cb0b09059f2fd4505e57ab4e00c8be1cef6",
    license: "MIT",
  } as const
  const ORCHESTRA = {
    repository: "https://github.com/Orchestra-Research/AI-Research-SKILLs",
    ref: "v1.7.2",
    sha: "773a52944ba4747a18bd4ae9ade53fff041adcbc",
    license: "MIT",
  } as const

  /** Metadata only. Upstream repositories are not bundled or installed by
   * this catalog; an entry becomes callable only when a corresponding local
   * skill already exists or passes the normal reviewed installer. */
  export const entries = Entry.array().parse([
    {
      name: "protein-binder-design",
      capability: "protein-binder-design",
      role: "workflow",
      status: "experimental",
      requirements: { all: [], any: [] },
      upstream: {
        ...BIONEMO,
        path: "workflows/generative-protein-binder-design/protein-binder-design",
      },
    },
    // Core skills are authored here; the K-Dense originals they replaced are
    // reachable through the aliases below.
    {
      name: "literature-review",
      capability: "literature-review",
      role: "workflow",
      status: "verified",
    },
    {
      name: "paper-writing",
      capability: "scientific-writing",
      role: "workflow",
      status: "verified",
    },
    ...["transformer-lens", "saelens", "nnsight", "pyvene"].map((name) => ({
      name,
      capability: `mechanistic-interpretability-${name}`,
      role: "support" as const,
      status: "review_required" as const,
      upstream: { ...ORCHESTRA, path: `skills/mechanistic-interpretability/${name}` },
    })),
    {
      name: "ml-paper-writing",
      capability: "ml-paper-writing",
      role: "workflow",
      status: "verified",
    },
    {
      name: "modal",
      capability: "modal-compute",
      role: "support",
      status: "blocked",
      replaced_by: "compute_job",
    },
  ])

  const indexed = new Map(entries.map((entry) => [entry.name, entry]))
  /** Retired names resolve to the skill that replaced them, so saved
   * invocations, `/name` slashes and installer entries keep working. */
  const aliases = new Map([
    ["bionemo-agent-toolkit", "protein-binder-design"],
    ["scientific-writing", "paper-writing"],
    ["venue-templates", "paper-writing"],
    ["citation-management", "citations"],
    ["scientific-schematics", "schematics"],
    ["perplexity-search", "research-lookup"],
    ["conducting-scientific-research", "research-lookup"],
    ["scientific-critical-thinking", "peer-review"],
    ["verify", "sources"],
    ["scientific-brainstorming", "brainstorming"],
    ["scientific-problem-selection", "brainstorming"],
    ["hypothesis-generation", "hypotheses"],
  ])

  export function resolve(name: string) {
    return aliases.get(name) ?? name
  }

  export function get(name: string): Entry | undefined {
    return indexed.get(resolve(name))
  }
}
