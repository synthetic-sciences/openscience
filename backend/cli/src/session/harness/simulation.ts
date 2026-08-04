import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessSimulation {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const Artifact = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: Hash,
    })
    .strict()

  export const Subject = z
    .object({
      type: z.enum(["run", "candidate"]),
      id: z.string().min(1).max(240),
      artifact: Artifact,
    })
    .strict()

  export const Level = z
    .object({
      label: z.string().min(1).max(120),
      h: z.number().finite().positive(),
      error: z.number().finite().positive(),
      residual: z.number().finite().nonnegative(),
      invariants: z
        .record(z.string().min(1).max(100), z.number().finite().nonnegative())
        .refine((value) => Object.keys(value).length <= 32, "A level may report at most 32 invariants"),
    })
    .strict()

  export const Stress = z
    .object({
      id: HarnessContract.SimulationStress,
      status: z.enum(["passed", "failed", "inconclusive"]),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  export const Submit = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      subject: Subject,
      engine: HarnessContract.SimulationEngine,
      problemSHA256: Hash,
      reference: HarnessContract.SimulationReference,
      validationInputSHA256: Hash,
      levels: z
        .array(Level)
        .min(3)
        .max(24)
        .refine(
          (items) => new Set(items.map((item) => item.label)).size === items.length,
          "Level labels must be unique",
        ),
      stressTests: z
        .array(Stress)
        .max(HarnessContract.SimulationStress.options.length)
        .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Stress tests must be unique"),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
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
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      subject: Subject,
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "external"]),
        })
        .strict(),
      engine: HarnessContract.SimulationEngine,
      problemSHA256: Hash,
      reference: HarnessContract.SimulationReference,
      validationInputSHA256: Hash,
      levels: z.array(Level).min(3).max(24),
      observedOrders: z.array(z.number().finite()).max(23),
      medianObservedOrder: z.number().finite(),
      stressTests: z.array(Stress).max(HarnessContract.SimulationStress.options.length),
      checks: z
        .object({
          enoughLevels: z.boolean(),
          resolutionDecreases: z.boolean(),
          errorDecreases: z.boolean(),
          observedOrder: z.boolean(),
          residualBound: z.boolean(),
          invariants: z.record(z.string().min(1).max(100), z.boolean()),
          stressTests: z.partialRecord(HarnessContract.SimulationStress, z.boolean()),
        })
        .strict(),
      status: z.enum(["passed", "failed"]),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  const State = z
    .object({
      schemaVersion: z.literal(1),
      items: z.record(Hash, Info),
      order: z.array(Hash),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Simulation receipt order must be unique" })
      }
      for (const id of value.order) {
        const receipt = value.items[id]
        if (!receipt) {
          ctx.addIssue({ code: "custom", path: ["order"], message: `Simulation receipt ${id} is missing` })
          continue
        }
        if (receipt.receiptID !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: `Simulation receipt key does not match its ID` })
        }
        const payload = structuredClone(receipt) as Record<string, unknown>
        delete payload.receiptID
        if (digest(payload) !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: `Simulation receipt content hash is invalid` })
        }
      }
      for (const id of Object.keys(value.items)) {
        if (value.order.includes(id)) continue
        ctx.addIssue({
          code: "custom",
          path: ["items", id],
          message: `Simulation receipt is absent from journal order`,
        })
      }
    })
  type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "simulations")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const empty = (): State => ({ schemaVersion: 1, items: {}, order: [] })
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  const normalize = (value: Record<string, number>) =>
    Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)))

  function state(input: Record<string, unknown>) {
    return State.parse(Object.keys(input).length ? input : empty())
  }

  function median(values: number[]) {
    const sorted = values.toSorted((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    if (sorted.length % 2) return sorted[middle]!
    return (sorted[middle - 1]! + sorted[middle]!) / 2
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    const protocol = bound.simulation
    if (!protocol) throw new Error(`No simulator validation protocol is bound to session ${value.sessionID}`)
    if (bound.sessionID !== value.sessionID || bound.runID !== value.runID) {
      throw new Error(`Simulation receipt does not match the bound harness run`)
    }
    if (value.evaluatedAt < bound.createdAt) throw new Error(`Simulation receipt predates the harness contract`)
    if (!same(value.engine, protocol.engine)) throw new Error(`Simulation engine does not match the bound protocol`)
    if (value.problemSHA256 !== protocol.problemSHA256) {
      throw new Error(`Simulation problem does not match the bound protocol`)
    }
    if (!same(value.reference, protocol.reference)) {
      throw new Error(`Simulation reference does not match the bound protocol`)
    }
    if (value.levels.length > protocol.validation.maxLevels) {
      throw new Error(`Simulation receipt exceeds the bound refinement-level limit`)
    }
    const required = protocol.validation.requiredStressTests.toSorted()
    const submitted = value.stressTests.map((item) => item.id).toSorted()
    if (!same(required, submitted)) throw new Error(`Simulation stress tests do not match the bound protocol`)
    const invariantNames = Object.keys(protocol.validation.invariantTolerances).toSorted()
    for (const level of value.levels) {
      if (!same(Object.keys(level.invariants).toSorted(), invariantNames)) {
        throw new Error(`Simulation level ${level.label} does not report every bound invariant`)
      }
    }
    if (value.subject.type === "run" && value.subject.id !== bound.runID) {
      throw new Error(`Run simulation receipt subject does not match the contract run`)
    }
    if (value.subject.type === "candidate") {
      const search = await import("./search").then((module) => module.HarnessSearch.read(value.sessionID))
      const candidate = search.candidates[value.subject.id]
      if (!candidate) throw new Error(`Simulation receipt candidate does not exist in the bound search`)
      if (!same(candidate.artifact, value.subject.artifact)) {
        throw new Error(`Simulation receipt artifact does not match the candidate artifact`)
      }
    }

    const levels = value.levels.map((level) => ({ ...level, invariants: normalize(level.invariants) }))
    const pairs = levels.slice(0, -1).map((level, index) => [level, levels[index + 1]!] as const)
    const resolution = pairs.every(([left, right]) => left.h > right.h)
    const error = pairs.every(([left, right]) => left.error > right.error)
    const orders = pairs
      .map(([left, right]) => Math.log(left.error / right.error) / Math.log(left.h / right.h))
      .filter(Number.isFinite)
    const order = orders.length === pairs.length ? median(orders) : 0
    const invariantChecks = Object.fromEntries(
      invariantNames.map((name) => [
        name,
        levels.every((level) => level.invariants[name]! <= protocol.validation.invariantTolerances[name]!),
      ]),
    )
    const stress = Object.fromEntries(value.stressTests.map((item) => [item.id, item.status === "passed"]))
    const checks = {
      enoughLevels: levels.length >= protocol.validation.minLevels,
      resolutionDecreases: resolution,
      errorDecreases: error,
      observedOrder:
        resolution &&
        error &&
        orders.length === pairs.length &&
        orders.every((value) => value >= protocol.validation.expectedOrder - protocol.validation.orderTolerance),
      residualBound: levels.every((level) => level.residual <= protocol.validation.maxResidual),
      invariants: invariantChecks,
      stressTests: stress,
    }
    const passed =
      checks.enoughLevels &&
      checks.resolutionDecreases &&
      checks.errorDecreases &&
      checks.observedOrder &&
      checks.residualBound &&
      Object.values(checks.invariants).every(Boolean) &&
      Object.values(checks.stressTests).every(Boolean)
    const payload = {
      schemaVersion: 1 as const,
      runID: value.runID,
      sessionID: value.sessionID,
      contractFingerprint: HarnessContract.fingerprint(bound),
      subject: value.subject,
      evaluator: {
        name: bound.benchmark.evaluator,
        version: bound.benchmark.evaluatorVersion!,
        source: bound.benchmark.evaluatorSource!,
      },
      engine: value.engine,
      problemSHA256: value.problemSHA256,
      reference: value.reference,
      validationInputSHA256: value.validationInputSHA256,
      levels,
      observedOrders: orders,
      medianObservedOrder: order,
      stressTests: value.stressTests.toSorted((left, right) => left.id.localeCompare(right.id)),
      checks,
      status: passed ? ("passed" as const) : ("failed" as const),
      evidence: value.evidence.toSorted(),
      evaluatedAt: value.evaluatedAt,
    }
    const receipt = Info.parse({ ...payload, receiptID: digest(payload) })
    await JsonStore.update(file(value.sessionID), (data) => {
      const current = state(data)
      const existing = current.items[receipt.receiptID]
      if (existing) return current
      return State.parse({
        ...current,
        items: { ...current.items, [receipt.receiptID]: receipt },
        order: [...current.order, receipt.receiptID],
      })
    })
    return receipt
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
    candidateID?: string
    requirePassed: boolean
    evaluatedAt: number
  }) {
    const receipt = await read(input.contract.sessionID, input.receiptID)
    if (!receipt) throw new Error(`Simulation receipt ${input.receiptID} does not exist`)
    if (receipt.runID !== input.contract.runID) throw new Error(`Simulation receipt does not match the harness run`)
    if (receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Simulation receipt does not match the immutable harness contract`)
    }
    const type = input.candidateID ? "candidate" : "run"
    const id = input.candidateID ?? input.contract.runID
    if (receipt.subject.type !== type || receipt.subject.id !== id) {
      throw new Error(`Simulation receipt does not match the evaluation subject`)
    }
    if (receipt.evaluatedAt > input.evaluatedAt) {
      throw new Error(`Simulation evaluation predates its referenced validation receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing evaluation requires a passing simulation receipt`)
    }
    return receipt
  }
}
