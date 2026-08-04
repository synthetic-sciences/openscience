import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessLaunch {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Check = z
    .object({
      id: HarnessContract.LaunchCheck,
      status: z.enum(["passed", "failed"]),
      evidence: z
        .array(z.string().min(1).max(2_048))
        .min(1)
        .max(32)
        .refine((items) => new Set(items).size === items.length, "Launch-check evidence must be unique"),
    })
    .strict()
  export type Check = z.infer<typeof Check>

  export const Validator = z
    .object({
      name: z.literal("verify-benchmark-launch"),
      version: z.literal("1"),
      scriptSHA256: Hash,
      manifestSHA256: Hash,
    })
    .strict()
  export type Validator = z.infer<typeof Validator>

  export const Submit = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      protocol: HarnessContract.Launch,
      validator: Validator,
      checks: z
        .array(Check)
        .length(HarnessContract.LaunchCheck.options.length)
        .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Launch checks must be unique"),
      baselineScore: z.number().finite().optional(),
      evidence: z
        .array(z.string().min(1).max(2_048))
        .min(1)
        .max(128)
        .refine((items) => new Set(items).size === items.length, "Launch evidence must be unique"),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      submissionID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "external"]),
        })
        .strict(),
      protocol: HarnessContract.Launch,
      validator: Validator,
      checks: z.array(Check).length(HarnessContract.LaunchCheck.options.length),
      baselineScore: z.number().finite().optional(),
      baselineDelta: z.number().finite().optional(),
      status: z.enum(["passed", "failed"]),
      failures: z.array(z.string().min(1).max(500)).max(32),
      evidence: z.array(z.string().min(1).max(2_048)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  function outcome(protocol: HarnessContract.Launch, checks: Check[], baselineScore?: number) {
    const baseline = protocol.baseline.expectedScore
    const delta = baseline === undefined || baselineScore === undefined ? undefined : Math.abs(baselineScore - baseline)
    const failures = [
      ...checks.filter((item) => item.status !== "passed").map((item) => `launch-check:${item.id}`),
      ...(delta !== undefined && delta > protocol.baseline.tolerance! ? [`baseline-delta:${delta}`] : []),
    ]
    return {
      baselineDelta: delta,
      status: failures.length ? ("failed" as const) : ("passed" as const),
      failures,
    }
  }

  function submission(input: {
    runID: string
    sessionID: string
    protocol: HarnessContract.Launch
    validator: Validator
    checks: Check[]
    baselineScore?: number
    evidence: string[]
    evaluatedAt: number
  }) {
    return digest({ schemaVersion: 1, ...input })
  }

  const State = z
    .object({
      schemaVersion: z.literal(1),
      items: z.record(Hash, Info),
      order: z.array(Hash),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Launch receipt order must be unique" })
      }
      for (const id of value.order) {
        const receipt = value.items[id]
        if (!receipt) {
          ctx.addIssue({ code: "custom", path: ["order"], message: `Launch receipt ${id} is missing` })
          continue
        }
        if (receipt.receiptID !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Launch receipt key does not match its ID" })
        }
        const payload = structuredClone(receipt) as Record<string, unknown>
        delete payload.receiptID
        if (digest(payload) !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Launch receipt content hash is invalid" })
        }
        const derived = outcome(receipt.protocol, receipt.checks, receipt.baselineScore)
        if (
          !same(
            {
              baselineDelta: receipt.baselineDelta,
              status: receipt.status,
              failures: receipt.failures,
            },
            derived,
          )
        ) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Launch receipt outcome derivation drifted" })
        }
        if (
          receipt.submissionID !==
          submission({
            runID: receipt.runID,
            sessionID: receipt.sessionID,
            protocol: receipt.protocol,
            validator: receipt.validator,
            checks: receipt.checks,
            baselineScore: receipt.baselineScore,
            evidence: receipt.evidence,
            evaluatedAt: receipt.evaluatedAt,
          })
        ) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Launch submission content hash is invalid" })
        }
      }
      for (const id of Object.keys(value.items)) {
        if (value.order.includes(id)) continue
        ctx.addIssue({ code: "custom", path: ["items", id], message: "Launch receipt is absent from journal order" })
      }
    })
  type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "launches")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const empty = (): State => ({ schemaVersion: 1, items: {}, order: [] })
  const state = (input: Record<string, unknown>) => State.parse(Object.keys(input).length ? input : empty())

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    const protocol = bound.launch
    if (!protocol) throw new Error(`No benchmark launch protocol is bound to session ${value.sessionID}`)
    if (bound.sessionID !== value.sessionID || bound.runID !== value.runID) {
      throw new Error(`Launch receipt does not match the bound harness run`)
    }
    if (value.evaluatedAt < bound.createdAt) throw new Error(`Launch receipt predates the harness contract`)
    if (value.evaluatedAt > Date.now() + 300_000) throw new Error(`Launch receipt is implausibly future-dated`)
    if (!same(value.protocol, protocol))
      throw new Error(`Launch protocol does not match the immutable harness contract`)
    if (value.validator.scriptSHA256 !== protocol.validatorSHA256) {
      throw new Error(`Launch validator does not match the immutable harness contract`)
    }
    const expected = HarnessContract.LaunchCheck.options.toSorted()
    const submitted = value.checks.map((item) => item.id).toSorted()
    if (!same(expected, submitted)) throw new Error(`Launch receipt does not contain the complete readiness suite`)
    const baseline = protocol.baseline.expectedScore
    if (baseline !== undefined && value.baselineScore === undefined) {
      throw new Error(`Launch receipt must report the bound baseline replay score`)
    }
    const checks = value.checks
      .map((item) => ({ ...item, evidence: item.evidence.toSorted() }))
      .toSorted((left, right) => left.id.localeCompare(right.id))
    const evidence = value.evidence.toSorted()
    const submissionID = submission({
      runID: value.runID,
      sessionID: value.sessionID,
      protocol,
      validator: value.validator,
      checks,
      baselineScore: value.baselineScore,
      evidence,
      evaluatedAt: value.evaluatedAt,
    })
    const result = outcome(protocol, checks, value.baselineScore)
    const payload = {
      schemaVersion: 1 as const,
      submissionID,
      runID: value.runID,
      sessionID: value.sessionID,
      contractFingerprint: HarnessContract.fingerprint(bound),
      evaluator: {
        name: bound.benchmark.evaluator,
        version: bound.benchmark.evaluatorVersion!,
        source: bound.benchmark.evaluatorSource!,
      },
      protocol,
      validator: value.validator,
      checks,
      baselineScore: value.baselineScore,
      ...result,
      evidence,
      evaluatedAt: value.evaluatedAt,
      recordedAt: Date.now(),
    }
    const receipt = Info.parse({ ...payload, receiptID: digest(payload) })
    const out = { value: receipt }
    await JsonStore.update(file(value.sessionID), (data) => {
      const current = state(data)
      const existing = current.order.map((id) => current.items[id]!).find((item) => item.submissionID === submissionID)
      if (existing) {
        out.value = existing
        return current
      }
      return State.parse({
        ...current,
        items: { ...current.items, [receipt.receiptID]: receipt },
        order: [...current.order, receipt.receiptID],
      })
    })
    return out.value
  }

  export async function read(sessionID: string, receiptID: string) {
    const current = state(await JsonStore.read(file(sessionID)))
    return current.items[Hash.parse(receiptID)] ?? null
  }

  export async function list(sessionID: string) {
    const current = state(await JsonStore.read(file(sessionID)))
    return current.order.map((id) => current.items[id]!)
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    requirePassed: boolean
    evaluatedAt?: number
    recordedAt?: number
  }) {
    const receipt = await read(input.contract.sessionID, input.receiptID)
    if (!receipt) throw new Error(`Benchmark launch receipt ${input.receiptID} does not exist`)
    if (receipt.runID !== input.contract.runID)
      throw new Error(`Benchmark launch receipt does not match the harness run`)
    if (receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Benchmark launch receipt does not match the immutable harness contract`)
    }
    if (!same(receipt.protocol, input.contract.launch)) {
      throw new Error(`Benchmark launch receipt does not match the bound launch protocol`)
    }
    if (input.evaluatedAt !== undefined && receipt.evaluatedAt > input.evaluatedAt) {
      throw new Error(`Benchmark evaluation predates its referenced launch receipt`)
    }
    if (input.recordedAt !== undefined && receipt.recordedAt > input.recordedAt) {
      throw new Error(`Benchmark evaluation was recorded before its launch readiness receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A benchmark run requires a passing launch readiness receipt`)
    }
    return receipt
  }

  export async function ready(contract: HarnessContract.Info) {
    if (!contract.launch) return null
    const receipt = (await list(contract.sessionID)).findLast(
      (item) => item.contractFingerprint === HarnessContract.fingerprint(contract) && item.status === "passed",
    )
    if (!receipt) throw new Error(`Benchmark execution is blocked until launch readiness passes`)
    return receipt
  }
}
