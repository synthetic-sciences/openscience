import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessPack } from "./pack"

export namespace HarnessContract {
  export const Profile = z.enum(["react", "optimize", "reproduce", "theory", "numerical", "training", "forecast"])
  export type Profile = z.infer<typeof Profile>

  export const Topology = z.enum(["auto", "solo", "centralized", "fork_join", "tournament", "evolution"])
  export type Topology = z.infer<typeof Topology>

  export const Role = z.enum([
    "generation",
    "proximity",
    "reflection",
    "ranking",
    "evolution",
    "verification",
    "investigation",
    "simulation",
    "synthesis",
  ])
  export type Role = z.infer<typeof Role>

  export const Traits = z
    .object({
      decomposability: z.number().min(0).max(1),
      sequentiality: z.number().min(0).max(1),
      toolIntensity: z.number().min(0).max(1),
      uncertainty: z.number().min(0).max(1),
      verificationRisk: z.number().min(0).max(1),
      novelty: z.number().min(0).max(1),
      crossDomain: z.number().min(0).max(1),
    })
    .strict()
  export type Traits = z.infer<typeof Traits>

  export const Orchestration = z
    .object({
      topology: Topology,
      traits: Traits.optional(),
      maxWorkers: z.number().int().min(1).max(2),
      maxRounds: z.number().int().min(1).max(8),
      roles: z
        .array(Role)
        .min(1)
        .max(Role.options.length)
        .refine((items) => new Set(items).size === items.length, "Orchestration roles must be unique")
        .optional(),
      minIndependentVerifiers: z.number().int().min(1).max(2),
    })
    .strict()
  export type Orchestration = z.infer<typeof Orchestration>

  export const Audit = z
    .object({
      mode: z.enum(["performance", "failure", "hybrid"]),
      budget: z.number().int().min(2).max(512),
      minSamples: z.number().int().min(2).max(512),
      noiseVariance: z.number().positive().max(2).default(0.05),
      lengthscale: z.number().positive().max(100).default(1),
      beta: z.number().nonnegative().max(10).default(1.96),
      failureThreshold: z.number().min(0).max(1).default(0.5),
      tolerance: z.number().positive().max(1).default(0.02),
      maxUncertainty: z.number().positive().max(1).default(0.05),
      estimationWeight: z.number().min(0).max(1).default(0.5),
      diversityWeight: z.number().min(0).max(0.5).default(0.2),
      coverageWeight: z.number().min(0).max(0.5).default(0.2),
      targetFailures: z.number().int().positive().max(512).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.minSamples > value.budget) {
        ctx.addIssue({ code: "custom", path: ["minSamples"], message: "Audit minimum samples exceed its budget" })
      }
      if (value.diversityWeight + value.coverageWeight > 1) {
        ctx.addIssue({ code: "custom", message: "Audit diversity and coverage weights cannot exceed one" })
      }
      if (value.targetFailures !== undefined && value.targetFailures > value.budget) {
        ctx.addIssue({ code: "custom", path: ["targetFailures"], message: "Audit failure target exceeds its budget" })
      }
    })
  export type Audit = z.infer<typeof Audit>

  export const Split = z.enum(["development", "validation", "held_out", "release"])
  export type Split = z.infer<typeof Split>

  export const Fidelity = z
    .object({
      id: z.string().min(1).max(100),
      final: z.boolean(),
      maxWallTimeMs: z.number().int().positive().optional(),
      maxCostUSD: z.number().nonnegative().optional(),
    })
    .strict()
  export const FidelityPlan = z
    .array(Fidelity)
    .min(2)
    .max(8)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Fidelity stages must be unique")
    .refine((items) => items.filter((item) => item.final).length === 1, "A fidelity plan needs exactly one final stage")
    .refine((items) => items.at(-1)?.final === true, "The final fidelity stage must be last")

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      objective: z.string().min(1),
      benchmark: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          taskID: z.string().min(1),
          split: Split,
          evaluator: z.string().min(1),
          evaluatorVersion: z.string().min(1).optional(),
          evaluatorSource: z.enum(["benchmark", "gate", "human", "external"]).optional(),
          fidelities: FidelityPlan.optional(),
          metric: z.string().min(1).optional(),
          direction: z.enum(["maximize", "minimize", "pass"]).optional(),
          target: z.number().finite().optional(),
        })
        .strict(),
      profile: Profile,
      orchestration: Orchestration.optional(),
      audit: Audit.optional(),
      packs: z
        .array(HarnessPack.Id)
        .max(HarnessPack.Id.options.length)
        .refine((items) => new Set(items).size === items.length, "Harness packs must be unique")
        .optional(),
      model: z
        .object({
          provider: z.string().min(1),
          name: z.string().min(1),
          effort: z.string().min(1).optional(),
        })
        .strict(),
      tools: z.array(z.string().min(1)).default([]),
      skills: z
        .array(
          z
            .object({
              name: z.string().min(1),
              version: z.string().min(1).optional(),
              sha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
            })
            .strict(),
        )
        .default([]),
      budget: z
        .object({
          wallTimeMs: z.number().int().positive().optional(),
          steps: z.number().int().positive().optional(),
          candidates: z.number().int().positive().optional(),
          tokens: z.number().int().positive().optional(),
          costUSD: z.number().nonnegative().optional(),
          cpuHours: z.number().nonnegative().optional(),
          gpuHours: z.number().nonnegative().optional(),
        })
        .strict(),
      seed: z.number().int(),
      intervention: z.enum(["autonomous", "human_reprompted"]),
      contamination: z
        .object({
          policy: z.string().min(1),
          hiddenTestsAccessible: z.literal(false),
          publicDataCutoff: z.string().min(1).optional(),
        })
        .strict(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  const root = path.join(Global.Path.data, "harness", "contracts")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)

  export async function bind(input: Info) {
    const contract = Info.parse(input)
    await JsonStore.update(file(contract.sessionID), (data) => {
      if (!Object.keys(data).length) return contract
      const current = Info.parse(data)
      if (fingerprint(current) === fingerprint(contract)) return current
      throw new Error(`Harness contract for session ${contract.sessionID} is immutable once bound`)
    })
    return contract
  }

  export async function read(sessionID: string): Promise<Info | null> {
    const data = await Bun.file(file(sessionID))
      .json()
      .catch(() => null)
    const parsed = Info.safeParse(data)
    return parsed.success ? parsed.data : null
  }

  export function fingerprint(input: Info) {
    const contract = Info.parse(input)
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(contract)).digest("hex")
  }
}
