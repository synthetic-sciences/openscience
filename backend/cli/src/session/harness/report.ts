import path from "path"
import z from "zod"
import { Global } from "@/global"
import { HarnessAdaptation } from "./adaptation"
import { HarnessAutonomy } from "./autonomy"
import { HarnessBlueprint } from "./blueprint"
import { HarnessConfirmation } from "./confirmation"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"
import { HarnessFormal } from "./formal"
import { HarnessMeta } from "./meta"
import { HarnessSearch } from "./search"
import { SessionTrace } from "../trace"

export namespace HarnessReport {
  const Tokens = z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      reasoning: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
      total: z.number().nonnegative(),
    })
    .strict()

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      contractFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      comparisonKey: z.string().regex(/^[a-f0-9]{64}$/),
      benchmark: z
        .object({
          id: z.string().min(1),
          title: z.string().min(1),
          family: HarnessContract.Family,
          version: z.string().min(1),
          taskID: z.string().min(1),
          split: HarnessContract.Split,
        })
        .strict(),
      execution: z
        .object({
          profile: HarnessContract.Profile,
          packs: z.array(z.string()),
          provider: z.string().min(1),
          model: z.string().min(1),
          effort: z.string().optional(),
          intervention: z.enum(["autonomous", "human_reprompted"]),
          autonomy: z
            .object({
              claimedLevel: HarnessContract.AutonomyLevel,
              derivedLevel: HarnessContract.AutonomyLevel.optional(),
              status: z.enum(["passed", "failed", "inconclusive"]).optional(),
            })
            .strict()
            .optional(),
          formal: z
            .object({
              tier: HarnessContract.FormalTier,
              relation: HarnessContract.FormalRelation,
              status: z.enum(["passed", "failed"]).optional(),
              blueprint: HarnessBlueprint.Summary.optional(),
            })
            .strict()
            .optional(),
          seed: z.number().int(),
        })
        .strict(),
      quality: z
        .object({
          source: z.enum(["optimization", "sealed_confirmation"]),
          provisional: z.boolean(),
          status: HarnessEvaluation.Status.optional(),
          metric: z.string().optional(),
          direction: z.enum(["maximize", "minimize", "pass"]),
          score: z.number().finite().optional(),
          target: z.number().finite().optional(),
          targetReached: z.boolean(),
          evaluator: z.string().min(1),
          evaluatorVersion: z.string().optional(),
          simulationReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          integrityReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          evolutionReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          interventionReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          evaluatorAuditReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          semanticReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          replicationReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          auditReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          failureDiscoveryReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          synthesisReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          autonomyReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          proofReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          metaReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          confirmationReceiptID: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          evaluations: z.number().int().nonnegative(),
        })
        .strict(),
      efficiency: z
        .object({
          costUSD: z.number().nonnegative().optional(),
          evaluatorCostUSD: z.number().nonnegative().optional(),
          tokens: Tokens.optional(),
          wallTimeMs: z.number().nonnegative().optional(),
          evaluatorWallTimeMs: z.number().nonnegative().optional(),
          toolCalls: z.number().int().nonnegative().optional(),
          searches: z.number().int().nonnegative().optional(),
          dedupeHits: z.number().int().nonnegative().optional(),
          retries: z.number().int().nonnegative().optional(),
          failures: z.number().int().nonnegative().optional(),
          candidates: z.number().int().nonnegative().optional(),
        })
        .strict(),
      search: z
        .object({
          status: z.enum(["active", "completed"]),
          stopReason: HarnessSearch.Stop.optional(),
          bestID: z.string().optional(),
          candidates: z.number().int().nonnegative(),
          verified: z.number().int().nonnegative(),
          generations: z.number().int().nonnegative(),
          stalled: z.number().int().nonnegative(),
          proposalPolicy: z.enum(["advisory-v2", "leased-v3", "adaptive-v4"]),
          controller: HarnessContract.Search.optional(),
          adaptation: HarnessAdaptation.Summary.optional(),
          objectives: HarnessContract.Objectives,
          objectiveAudit: HarnessContract.ObjectiveAudit.optional(),
          archive: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
      metaHarness: z
        .object({
          status: HarnessEvaluation.Status,
          selectionID: z.string().regex(/^[a-f0-9]{64}$/),
          diagnostics: HarnessMeta.Diagnostics,
          failures: z.array(z.string()),
        })
        .strict()
        .optional(),
      generatedAt: z.number().int().positive(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  export type Trace = Pick<
    SessionTrace.Info["summary"],
    | "cost"
    | "tokens"
    | "totalCompletionTimeMs"
    | "toolCalls"
    | "searchCount"
    | "dedupeHits"
    | "retryCount"
    | "failureCount"
  >

  const root = path.join(Global.Path.data, "harness", "reports")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  const reached = (contract: HarnessContract.Info, result?: { status: HarnessEvaluation.Status; score?: number }) => {
    if (result?.status !== "passed") return false
    if (contract.benchmark.direction === "pass" || contract.benchmark.direction === undefined) return true
    if (result.score === undefined || contract.benchmark.target === undefined) return false
    if (contract.benchmark.direction === "maximize") return result.score >= contract.benchmark.target
    return result.score <= contract.benchmark.target
  }

  const selected = (evaluations: HarnessEvaluation.Info[], search?: HarnessSearch.State) => {
    const best = search?.bestID
      ? evaluations.findLast(
          (item) =>
            item.subject?.type === "candidate" && item.subject.id === search.bestID && HarnessEvaluation.final(item),
        )
      : undefined
    return (
      best ??
      evaluations.findLast((item) => !item.subject && HarnessEvaluation.final(item)) ??
      evaluations.findLast(HarnessEvaluation.final)
    )
  }

  export function compile(input: {
    contract: HarnessContract.Info
    evaluations: HarnessEvaluation.Info[]
    trace?: Trace
    search?: HarnessSearch.State
    meta?: HarnessMeta.Receipt
    confirmation?: HarnessConfirmation.Receipt
    autonomy?: HarnessAutonomy.Receipt
    formal?: HarnessFormal.Receipt
    blueprint?: HarnessBlueprint.Summary
    generatedAt?: number
  }) {
    const contract = HarnessContract.Info.parse(input.contract)
    const evaluations = input.evaluations.map((item) => HarnessEvaluation.Info.parse(item))
    const evaluation = selected(evaluations, input.search)
    const autonomy = input.autonomy ? HarnessAutonomy.Receipt.parse(input.autonomy) : undefined
    if (autonomy && autonomy.receiptID !== evaluation?.autonomyReceiptID) {
      throw new Error(`Human-AI autonomy receipt does not match the selected evaluation`)
    }
    const formal = input.formal ? HarnessFormal.Receipt.parse(input.formal) : undefined
    if (formal && formal.receiptID !== evaluation?.proofReceiptID) {
      throw new Error(`Formal proof receipt does not match the selected evaluation`)
    }
    const blueprint = input.blueprint ? HarnessBlueprint.bind(contract, input.blueprint) : undefined
    const meta = input.meta ? HarnessMeta.bind(contract, input.meta) : undefined
    if (meta && meta.selection.candidateID !== input.search?.bestID) {
      throw new Error(`Meta-harness qualification does not match the selected search winner`)
    }
    const confirmation = input.confirmation ? HarnessConfirmation.binds(contract, input.confirmation) : undefined
    if (confirmation && !contract.confirmation) {
      throw new Error(`A legacy harness report cannot cite sealed confirmation evidence`)
    }
    if (confirmation && contract.metaHarness && meta?.status !== "passed") {
      throw new Error(`A sealed report requires a passing meta-harness qualification`)
    }
    if (confirmation && meta && confirmation.selection.candidateID !== meta.selection.candidateID) {
      throw new Error(`Meta-harness and sealed confirmation receipts select different candidates`)
    }
    const provisional = Boolean(contract.confirmation && !confirmation)
    const result = contract.confirmation ? confirmation : evaluation
    const direction = contract.benchmark.direction ?? "pass"
    const comparisonKey = digest({
      benchmark: contract.benchmark.name,
      version: contract.benchmark.version,
      taskID: contract.benchmark.taskID,
      split: contract.benchmark.split,
      evaluator: contract.benchmark.evaluator,
      evaluatorVersion: contract.benchmark.evaluatorVersion,
      evaluatorSource: contract.benchmark.evaluatorSource,
      fidelities: contract.benchmark.fidelities,
      metric: contract.benchmark.metric,
      direction,
      target: contract.benchmark.target,
      objectives: contract.benchmark.objectives,
      objectiveAudit: contract.benchmark.objectiveAudit,
      packs: (contract.packs ?? []).toSorted(),
      simulation: contract.simulation,
      integrity: contract.integrity,
      evolution: contract.evolution,
      metaHarness: contract.metaHarness,
      interventions: contract.interventions,
      search: contract.search,
      evaluatorAudit: contract.evaluatorAudit,
      semanticAudit: contract.semanticAudit,
      replication: contract.replication,
      audit: contract.audit,
      failureDiscovery: contract.failureDiscovery,
      synthesis: contract.synthesis,
      autonomy: contract.autonomy,
      formalProof: contract.formalProof,
      confirmation: contract.confirmation,
      contamination: contract.contamination,
    })
    const tokens = input.trace
      ? {
          input: input.trace.tokens.input,
          output: input.trace.tokens.output,
          reasoning: input.trace.tokens.reasoning,
          cacheRead: input.trace.tokens.cache.read,
          cacheWrite: input.trace.tokens.cache.write,
          total:
            input.trace.tokens.input +
            input.trace.tokens.output +
            input.trace.tokens.reasoning +
            input.trace.tokens.cache.read +
            input.trace.tokens.cache.write,
        }
      : undefined
    const candidates = input.search ? Object.values(input.search.candidates) : []
    const costs = [
      ...evaluations.flatMap((item) => (item.usage?.costUSD === undefined ? [] : [item.usage.costUSD])),
      ...(confirmation?.usage?.costUSD === undefined ? [] : [confirmation.usage.costUSD]),
    ]
    const walls = [
      ...evaluations.flatMap((item) => (item.usage?.wallTimeMs === undefined ? [] : [item.usage.wallTimeMs])),
      ...(confirmation?.usage?.wallTimeMs === undefined ? [] : [confirmation.usage.wallTimeMs]),
    ]
    const evaluatorCostUSD = costs.length ? costs.reduce((sum, value) => sum + value, 0) : undefined
    const evaluatorWallTimeMs = walls.length ? walls.reduce((sum, value) => sum + value, 0) : undefined
    const costUSD =
      input.trace?.cost === undefined && evaluatorCostUSD === undefined
        ? undefined
        : (input.trace?.cost ?? 0) + (evaluatorCostUSD ?? 0)
    const wallTimeMs =
      input.trace?.totalCompletionTimeMs === undefined && evaluatorWallTimeMs === undefined
        ? undefined
        : (input.trace?.totalCompletionTimeMs ?? 0) + (evaluatorWallTimeMs ?? 0)
    return Info.parse({
      schemaVersion: 1,
      runID: contract.runID,
      sessionID: contract.sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      comparisonKey,
      benchmark: {
        id: contract.benchmark.name,
        title: contract.benchmark.title,
        family: contract.benchmark.family,
        version: contract.benchmark.version,
        taskID: contract.benchmark.taskID,
        split: contract.benchmark.split,
      },
      execution: {
        profile: contract.profile,
        packs: contract.packs ?? [],
        provider: contract.model.provider,
        model: contract.model.name,
        effort: contract.model.effort,
        intervention: contract.intervention,
        autonomy: contract.autonomy
          ? {
              claimedLevel: contract.autonomy.claimedLevel,
              derivedLevel: autonomy?.derivedLevel,
              status: autonomy?.status,
            }
          : undefined,
        formal: contract.formalProof
          ? {
              tier: contract.formalProof.tier,
              relation: contract.formalProof.relation,
              status: formal?.status,
              blueprint,
            }
          : undefined,
        seed: contract.seed,
      },
      quality: {
        source: contract.confirmation ? "sealed_confirmation" : "optimization",
        provisional,
        status: result?.status,
        metric: contract.benchmark.metric,
        direction,
        score: result?.score,
        target: contract.benchmark.target,
        targetReached: reached(contract, result),
        evaluator: contract.confirmation?.claim.evaluator.name ?? contract.benchmark.evaluator,
        evaluatorVersion: contract.confirmation?.claim.evaluator.version ?? contract.benchmark.evaluatorVersion,
        simulationReceiptID: contract.confirmation ? undefined : evaluation?.simulationReceiptID,
        integrityReceiptID: contract.confirmation ? undefined : evaluation?.integrityReceiptID,
        evolutionReceiptID: contract.confirmation ? undefined : evaluation?.evolutionReceiptID,
        interventionReceiptID: contract.confirmation ? undefined : evaluation?.interventionReceiptID,
        evaluatorAuditReceiptID: contract.confirmation ? undefined : evaluation?.evaluatorAuditReceiptID,
        semanticReceiptID: contract.confirmation ? undefined : evaluation?.semanticReceiptID,
        replicationReceiptID: contract.confirmation ? undefined : evaluation?.replicationReceiptID,
        auditReceiptID: contract.confirmation ? undefined : evaluation?.auditReceiptID,
        failureDiscoveryReceiptID: contract.confirmation ? undefined : evaluation?.failureDiscoveryReceiptID,
        synthesisReceiptID: contract.confirmation ? undefined : evaluation?.synthesisReceiptID,
        autonomyReceiptID: evaluation?.autonomyReceiptID,
        proofReceiptID: evaluation?.proofReceiptID,
        metaReceiptID: meta?.receiptID,
        confirmationReceiptID: confirmation?.receiptID,
        evaluations: evaluations.length,
      },
      efficiency: {
        costUSD,
        evaluatorCostUSD,
        tokens,
        wallTimeMs,
        evaluatorWallTimeMs,
        toolCalls: input.trace?.toolCalls,
        searches: input.trace?.searchCount,
        dedupeHits: input.trace?.dedupeHits,
        retries: input.trace?.retryCount,
        failures: input.trace?.failureCount,
        candidates: input.search ? candidates.length : undefined,
      },
      search: input.search
        ? {
            status: input.search.status,
            stopReason: input.search.stopReason,
            bestID: input.search.bestID,
            candidates: candidates.length,
            verified: candidates.filter((item) => item.result?.source === "verified").length,
            generations: Math.max(0, ...candidates.map((item) => item.generation)),
            stalled: input.search.stalled,
            proposalPolicy: input.search.proposalPolicy,
            controller: input.search.controller,
            adaptation:
              input.search.proposalPolicy === "adaptive-v4" ? HarnessSearch.adaptation(input.search) : undefined,
            objectives: input.search.objectives,
            objectiveAudit: contract.benchmark.objectiveAudit,
            archive: HarnessSearch.frontier(input.search).length,
          }
        : undefined,
      metaHarness: meta
        ? {
            status: meta.status,
            selectionID: meta.selection.selectionID,
            diagnostics: meta.diagnostics,
            failures: meta.failures,
          }
        : undefined,
      generatedAt: input.generatedAt ?? Date.now(),
    })
  }

  export async function build(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    const [evaluations, trace, search, meta, confirmation, blueprint] = await Promise.all([
      HarnessEvaluation.list(sessionID),
      SessionTrace.build(sessionID),
      HarnessSearch.read(sessionID).catch(() => undefined),
      HarnessMeta.current(contract),
      HarnessConfirmation.current(contract),
      contract.formalProof?.blueprint
        ? HarnessBlueprint.read(sessionID)
            .then((value) => value.summary)
            .catch(() => undefined)
        : undefined,
    ])
    const evaluation = selected(evaluations, search ?? undefined)
    const autonomy = evaluation?.autonomyReceiptID
      ? await HarnessAutonomy.read(evaluation.autonomyReceiptID, contract)
      : undefined
    const formal = evaluation?.proofReceiptID
      ? await HarnessFormal.read(evaluation.proofReceiptID, contract)
      : undefined
    const report = compile({
      contract,
      evaluations,
      trace: trace.summary,
      search,
      meta: meta ?? undefined,
      confirmation: confirmation ?? undefined,
      autonomy,
      formal,
      blueprint,
    })
    await Bun.write(file(sessionID), JSON.stringify(report, null, 2) + "\n")
    return report
  }

  function score(left: Info, right: Info) {
    if (left.quality.status === "passed" && right.quality.status !== "passed") return 1
    if (left.quality.status !== "passed" && right.quality.status === "passed") return -1
    if (left.quality.direction === "pass") return 0
    if (left.quality.score === undefined || right.quality.score === undefined) return 0
    const delta = left.quality.score - right.quality.score
    return left.quality.direction === "maximize" ? delta : -delta
  }

  export function dominates(left: Info, right: Info) {
    const a = Info.parse(left)
    const b = Info.parse(right)
    if (a.comparisonKey !== b.comparisonKey) return false
    if (a.quality.provisional || b.quality.provisional) return false
    if (a.quality.status !== "passed") return false
    const quality = score(a, b)
    if (quality < 0) return false
    const pairs = [
      [a.efficiency.costUSD, b.efficiency.costUSD],
      [a.efficiency.tokens?.total, b.efficiency.tokens?.total],
      [a.efficiency.wallTimeMs, b.efficiency.wallTimeMs],
    ].filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined)
    if (pairs.some(([x, y]) => x > y)) return false
    return quality > 0 || pairs.some(([x, y]) => x < y)
  }

  export function frontier(input: Info[]) {
    const reports = input.map((item) => Info.parse(item))
    return reports.filter(
      (item) =>
        !item.quality.provisional && !reports.some((other) => other.runID !== item.runID && dominates(other, item)),
    )
  }

  export function compare(input: Info[], baselineRunID: string) {
    const reports = input.map((item) => Info.parse(item))
    const baseline = reports.find((item) => item.runID === baselineRunID)
    if (!baseline) throw new Error(`Unknown baseline run ${baselineRunID}`)
    if (reports.some((item) => item.quality.provisional)) {
      throw new Error(`Provisional optimization results cannot enter final quality-cost comparison`)
    }
    if (reports.some((item) => item.comparisonKey !== baseline.comparisonKey)) {
      throw new Error(`Quality-cost reports are only comparable under the same benchmark contract key`)
    }
    const pareto = new Set(frontier(reports).map((item) => item.runID))
    return reports.map((item) => ({
      runID: item.runID,
      scoreImprovement:
        item.quality.score === undefined || baseline.quality.score === undefined
          ? undefined
          : item.quality.direction === "minimize"
            ? baseline.quality.score - item.quality.score
            : item.quality.score - baseline.quality.score,
      costDelta:
        item.efficiency.costUSD === undefined || baseline.efficiency.costUSD === undefined
          ? undefined
          : item.efficiency.costUSD - baseline.efficiency.costUSD,
      tokenDelta:
        item.efficiency.tokens === undefined || baseline.efficiency.tokens === undefined
          ? undefined
          : item.efficiency.tokens.total - baseline.efficiency.tokens.total,
      wallTimeDelta:
        item.efficiency.wallTimeMs === undefined || baseline.efficiency.wallTimeMs === undefined
          ? undefined
          : item.efficiency.wallTimeMs - baseline.efficiency.wallTimeMs,
      pareto: pareto.has(item.runID),
    }))
  }
}
