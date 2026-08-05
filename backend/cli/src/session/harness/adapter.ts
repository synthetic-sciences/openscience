import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { timingSafeEqual } from "@/util/timing-safe"
import { HarnessBenchmark } from "./benchmark"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"
import { HarnessMemory } from "./memory"
import { HarnessPack } from "./pack"
import { HarnessRecipe } from "./recipe"
import { HarnessSearch } from "./search"

export namespace HarnessAdapter {
  const Token = z.string().min(32).max(1_024)

  export const Task = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      benchmark: z.string().min(1).max(120),
      version: z.string().min(1).max(120),
      taskID: z.string().min(1).max(500),
      split: HarnessContract.Split,
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "external"]),
          token: Token,
        })
        .strict(),
      objective: z.string().min(1).max(4_000),
      profile: HarnessContract.Profile.optional(),
      orchestration: HarnessContract.Orchestration.optional(),
      audit: HarnessContract.Audit.optional(),
      launch: HarnessContract.Launch.optional(),
      recipe: HarnessRecipe.Selection.optional(),
      integrity: HarnessContract.Integrity.optional(),
      simulation: HarnessContract.Simulation.optional(),
      evaluatorAudit: z
        .object({
          protocol: HarnessContract.EvaluatorAudit,
          token: Token,
        })
        .strict()
        .optional(),
      extraPacks: z
        .array(HarnessPack.Id)
        .max(HarnessPack.Id.options.length)
        .refine((items) => new Set(items).size === items.length, "Extra harness packs must be unique")
        .default([]),
      metric: z
        .object({
          name: z.string().min(1).max(200).optional(),
          direction: z.enum(["maximize", "minimize", "pass"]),
          target: z.number().finite().optional(),
        })
        .strict()
        .default({ direction: "pass" }),
      objectives: HarnessContract.Objectives.optional(),
      objectiveAudit: HarnessContract.ObjectiveAudit.optional(),
      fidelities: HarnessContract.FidelityPlan.optional(),
      model: z
        .object({
          provider: z.string().min(1),
          name: z.string().min(1),
          effort: z.string().min(1).optional(),
        })
        .strict(),
      tools: z.array(z.string().min(1)).max(256).default([]),
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
        .max(256)
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
          policy: z.string().min(1).max(2_000),
          hiddenTestsAccessible: z.literal(false),
          publicDataCutoff: z.string().min(1).max(120).optional(),
        })
        .strict(),
      createdAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if ((value.split === "held_out" || value.split === "release") && !value.launch) {
        ctx.addIssue({
          code: "custom",
          path: ["launch"],
          message: "Held-out and release runs require a pinned official benchmark launch protocol",
        })
      }
      if (value.recipe && !value.launch) {
        ctx.addIssue({ code: "custom", path: ["recipe"], message: "A benchmark recipe requires a launch protocol" })
      }
      if (value.evaluatorAudit && value.evaluatorAudit.token === value.evaluator.token) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorAudit", "token"],
          message: "Evaluator and independent auditor capabilities must differ",
        })
      }
      if (Boolean(value.objectives?.length) !== Boolean(value.objectiveAudit)) {
        ctx.addIssue({
          code: "custom",
          path: ["objectiveAudit"],
          message: "Secondary objectives require exactly one preflighted objective audit",
        })
      }
    })

  export type Task = z.input<typeof Task>

  export const Evaluation = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      candidateID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      stage: z.string().min(1).max(100).optional(),
      simulationReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      launchReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      integrityReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      evaluatorAuditReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "An evaluation may contain at most 128 metrics")
        .default({}),
      checks: z.array(HarnessEvaluation.Check).min(1).max(128),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      usage: HarnessEvaluation.Usage.optional(),
      evaluatedAt: z.number().int().positive(),
      notes: z.string().max(8_000).optional(),
    })
    .strict()
  export type Evaluation = z.input<typeof Evaluation>

  const Binding = z
    .object({
      schemaVersion: z.literal(1),
      sessionID: z.string().min(1),
      runID: z.string().min(1),
      contractFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      tokenSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      evaluator: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["benchmark", "gate", "external"]),
        })
        .strict(),
      auditor: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["benchmark", "gate", "human", "external"]),
          tokenSHA256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  type Binding = z.infer<typeof Binding>

  const root = path.join(Global.Path.data, "harness", "bindings")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
  const repository = (value: string) =>
    value
      .trim()
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "")

  async function credential(sessionID: string): Promise<Binding> {
    const data = await JsonStore.read(file(sessionID))
    const parsed = Binding.safeParse(data)
    if (!parsed.success) throw new Error(`No evaluator capability is bound to session ${sessionID}`)
    return parsed.data
  }

  export async function authorize(sessionID: string, token: string) {
    const [contract, binding] = await Promise.all([HarnessContract.read(sessionID), credential(sessionID)])
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    if (binding.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Evaluator capability does not match the bound harness contract`)
    }
    if (!timingSafeEqual(binding.tokenSHA256, digest(Token.parse(token)))) {
      throw new Error(`Evaluator capability was rejected`)
    }
    return contract
  }

  export async function authorizeAuditor(sessionID: string, token: string) {
    const [contract, binding] = await Promise.all([HarnessContract.read(sessionID), credential(sessionID)])
    if (!contract || !contract.evaluatorAudit || !binding.auditor) {
      throw new Error(`No independent evaluator auditor is bound to session ${sessionID}`)
    }
    if (binding.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Evaluator auditor capability does not match the bound harness contract`)
    }
    if (!timingSafeEqual(binding.auditor.tokenSHA256, digest(Token.parse(token)))) {
      throw new Error(`Evaluator auditor capability was rejected`)
    }
    const auditor = contract.evaluatorAudit.auditor
    if (
      binding.auditor.name !== auditor.name ||
      binding.auditor.version !== auditor.version ||
      binding.auditor.source !== auditor.source
    ) {
      throw new Error(`Evaluator auditor identity does not match the bound harness contract`)
    }
    return contract
  }

  export async function bind(input: Task) {
    const task = Task.parse(input)
    const benchmark = HarnessBenchmark.resolve(task.benchmark)
    const recipe = task.recipe ? HarnessRecipe.materialize(benchmark.id, task.recipe) : undefined
    const profile = task.profile ?? benchmark.profile
    if (!benchmark.profiles.includes(profile)) {
      throw new Error(`Profile ${profile} is not valid for the ${benchmark.id} adapter`)
    }
    if (task.metric.direction !== "pass" && !task.metric.name) {
      throw new Error(`A ${task.metric.direction} benchmark must declare its metric name`)
    }
    if (profile === "optimize" && task.budget.candidates === undefined) {
      throw new Error(`An optimize benchmark must declare a candidate budget`)
    }
    if (benchmark.source.status === "official_subset" && (task.split === "held_out" || task.split === "release")) {
      throw new Error(
        `${benchmark.title} exposes only ${benchmark.source.publicTasks} public tasks and cannot represent the ${benchmark.source.totalTasks}-task hidden benchmark`,
      )
    }
    if (
      benchmark.recipe.status === "blocked_upstream" &&
      (task.split === "held_out" || task.split === "release" || task.launch)
    ) {
      throw new Error(`${benchmark.title} is blocked at ${benchmark.recipe.anchor}: ${benchmark.recipe.reason}`)
    }
    if (
      benchmark.recipe.status === "source_verified" &&
      (task.split === "held_out" || task.split === "release") &&
      !recipe
    ) {
      throw new Error(`Held-out and release runs for ${benchmark.title} require its source-verified execution recipe`)
    }
    if (task.launch && benchmark.source.status !== "methodology_only") {
      if (
        repository(task.launch.runner.repository) !== repository(benchmark.source.repository) ||
        task.launch.runner.revision !== benchmark.source.revision
      ) {
        throw new Error(`Benchmark launch does not match the catalog-pinned official source revision`)
      }
      if (benchmark.source.dataset && repository(task.launch.dataset.source) !== repository(benchmark.source.dataset)) {
        throw new Error(`Benchmark launch does not match the catalog-pinned official dataset source`)
      }
    }
    if (
      recipe &&
      (task.launch?.runner.entrypoint !== recipe.entrypoint ||
        task.launch.runner.recipeSHA256 !== recipe.recipeSHA256 ||
        task.launch.runner.driverSHA256 !== recipe.driverSHA256)
    ) {
      throw new Error(`Benchmark launch does not match the materialized source-verified native driver`)
    }
    const packs = [...benchmark.packs, ...task.extraPacks].filter((pack, index, items) => items.indexOf(pack) === index)
    if (task.simulation && !packs.some((pack) => ["physics", "pde", "chemistry"].includes(pack))) {
      throw new Error(`A simulator validation contract requires a physics, PDE, or chemistry verification pack`)
    }
    const contract = HarnessContract.Info.parse({
      schemaVersion: 1,
      runID: task.runID,
      sessionID: task.sessionID,
      objective: task.objective,
      benchmark: {
        name: benchmark.id,
        version: task.version,
        taskID: task.taskID,
        split: task.split,
        evaluator: task.evaluator.name,
        evaluatorVersion: task.evaluator.version,
        evaluatorSource: task.evaluator.source,
        fidelities: task.fidelities,
        metric: task.metric.name,
        direction: task.metric.direction,
        target: task.metric.target,
        objectives: task.objectives,
        objectiveAudit: task.objectiveAudit,
      },
      profile,
      orchestration: task.orchestration,
      audit: task.audit,
      launch: task.launch,
      recipe,
      integrity: task.integrity,
      simulation: task.simulation,
      evaluatorAudit: task.evaluatorAudit?.protocol,
      packs,
      model: task.model,
      tools: task.tools,
      skills: task.skills,
      budget: task.budget,
      seed: task.seed,
      intervention: task.intervention,
      contamination: task.contamination,
      createdAt: task.createdAt,
    })
    await HarnessContract.bind(contract)
    const binding = Binding.parse({
      schemaVersion: 1,
      sessionID: task.sessionID,
      runID: task.runID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      tokenSHA256: digest(task.evaluator.token),
      evaluator: {
        name: task.evaluator.name,
        version: task.evaluator.version,
        source: task.evaluator.source,
      },
      auditor: task.evaluatorAudit
        ? {
            ...task.evaluatorAudit.protocol.auditor,
            tokenSHA256: digest(task.evaluatorAudit.token),
          }
        : undefined,
      createdAt: task.createdAt,
    })
    await JsonStore.update(file(task.sessionID), (data) => {
      if (!Object.keys(data).length) return binding
      const current = Binding.parse(data)
      if (JSON.stringify(current) === JSON.stringify(binding)) return current
      throw new Error(`Evaluator capability for session ${task.sessionID} is immutable once bound`)
    })
    return contract
  }

  export async function ingest(input: Evaluation) {
    const value = Evaluation.parse(input)
    const [contract, binding] = await Promise.all([
      authorize(value.sessionID, value.evaluatorToken),
      credential(value.sessionID),
    ])
    if (contract.runID !== value.runID || binding.runID !== value.runID) {
      throw new Error(`Evaluation does not match the bound harness run`)
    }
    if (value.evaluatedAt < contract.createdAt) {
      throw new Error(`Evaluation predates the bound harness contract`)
    }
    const fidelity = (() => {
      if (!contract.benchmark.fidelities && value.stage === undefined) return undefined
      if (!contract.benchmark.fidelities) throw new Error(`Evaluation stage is not declared by the contract`)
      if (!value.stage) throw new Error(`Evaluation must name a fidelity stage`)
      const stage = contract.benchmark.fidelities.find((item) => item.id === value.stage)
      if (!stage) throw new Error(`Evaluation fidelity stage is not in the bound contract`)
      return { stage: stage.id, final: stage.final }
    })()
    const stage = value.stage ? contract.benchmark.fidelities?.find((item) => item.id === value.stage) : undefined
    if (stage?.maxWallTimeMs !== undefined && value.usage?.wallTimeMs === undefined) {
      throw new Error(`Evaluation stage ${stage.id} must report wall-time usage`)
    }
    if (stage?.maxCostUSD !== undefined && value.usage?.costUSD === undefined) {
      throw new Error(`Evaluation stage ${stage.id} must report cost usage`)
    }
    const wall = value.usage?.wallTimeMs
    const cost = value.usage?.costUSD
    if (stage?.maxWallTimeMs !== undefined && wall !== undefined && wall > stage.maxWallTimeMs) {
      throw new Error(`Evaluation stage ${stage.id} exceeded its wall-time budget`)
    }
    if (stage?.maxCostUSD !== undefined && cost !== undefined && cost > stage.maxCostUSD) {
      throw new Error(`Evaluation stage ${stage.id} exceeded its cost budget`)
    }
    const metric = contract.benchmark.metric
    if (
      value.status === "passed" &&
      contract.benchmark.direction !== "pass" &&
      (value.score === undefined || metric === undefined || value.metrics[metric] === undefined)
    ) {
      throw new Error(`A passing numeric benchmark evaluation must report its bound score and metric`)
    }
    if (metric !== undefined && value.score !== undefined && value.metrics[metric] !== value.score) {
      throw new Error(`Evaluation score does not match the bound ${metric} metric`)
    }
    if (value.status === "passed" && fidelity?.final !== false) {
      const missing = contract.benchmark.objectives?.find((item) => value.metrics[item.metric] === undefined)
      if (missing) throw new Error(`Passing evaluation is missing declared objective metric ${missing.metric}`)
    }
    if (value.candidateID) {
      const search = await HarnessSearch.read(value.sessionID)
      if (search.runID !== value.runID || !search.candidates[value.candidateID]) {
        throw new Error(`Evaluation candidate does not exist in the bound search`)
      }
    }
    const evaluation = HarnessEvaluation.Info.parse({
      schemaVersion: 1,
      runID: value.runID,
      sessionID: value.sessionID,
      subject: value.candidateID ? { type: "candidate", id: value.candidateID } : undefined,
      fidelity,
      simulationReceiptID: value.simulationReceiptID,
      launchReceiptID: value.launchReceiptID,
      integrityReceiptID: value.integrityReceiptID,
      evaluatorAuditReceiptID: value.evaluatorAuditReceiptID,
      evaluator: binding.evaluator,
      status: value.status,
      score: value.score,
      metrics: value.metrics,
      checks: value.checks,
      evidence: value.evidence,
      usage: value.usage,
      evaluatedAt: value.evaluatedAt,
      notes: value.notes,
    })
    const recorded = await HarnessEvaluation.record(evaluation)
    if (!value.candidateID) return { evaluation: recorded }
    if (fidelity?.final === false) {
      const search = await HarnessSearch.screen({
        sessionID: value.sessionID,
        candidateID: value.candidateID,
        evaluation: recorded,
      })
      return { evaluation: recorded, search }
    }
    const search = await HarnessSearch.verify({ sessionID: value.sessionID, candidateID: value.candidateID })
    const memory = await HarnessMemory.capture({
      sessionID: value.sessionID,
      candidateID: value.candidateID,
      stage: "evaluation",
    })
    return { evaluation: recorded, search, memory }
  }
}
