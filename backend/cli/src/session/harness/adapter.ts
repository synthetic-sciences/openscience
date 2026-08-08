import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { timingSafeEqual } from "@/util/timing-safe"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"
import { HarnessDomain } from "./domain"
import { HarnessMemory } from "./memory"
import { HarnessPack } from "./pack"
import { HarnessSearch } from "./search"
import { HarnessWorld } from "./world"

export namespace HarnessAdapter {
  const Token = z.string().min(32).max(1_024)

  export const Task = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      benchmark: z.string().min(1).max(120),
      title: z.string().min(1).max(240).optional(),
      family: HarnessContract.Family.default("custom"),
      task: z.string().min(1).max(4_000).optional(),
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
      search: z.enum(["adaptive", "static"]).optional(),
      orchestration: HarnessContract.Orchestration.optional(),
      audit: HarnessContract.Audit.optional(),
      failureDiscovery: HarnessContract.FailureDiscovery.optional(),
      integrity: HarnessContract.Integrity.optional(),
      evolution: HarnessContract.Evolution.optional(),
      metaHarness: z
        .object({
          protocol: HarnessContract.MetaHarness,
          token: Token,
        })
        .strict()
        .optional(),
      interventions: HarnessContract.Interventions.optional(),
      simulation: HarnessContract.Simulation.optional(),
      evaluatorAudit: z
        .object({
          protocol: HarnessContract.EvaluatorAudit,
          token: Token,
        })
        .strict()
        .optional(),
      semanticAudit: z
        .object({
          protocol: HarnessContract.SemanticAudit,
          token: Token,
        })
        .strict()
        .optional(),
      synthesis: HarnessContract.ScientificSynthesis.optional(),
      autonomy: HarnessContract.HumanAIAutonomy.optional(),
      formalProof: HarnessContract.FormalProof.optional(),
      replication: HarnessContract.Replication.optional(),
      confirmation: z
        .object({
          protocol: HarnessContract.Confirmation,
          token: Token,
        })
        .strict()
        .optional(),
      packs: z
        .array(HarnessPack.Id)
        .max(HarnessPack.Id.options.length)
        .refine((items) => new Set(items).size === items.length, "Harness packs must be unique")
        .optional(),
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
      if (value.evaluatorAudit && value.evaluatorAudit.token === value.evaluator.token) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorAudit", "token"],
          message: "Evaluator and independent auditor capabilities must differ",
        })
      }
      if (value.semanticAudit && value.semanticAudit.token === value.evaluator.token) {
        ctx.addIssue({
          code: "custom",
          path: ["semanticAudit", "token"],
          message: "Evaluator and semantic reviewer capabilities must differ",
        })
      }
      if (value.semanticAudit && value.evaluatorAudit && value.semanticAudit.token === value.evaluatorAudit.token) {
        ctx.addIssue({
          code: "custom",
          path: ["semanticAudit", "token"],
          message: "Evaluator auditor and semantic reviewer capabilities must differ",
        })
      }
      if (value.confirmation && value.confirmation.token === value.evaluator.token) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation", "token"],
          message: "Optimization and claim evaluator capabilities must differ",
        })
      }
      if (value.metaHarness && value.metaHarness.token === value.evaluator.token) {
        ctx.addIssue({
          code: "custom",
          path: ["metaHarness", "token"],
          message: "Optimization evaluator and meta-harness qualifier capabilities must differ",
        })
      }
      if (value.metaHarness && value.evaluatorAudit && value.metaHarness.token === value.evaluatorAudit.token) {
        ctx.addIssue({
          code: "custom",
          path: ["metaHarness", "token"],
          message: "Evaluator auditor and meta-harness qualifier capabilities must differ",
        })
      }
      if (value.metaHarness && value.semanticAudit && value.metaHarness.token === value.semanticAudit.token) {
        ctx.addIssue({
          code: "custom",
          path: ["metaHarness", "token"],
          message: "Semantic reviewer and meta-harness qualifier capabilities must differ",
        })
      }
      if (value.metaHarness && value.confirmation && value.metaHarness.token === value.confirmation.token) {
        ctx.addIssue({
          code: "custom",
          path: ["metaHarness", "token"],
          message: "Claim evaluator and meta-harness qualifier capabilities must differ",
        })
      }
      if (value.confirmation && value.evaluatorAudit && value.confirmation.token === value.evaluatorAudit.token) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation", "token"],
          message: "Claim evaluator and independent auditor capabilities must differ",
        })
      }
      if (value.confirmation && value.semanticAudit && value.confirmation.token === value.semanticAudit.token) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation", "token"],
          message: "Claim evaluator and semantic reviewer capabilities must differ",
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
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "An evaluation may contain at most 128 metrics")
        .default({}),
      checks: z.array(HarnessEvaluation.Check).max(128),
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
      semantic: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["gate", "human", "external"]),
          tokenSHA256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
      meta: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          promptSHA256: z.string().regex(/^[a-f0-9]{64}$/),
          configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
          tokenSHA256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
      confirmation: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["benchmark", "gate", "external"]),
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

  export async function authorizeSemantic(sessionID: string, token: string) {
    const [contract, binding] = await Promise.all([HarnessContract.read(sessionID), credential(sessionID)])
    if (!contract || !contract.semanticAudit || !binding.semantic) {
      throw new Error(`No independent semantic reviewer is bound to session ${sessionID}`)
    }
    if (binding.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Semantic reviewer capability does not match the bound harness contract`)
    }
    if (!timingSafeEqual(binding.semantic.tokenSHA256, digest(Token.parse(token)))) {
      throw new Error(`Semantic reviewer capability was rejected`)
    }
    if (
      JSON.stringify(binding.semantic) !==
      JSON.stringify({
        ...contract.semanticAudit.reviewer,
        tokenSHA256: binding.semantic.tokenSHA256,
      })
    ) {
      throw new Error(`Semantic reviewer identity does not match the bound harness contract`)
    }
    return contract
  }

  export async function authorizeConfirmation(sessionID: string, token: string) {
    const [contract, binding] = await Promise.all([HarnessContract.read(sessionID), credential(sessionID)])
    if (!contract?.confirmation || !binding.confirmation) {
      throw new Error(`No sealed claim evaluator is bound to session ${sessionID}`)
    }
    if (binding.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Claim evaluator capability does not match the bound harness contract`)
    }
    if (!timingSafeEqual(binding.confirmation.tokenSHA256, digest(Token.parse(token)))) {
      throw new Error(`Claim evaluator capability was rejected`)
    }
    if (
      JSON.stringify(binding.confirmation) !==
      JSON.stringify({
        ...contract.confirmation.claim.evaluator,
        tokenSHA256: binding.confirmation.tokenSHA256,
      })
    ) {
      throw new Error(`Claim evaluator identity does not match the bound harness contract`)
    }
    return contract
  }

  export async function authorizeMeta(sessionID: string, token: string) {
    const [contract, binding] = await Promise.all([HarnessContract.read(sessionID), credential(sessionID)])
    if (!contract?.metaHarness || !binding.meta) {
      throw new Error(`No meta-harness qualifier is bound to session ${sessionID}`)
    }
    if (binding.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Meta-harness qualifier capability does not match the bound harness contract`)
    }
    if (!timingSafeEqual(binding.meta.tokenSHA256, digest(Token.parse(token)))) {
      throw new Error(`Meta-harness qualifier capability was rejected`)
    }
    if (
      JSON.stringify(binding.meta) !==
      JSON.stringify({
        ...contract.metaHarness.judge,
        tokenSHA256: binding.meta.tokenSHA256,
      })
    ) {
      throw new Error(`Meta-harness qualifier identity does not match the bound harness contract`)
    }
    return contract
  }

  export async function bind(input: Task) {
    const task = Task.parse(input)
    const search =
      task.search === "adaptive" ||
      task.evolution !== undefined ||
      task.metaHarness !== undefined ||
      task.interventions !== undefined ||
      task.confirmation !== undefined ||
      (task.budget.candidates !== undefined && task.metric.direction !== "pass")
    const profile = task.profile ?? (search ? "optimize" : task.simulation ? "numerical" : "react")
    if (task.metric.direction !== "pass" && !task.metric.name) {
      throw new Error(`A ${task.metric.direction} evaluation must declare its metric name`)
    }
    if (profile === "optimize" && task.budget.candidates === undefined) {
      throw new Error(`An optimize run must declare a candidate budget`)
    }
    if (task.search && profile !== "optimize") {
      throw new Error(`A search policy selection requires the optimize profile`)
    }
    const family: Record<HarnessContract.Family, HarnessPack.Id[]> = {
      data: ["statistics"],
      biology: ["statistics", "biology"],
      physics: ["physics"],
      chemistry: ["chemistry"],
      ml: ["ml"],
      generalist: [],
      custom: [],
    }
    const agent =
      task.family === "biology"
        ? "biology"
        : task.family === "physics"
          ? "physics"
          : task.family === "ml"
            ? "ml"
            : "research"
    const recommended = HarnessDomain.recommend({
      agent,
      profile,
      text: `${task.benchmark} ${task.title ?? ""} ${task.task ?? ""} ${task.objective}`,
    })
    const packs = [
      ...(task.packs ?? family[task.family]),
      ...recommended,
      ...(task.formalProof ? (["formal"] as const) : []),
    ].filter((pack, index, items) => items.indexOf(pack) === index)
    if (task.simulation && !packs.some((pack) => ["physics", "pde", "chemistry"].includes(pack))) {
      throw new Error(`A simulator validation contract requires a physics, PDE, or chemistry verification pack`)
    }
    const contract = HarnessContract.Info.parse({
      schemaVersion: 1,
      runID: task.runID,
      sessionID: task.sessionID,
      objective: task.objective,
      benchmark: {
        name: task.benchmark,
        title: task.title ?? task.benchmark,
        family: task.family,
        task: task.task ?? task.objective,
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
      search:
        profile === "optimize" && task.metric.name && task.metric.direction !== "pass" && task.search !== "static"
          ? HarnessContract.adaptiveSearch
          : undefined,
      audit: task.audit,
      failureDiscovery: task.failureDiscovery,
      integrity: task.integrity,
      evolution: task.evolution,
      metaHarness: task.metaHarness?.protocol,
      interventions: task.interventions,
      simulation: task.simulation,
      evaluatorAudit: task.evaluatorAudit?.protocol,
      semanticAudit: task.semanticAudit?.protocol,
      synthesis: task.synthesis,
      autonomy: task.autonomy,
      formalProof: task.formalProof,
      replication: task.replication,
      confirmation: task.confirmation?.protocol,
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
      semantic: task.semanticAudit
        ? {
            ...task.semanticAudit.protocol.reviewer,
            tokenSHA256: digest(task.semanticAudit.token),
          }
        : undefined,
      meta: task.metaHarness
        ? {
            ...task.metaHarness.protocol.judge,
            tokenSHA256: digest(task.metaHarness.token),
          }
        : undefined,
      confirmation: task.confirmation
        ? {
            ...task.confirmation.protocol.claim.evaluator,
            tokenSHA256: digest(task.confirmation.token),
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
      integrityReceiptID: value.integrityReceiptID,
      evolutionReceiptID: value.evolutionReceiptID,
      interventionReceiptID: value.interventionReceiptID,
      evaluatorAuditReceiptID: value.evaluatorAuditReceiptID,
      semanticReceiptID: value.semanticReceiptID,
      replicationReceiptID: value.replicationReceiptID,
      auditReceiptID: value.auditReceiptID,
      failureDiscoveryReceiptID: value.failureDiscoveryReceiptID,
      synthesisReceiptID: value.synthesisReceiptID,
      autonomyReceiptID: value.autonomyReceiptID,
      proofReceiptID: value.proofReceiptID,
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
    await HarnessWorld.event({
      sessionID: value.sessionID,
      type:
        value.status === "failed"
          ? "failure"
          : value.status === "passed" && HarnessEvaluation.final(recorded)
            ? "milestone"
            : "evaluation",
      summary: `${value.status} evaluation recorded for ${value.candidateID ?? value.runID}`,
      evidenceRefs: value.evidence,
      changed: true,
    }).catch(() => undefined)
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
