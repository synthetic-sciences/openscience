import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
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

  const State = z
    .object({
      schemaVersion: z.literal(1),
      items: z.record(z.string(), Info),
      order: z.array(z.string()),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Evaluation journal order must be unique" })
      }
      for (const key of value.order) {
        if (value.items[key]) continue
        ctx.addIssue({ code: "custom", path: ["order"], message: `Evaluation journal is missing ${key}` })
      }
    })
  type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "evaluations")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const key = (input: Info["subject"]) => (input ? `${input.type}:${input.id}` : "run")
  const empty = (): State => ({ schemaVersion: 1, items: {}, order: [] })

  function state(input: Record<string, unknown>) {
    const legacy = Info.safeParse(input)
    if (!legacy.success) return State.parse(Object.keys(input).length ? input : empty())
    const id = key(legacy.data.subject)
    return State.parse({ schemaVersion: 1, items: { [id]: legacy.data }, order: [id] })
  }

  export function fingerprint(input: Info) {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(Info.parse(input))).digest("hex")
  }

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
    if (
      contract.benchmark.evaluatorVersion !== undefined &&
      contract.benchmark.evaluatorVersion !== evaluation.evaluator.version
    ) {
      throw new Error(
        `Evaluation version ${evaluation.evaluator.version} does not match contract evaluator version ${contract.benchmark.evaluatorVersion}`,
      )
    }
    if (
      contract.benchmark.evaluatorSource !== undefined &&
      contract.benchmark.evaluatorSource !== evaluation.evaluator.source
    ) {
      throw new Error(
        `Evaluation source ${evaluation.evaluator.source} does not match contract source ${contract.benchmark.evaluatorSource}`,
      )
    }
    if (evaluation.status === "passed") HarnessDomain.assert(contract.packs ?? [], evaluation.checks)
    await JsonStore.update(file(evaluation.sessionID), (data) => {
      const current = state(data)
      const id = key(evaluation.subject)
      const existing = current.items[id]
      if (existing && fingerprint(existing) === fingerprint(evaluation)) return current
      if (existing) throw new Error(`Evaluation for ${id} is immutable once recorded`)
      return State.parse({
        ...current,
        items: { ...current.items, [id]: evaluation },
        order: [...current.order, id],
      })
    })
    return evaluation
  }

  export async function list(sessionID: string): Promise<Info[]> {
    const data = await JsonStore.read(file(sessionID))
    const parsed = state(data)
    return parsed.order.map((id) => parsed.items[id]!)
  }

  export async function read(sessionID: string, subject?: Info["subject"]): Promise<Info | null> {
    const items = await list(sessionID)
    if (!subject) return items.at(-1) ?? null
    return items.find((item) => key(item.subject) === key(subject)) ?? null
  }
}
