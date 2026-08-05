import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessPack } from "./pack"
import { HarnessRecipe } from "./recipe"

export namespace HarnessContract {
  export const Profile = z.enum(["react", "optimize", "reproduce", "theory", "numerical", "training", "forecast"])
  export type Profile = z.infer<typeof Profile>

  export const Objective = z
    .object({
      metric: z.string().min(1).max(200),
      direction: z.enum(["maximize", "minimize"]),
    })
    .strict()
  export type Objective = z.infer<typeof Objective>

  export const Objectives = z
    .array(Objective)
    .max(8)
    .refine(
      (items) => new Set(items.map((item) => item.metric)).size === items.length,
      "Objective metrics must be unique",
    )
  export type Objectives = z.infer<typeof Objectives>

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

  export const Adaptive = z
    .object({
      protocolVersion: z.literal("marginal-utility-v1"),
      minRounds: z.number().int().min(1).max(8),
      patience: z.number().int().min(1).max(7),
      minUtilityGain: z.number().finite().nonnegative().max(1),
      maxUncertainty: z.number().finite().min(0).max(1),
      targetUtility: z.number().finite().min(0).max(1).optional(),
    })
    .strict()
  export type Adaptive = z.infer<typeof Adaptive>

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
      adaptive: Adaptive.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (!value.adaptive) return
      if (value.topology !== "evolution") {
        ctx.addIssue({
          code: "custom",
          path: ["topology"],
          message: "Adaptive marginal-utility control requires an explicit evolution topology",
        })
      }
      if (value.adaptive.minRounds > value.maxRounds) {
        ctx.addIssue({
          code: "custom",
          path: ["adaptive", "minRounds"],
          message: "Adaptive minimum rounds exceed the orchestration round budget",
        })
      }
      if (Math.max(value.adaptive.minRounds, value.adaptive.patience + 1) > value.maxRounds) {
        ctx.addIssue({
          code: "custom",
          path: ["adaptive", "patience"],
          message: "Adaptive patience cannot be observed within the orchestration round budget",
        })
      }
    })
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

  const Hash = z.string().regex(/^[a-f0-9]{64}$/)

  export const ObjectiveAudit = z
    .object({
      schemaVersion: z.literal(1),
      planSHA256: Hash,
      validatorSHA256: Hash,
      contractSHA256: Hash,
      guardIDs: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(64)
        .refine((items) => new Set(items).size === items.length, "Objective audit guards must be unique"),
    })
    .strict()
  export type ObjectiveAudit = z.infer<typeof ObjectiveAudit>

  export const LaunchCheck = z.enum([
    "clean_checkout",
    "locked_environment",
    "task_manifest_load",
    "evaluator_load",
    "hidden_boundary",
    "deterministic_replay",
    "artifact_roundtrip",
    "baseline_replay",
  ])
  export type LaunchCheck = z.infer<typeof LaunchCheck>

  export const Launch = z
    .object({
      protocolVersion: z.literal("benchmark-launch-v1"),
      runner: z
        .object({
          repository: z.string().url().max(2_048),
          revision: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
          entrypoint: z.string().min(1).max(1_000),
          commandSHA256: Hash,
          environmentSHA256: Hash,
          recipeSHA256: Hash.optional(),
          driverSHA256: Hash.optional(),
        })
        .strict()
        .refine(
          (value) => (value.recipeSHA256 === undefined) === (value.driverSHA256 === undefined),
          "Recipe and native-driver hashes must be declared together",
        ),
      dataset: z
        .object({
          name: z.string().min(1).max(200),
          source: z.string().min(1).max(2_048),
          revision: z.string().min(1).max(500),
          manifestSHA256: Hash,
        })
        .strict(),
      taskManifestSHA256: Hash,
      evaluatorSHA256: Hash,
      validatorSHA256: Hash,
      baseline: z
        .object({
          name: z.string().min(1).max(200),
          artifactSHA256: Hash,
          expectedScore: z.number().finite().optional(),
          tolerance: z.number().finite().nonnegative().optional(),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if ((value.baseline.expectedScore === undefined) === (value.baseline.tolerance === undefined)) return
      ctx.addIssue({
        code: "custom",
        path: ["baseline"],
        message: "Baseline expected score and tolerance must be declared together",
      })
    })
  export type Launch = z.infer<typeof Launch>

  export const IntegrityAuditKind = z.enum(["test_item_contamination", "external_model_use", "benchmark_lookup"])
  export type IntegrityAuditKind = z.infer<typeof IntegrityAuditKind>

  export const IntegrityAuditor = z
    .object({
      kind: IntegrityAuditKind,
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      promptSHA256: Hash,
    })
    .strict()

  export const Integrity = z
    .object({
      protocolVersion: z.literal("benchmark-integrity-v1"),
      validatorSHA256: Hash,
      traceSchemaSHA256: Hash,
      minEvents: z.number().int().min(1).max(10_000_000),
      minCoverage: z.number().min(0.9).max(1),
      assignedModel: z
        .object({
          name: z.string().min(1).max(500),
          baseArtifactSHA256: Hash,
          configSHA256: Hash,
        })
        .strict(),
      forbiddenModelArtifacts: z
        .array(Hash)
        .max(128)
        .refine((items) => new Set(items).size === items.length, "Forbidden model artifacts must be unique")
        .default([]),
      policy: z
        .object({
          testItemDerivation: z.literal("forbidden"),
          unapprovedExternalModels: z.literal("forbidden"),
          benchmarkLookup: z.literal("forbidden"),
        })
        .strict(),
      auditors: z
        .array(IntegrityAuditor)
        .length(IntegrityAuditKind.options.length)
        .refine(
          (items) => new Set(items.map((item) => item.kind)).size === items.length,
          "Integrity auditors must be unique",
        ),
      hiddenCanaryManifestSHA256: Hash,
      minHiddenCanaries: z.number().int().min(1).max(10_000),
    })
    .strict()
    .superRefine((value, ctx) => {
      const expected = IntegrityAuditKind.options.toSorted()
      const submitted = value.auditors.map((item) => item.kind).toSorted()
      if (JSON.stringify(expected) !== JSON.stringify(submitted)) {
        ctx.addIssue({ code: "custom", path: ["auditors"], message: "Integrity protocol requires every audit class" })
      }
      const identities = value.auditors.map((item) => `${item.name}\n${item.version}\n${item.promptSHA256}`)
      if (new Set(identities).size === identities.length) return
      ctx.addIssue({ code: "custom", path: ["auditors"], message: "Integrity auditor identities must be distinct" })
    })
  export type Integrity = z.infer<typeof Integrity>

  const SourcePath = z
    .string()
    .min(1)
    .max(1_000)
    .refine(
      (value) =>
        value === "." ||
        (!value.startsWith("/") &&
          !value.endsWith("/") &&
          !value.includes("\\") &&
          !value.split("/").some((part) => !part || part === "." || part === "..")),
      "Evolution trace paths must be normalized relative POSIX paths",
    )

  export const Evolution = z
    .object({
      protocolVersion: z.literal("evolution-trace-v1"),
      validatorSHA256: Hash,
      manifestSchemaSHA256: Hash,
      lineAlgorithm: z.literal("sha256-exact-line-v1"),
      roots: z
        .array(SourcePath)
        .min(1)
        .max(32)
        .refine((items) => new Set(items).size === items.length, "Evolution trace roots must be unique"),
      extensions: z
        .array(z.string().regex(/^\.[a-zA-Z0-9][a-zA-Z0-9._+-]{0,31}$/))
        .min(1)
        .max(128)
        .refine((items) => new Set(items).size === items.length, "Evolution trace extensions must be unique"),
      exclude: z
        .array(SourcePath)
        .max(128)
        .refine((items) => new Set(items).size === items.length, "Evolution trace exclusions must be unique")
        .default([]),
      maxFiles: z.number().int().min(1).max(100_000),
      maxFileBytes: z.number().int().min(1).max(1_000_000_000),
      maxTotalBytes: z.number().int().min(1).max(10_000_000_000),
      maxSourceLines: z.number().int().min(1).max(10_000_000),
      maxChangedLines: z.number().int().min(1).max(2_000_000),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.maxFileBytes <= value.maxTotalBytes) return
      ctx.addIssue({
        code: "custom",
        path: ["maxFileBytes"],
        message: "Evolution trace file limit cannot exceed its total byte limit",
      })
    })
  export type Evolution = z.infer<typeof Evolution>

  export const InterventionFamily = z.enum([
    "replay",
    "retune",
    "ablation",
    "repair",
    "model_transfer",
    "context_transfer",
    "evaluator_transfer",
    "split_transfer",
  ])
  export type InterventionFamily = z.infer<typeof InterventionFamily>

  const InterventionRule = z.discriminatedUnion("mode", [
    z
      .object({
        family: z.literal("replay"),
        mode: z.literal("max_absolute_effect"),
        threshold: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        family: z.enum(["retune", "ablation", "repair"]),
        mode: z.literal("min_effect"),
        threshold: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        family: z.enum(["model_transfer", "context_transfer", "evaluator_transfer", "split_transfer"]),
        mode: z.literal("max_regression"),
        threshold: z.number().finite().nonnegative(),
      })
      .strict(),
  ])

  export const Interventions = z
    .object({
      protocolVersion: z.literal("intervention-study-v1"),
      validatorSHA256: Hash,
      requiredForPromotion: z.boolean(),
      minPairs: z.number().int().min(3).max(32),
      maxPairs: z.number().int().min(3).max(32),
      maxTotalPairs: z.number().int().min(3).max(256),
      confidence: z.literal(0.95),
      required: z
        .array(InterventionFamily)
        .min(1)
        .max(InterventionFamily.options.length)
        .refine((items) => new Set(items).size === items.length, "Intervention families must be unique")
        .refine(
          (items) => JSON.stringify(items) === JSON.stringify(items.toSorted()),
          "Intervention families must be sorted",
        ),
      rules: z
        .array(InterventionRule)
        .min(1)
        .max(InterventionFamily.options.length)
        .refine(
          (items) => new Set(items.map((item) => item.family)).size === items.length,
          "Intervention rules must be unique",
        )
        .refine(
          (items) =>
            JSON.stringify(items.map((item) => item.family)) ===
            JSON.stringify(items.map((item) => item.family).toSorted()),
          "Intervention rules must be family-sorted",
        ),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.minPairs > value.maxPairs) {
        ctx.addIssue({
          code: "custom",
          path: ["maxPairs"],
          message: "Intervention maximum pairs cannot be smaller than its minimum pairs",
        })
      }
      if (value.maxPairs * value.required.length > value.maxTotalPairs) {
        ctx.addIssue({
          code: "custom",
          path: ["maxTotalPairs"],
          message: "Intervention total pair limit cannot fit every required family",
        })
      }
      if (JSON.stringify(value.required) === JSON.stringify(value.rules.map((item) => item.family))) return
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "Intervention rules must cover exactly the required families",
      })
    })
  export type Interventions = z.infer<typeof Interventions>

  export const SimulationStress = z.enum([
    "timestep_sensitivity",
    "solver_tolerance_sensitivity",
    "reference_replay",
    "independent_implementation",
    "unit_convention",
    "boundary_sensitivity",
    "perturbation_stability",
  ])
  export type SimulationStress = z.infer<typeof SimulationStress>

  export const SimulationEngine = z
    .object({
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      commandSHA256: Hash,
      configSHA256: Hash,
    })
    .strict()

  export const SimulationReference = z
    .object({
      kind: z.enum(["analytic", "manufactured", "benchmark", "independent_solver", "limiting_case"]),
      identity: z.string().min(1).max(500),
      sha256: Hash,
    })
    .strict()

  export const Simulation = z
    .object({
      kind: z.enum(["ode", "pde", "cfd", "materials", "molecular", "agentic"]),
      engine: SimulationEngine,
      problemSHA256: Hash,
      reference: SimulationReference,
      validation: z
        .object({
          errorNorm: z.string().min(1).max(200),
          minLevels: z.number().int().min(3).max(12),
          maxLevels: z.number().int().min(3).max(24).default(12),
          expectedOrder: z.number().finite().positive().max(20),
          orderTolerance: z.number().finite().nonnegative().max(10),
          maxResidual: z.number().finite().nonnegative(),
          invariantTolerances: z
            .record(z.string().min(1).max(100), z.number().finite().nonnegative())
            .refine(
              (value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32,
              "A simulator protocol needs 1 to 32 invariant tolerances",
            ),
          requiredStressTests: z
            .array(SimulationStress)
            .min(1)
            .max(SimulationStress.options.length)
            .refine((items) => new Set(items).size === items.length, "Simulation stress tests must be unique"),
        })
        .strict()
        .superRefine((value, ctx) => {
          if (value.minLevels <= value.maxLevels) return
          ctx.addIssue({
            code: "custom",
            path: ["maxLevels"],
            message: "Simulation maximum levels cannot be smaller than its minimum levels",
          })
        }),
    })
    .strict()
  export type Simulation = z.infer<typeof Simulation>

  export const EvaluatorFault = z.enum([
    "wrong_answer",
    "unsupported_claim",
    "missing_evidence",
    "data_leakage",
    "non_reproducible",
    "reward_hacking",
    "invalid_statistics",
    "invalid_simulation",
    "distribution_shift",
    "evaluation_awareness",
  ])
  export type EvaluatorFault = z.infer<typeof EvaluatorFault>

  export const EvaluatorAudit = z
    .object({
      protocolVersion: z.literal("evaluator-audit-v1"),
      auditor: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "human", "external"]),
        })
        .strict(),
      suite: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          commitmentSHA256: Hash,
        })
        .strict(),
      minCleanCases: z.number().int().min(2).max(512),
      minCasesPerFault: z.number().int().min(1).max(128),
      requiredFaults: z
        .array(EvaluatorFault)
        .min(1)
        .max(EvaluatorFault.options.length)
        .refine((items) => new Set(items).size === items.length, "Evaluator audit fault classes must be unique"),
      minSensitivity: z.number().min(0.5).max(1),
      minSpecificity: z.number().min(0.5).max(1),
      minBalancedAccuracy: z.number().min(0.5).max(1),
      minFaultRecall: z.number().min(0.5).max(1),
      maxBrierScore: z.number().min(0).max(0.5),
    })
    .strict()
  export type EvaluatorAudit = z.infer<typeof EvaluatorAudit>

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
          objectives: Objectives.optional(),
          objectiveAudit: ObjectiveAudit.optional(),
        })
        .strict(),
      profile: Profile,
      orchestration: Orchestration.optional(),
      audit: Audit.optional(),
      launch: Launch.optional(),
      recipe: HarnessRecipe.Materialized.optional(),
      integrity: Integrity.optional(),
      evolution: Evolution.optional(),
      interventions: Interventions.optional(),
      simulation: Simulation.optional(),
      evaluatorAudit: EvaluatorAudit.optional(),
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
    .superRefine((value, ctx) => {
      if (
        value.benchmark.objectives?.length &&
        (!value.benchmark.metric || !["maximize", "minimize"].includes(value.benchmark.direction ?? ""))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "objectives"],
          message: "Secondary objectives require a numeric primary benchmark metric",
        })
      }
      if (value.benchmark.objectives?.some((item) => item.metric === value.benchmark.metric)) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "objectives"],
          message: "A secondary objective cannot duplicate the primary benchmark metric",
        })
      }
      if (value.benchmark.objectives?.length && value.profile !== "optimize") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "objectives"],
          message: "Secondary objectives require the optimize profile",
        })
      }
      if (value.benchmark.objectiveAudit && !value.benchmark.objectives?.length) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "objectiveAudit"],
          message: "An objective audit requires declared secondary objectives",
        })
      }
      if (
        (value.launch ||
          value.integrity ||
          value.evolution ||
          value.interventions ||
          value.simulation ||
          value.evaluatorAudit) &&
        !value.benchmark.evaluatorVersion
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorVersion"],
          message: "Evaluator-controlled validation needs an evaluator version",
        })
      }
      if (
        (value.launch ||
          value.integrity ||
          value.evolution ||
          value.interventions ||
          value.simulation ||
          value.evaluatorAudit) &&
        !value.benchmark.evaluatorSource
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Evaluator-controlled validation needs an evaluator source",
        })
      }
      if (value.simulation && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Simulator validation requires a capability-authenticated evaluator source",
        })
      }
      if (value.launch && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Benchmark launch validation requires a capability-authenticated evaluator source",
        })
      }
      if (value.integrity && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Runtime integrity validation requires a capability-authenticated evaluator source",
        })
      }
      if (value.evolution && value.profile !== "optimize") {
        ctx.addIssue({
          code: "custom",
          path: ["evolution"],
          message: "Evolution trace validation requires the optimize profile",
        })
      }
      if (value.evolution && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Evolution trace validation requires a capability-authenticated evaluator source",
        })
      }
      if (value.interventions && value.profile !== "optimize") {
        ctx.addIssue({
          code: "custom",
          path: ["interventions"],
          message: "Controlled replay interventions require the optimize profile",
        })
      }
      if (value.interventions && !value.evolution) {
        ctx.addIssue({
          code: "custom",
          path: ["interventions"],
          message: "Controlled replay interventions require exact evolutionary provenance",
        })
      }
      if (
        value.interventions &&
        (!value.benchmark.metric || !["maximize", "minimize"].includes(value.benchmark.direction ?? ""))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["interventions"],
          message: "Controlled replay interventions require a numeric benchmark metric and direction",
        })
      }
      if (value.interventions && !["held_out", "release"].includes(value.benchmark.split)) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "split"],
          message: "Controlled replay interventions require a held-out or release benchmark split",
        })
      }
      if (value.interventions && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Controlled replay interventions require a capability-authenticated evaluator source",
        })
      }
      if (
        value.integrity?.auditors.some(
          (auditor) =>
            auditor.name === value.benchmark.evaluator && auditor.version === value.benchmark.evaluatorVersion,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["integrity", "auditors"],
          message: "Runtime integrity auditing requires identities distinct from the score evaluator",
        })
      }
      if (value.launch && value.benchmark.direction !== "pass" && value.launch.baseline.expectedScore === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["launch", "baseline", "expectedScore"],
          message: "Numeric benchmark launches require a replayable baseline score and tolerance",
        })
      }
      if (value.recipe && !value.launch) {
        ctx.addIssue({
          code: "custom",
          path: ["recipe"],
          message: "A materialized benchmark recipe requires a bound launch protocol",
        })
      }
      if (
        value.recipe &&
        (value.recipe.benchmark !== value.benchmark.name ||
          value.recipe.entrypoint !== value.launch?.runner.entrypoint ||
          value.recipe.recipeSHA256 !== value.launch?.runner.recipeSHA256 ||
          value.recipe.driverSHA256 !== value.launch?.runner.driverSHA256)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["recipe"],
          message: "Materialized benchmark recipe does not match the bound native launch driver",
        })
      }
      if (!value.recipe && value.launch?.runner.recipeSHA256) {
        ctx.addIssue({
          code: "custom",
          path: ["launch", "runner", "recipeSHA256"],
          message: "A recipe-bound launch must retain its materialized recipe",
        })
      }
      if (
        value.evaluatorAudit &&
        value.evaluatorAudit.auditor.name === value.benchmark.evaluator &&
        value.evaluatorAudit.auditor.version === value.benchmark.evaluatorVersion &&
        value.evaluatorAudit.auditor.source === value.benchmark.evaluatorSource
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorAudit", "auditor"],
          message: "Evaluator qualification requires an independent auditor identity",
        })
      }
    })
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
