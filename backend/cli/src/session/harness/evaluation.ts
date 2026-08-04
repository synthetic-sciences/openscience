import path from "path"
import z from "zod"
import { Global } from "@/global"
import { HarnessContract } from "./contract"
import { HarnessDomain } from "./domain"

export namespace HarnessEvaluation {
  export const Status = z.enum(["passed", "failed", "inconclusive"])
  export type Status = z.infer<typeof Status>

  export const Check = z
    .object({
      id: z.string().min(1).max(200),
      status: Status,
      blocking: z.boolean(),
      score: z.number().finite().optional(),
      evidence: z.array(z.string().min(1).max(1_000)).max(32).default([]),
      note: z.string().max(4_000).optional(),
    })
    .strict()
  export type Check = z.infer<typeof Check>

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      subject: z
        .object({
          type: z.enum(["run", "candidate"]),
          id: z.string().min(1),
        })
        .strict()
        .optional(),
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "human", "external"]),
        })
        .strict(),
      status: Status,
      score: z.number().finite().optional(),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "An evaluation may contain at most 128 metrics")
        .default({}),
      checks: z.array(Check).min(1).max(128),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
      notes: z.string().max(8_000).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.status !== "passed") return
      const failed = value.checks.find((check) => check.blocking && check.status !== "passed")
      if (!failed) return
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: `A passed evaluation cannot contain a non-passing blocking check: ${failed.id}`,
      })
    })
  export type Info = z.infer<typeof Info>

  const root = path.join(Global.Path.data, "harness", "evaluations")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)

  export function verified(input: Info) {
    const evaluation = Info.parse(input)
    return (
      evaluation.status === "passed" && evaluation.checks.every((check) => !check.blocking || check.status === "passed")
    )
  }

  export async function record(input: Info) {
    const evaluation = Info.parse(input)
    const contract = await HarnessContract.read(evaluation.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${evaluation.sessionID}`)
    if (contract.runID !== evaluation.runID) {
      throw new Error(`Evaluation run ${evaluation.runID} does not match contract run ${contract.runID}`)
    }
    if (contract.benchmark.evaluator !== evaluation.evaluator.name) {
      throw new Error(
        `Evaluation source ${evaluation.evaluator.name} does not match contract evaluator ${contract.benchmark.evaluator}`,
      )
    }
    if (evaluation.status === "passed") HarnessDomain.assert(contract.packs ?? [], evaluation.checks)
    await Bun.write(file(evaluation.sessionID), JSON.stringify(evaluation, null, 2) + "\n")
    return evaluation
  }

  export async function read(sessionID: string): Promise<Info | null> {
    const data = await Bun.file(file(sessionID))
      .json()
      .catch(() => null)
    const parsed = Info.safeParse(data)
    return parsed.success ? parsed.data : null
  }
}
