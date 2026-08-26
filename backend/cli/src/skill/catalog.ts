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
      requirements: { any: ["nvidia_nim", "nvidia_ngc"] },
      upstream: {
        ...BIONEMO,
        path: "workflows/generative-protein-binder-design/protein-binder-design",
      },
    },
    {
      name: "literature-review",
      capability: "literature-review",
      role: "workflow",
      status: "review_required",
      upstream: { ...KDENSE, path: "scientific-agent-skills/literature-review" },
    },
    {
      name: "scientific-writing",
      capability: "scientific-writing",
      role: "support",
      status: "review_required",
      upstream: { ...KDENSE, path: "scientific-agent-skills/scientific-writing" },
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
      role: "support",
      status: "review_required",
      upstream: { ...ORCHESTRA, path: "skills/research/ml-paper-writing" },
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
  export function get(name: string): Entry | undefined {
    return indexed.get(name)
  }

  export type Candidate = {
    name: string
    capability?: string
    role?: Role
    status?: Status
    requirements?: { all?: string[]; any?: string[] }
    score?: number
    explicit?: boolean
  }

  export type Omission = {
    name: string
    reason: "blocked" | "unavailable" | "workflow_limit" | "support_limit" | "duplicate"
  }

  function prepared(candidate: Candidate) {
    const entry = get(candidate.name)
    return {
      ...candidate,
      capability: candidate.capability ?? entry?.capability ?? candidate.name,
      role: candidate.role ?? entry?.role ?? ("support" as const),
      status: candidate.status ?? entry?.status ?? ("verified" as const),
      requirements: candidate.requirements ?? entry?.requirements ?? { all: [], any: [] },
    }
  }

  /** Enforce the thin-agent loading budget while leaving the installed catalog
   * untouched. Explicit requests lead the ordering but cannot bypass blocked
   * or unavailable capabilities. */
  export function select(candidates: Candidate[], available: Iterable<string>) {
    const capabilities = new Set(available)
    const ordered = candidates
      .map(prepared)
      .toSorted((a, b) => Number(b.explicit) - Number(a.explicit) || (b.score ?? 0) - (a.score ?? 0))
    const selected: typeof ordered = []
    const omitted: Omission[] = []
    const seen = new Set<string>()
    const counts = { workflow: 0, support: 0 }
    for (const candidate of ordered) {
      if (candidate.status === "blocked") {
        omitted.push({ name: candidate.name, reason: "blocked" })
        continue
      }
      const all = candidate.requirements.all ?? []
      const any = candidate.requirements.any ?? []
      if (
        all.some((item) => !capabilities.has(item)) ||
        (any.length > 0 && !any.some((item) => capabilities.has(item)))
      ) {
        omitted.push({ name: candidate.name, reason: "unavailable" })
        continue
      }
      if (seen.has(candidate.capability)) {
        omitted.push({ name: candidate.name, reason: "duplicate" })
        continue
      }
      if (candidate.role === "workflow" && counts.workflow >= 1) {
        omitted.push({ name: candidate.name, reason: "workflow_limit" })
        continue
      }
      if (candidate.role === "support" && counts.support >= 2) {
        omitted.push({ name: candidate.name, reason: "support_limit" })
        continue
      }
      selected.push(candidate)
      seen.add(candidate.capability)
      counts[candidate.role]++
    }
    return { selected, omitted }
  }
}
