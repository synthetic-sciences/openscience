import path from "path"
import z from "zod"
import { Global } from "@/global"

export namespace HarnessContract {
  export const Profile = z.enum(["react", "optimize", "reproduce", "theory", "numerical", "training", "forecast"])
  export type Profile = z.infer<typeof Profile>

  export const Split = z.enum(["development", "validation", "held_out", "release"])
  export type Split = z.infer<typeof Split>

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
          metric: z.string().min(1).optional(),
          direction: z.enum(["maximize", "minimize", "pass"]).optional(),
        })
        .strict(),
      profile: Profile,
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
    await Bun.write(file(contract.sessionID), JSON.stringify(contract, null, 2) + "\n")
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
