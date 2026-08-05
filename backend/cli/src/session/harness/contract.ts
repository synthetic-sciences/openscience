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

  export const Search = z
    .object({
      protocolVersion: z.literal("adaptive-search-v1"),
      signal: z
        .object({
          source: z.literal("verified-final-evaluations"),
          decay: z.literal(0.9),
          epsilon: z.literal(1e-8),
        })
        .strict(),
      local: z
        .object({
          minIntensity: z.literal(0.15),
          maxIntensity: z.literal(0.5),
        })
        .strict(),
      global: z
        .object({
          exploration: z.literal(Math.SQRT2),
          minVisits: z.literal(2),
        })
        .strict(),
      stagnation: z
        .object({
          patience: z.literal(5),
          maxSignal: z.literal(0.02),
        })
        .strict(),
    })
    .strict()
  export type Search = z.infer<typeof Search>

  export const adaptiveSearch: Search = {
    protocolVersion: "adaptive-search-v1",
    signal: { source: "verified-final-evaluations", decay: 0.9, epsilon: 1e-8 },
    local: { minIntensity: 0.15, maxIntensity: 0.5 },
    global: { exploration: Math.SQRT2, minVisits: 2 },
    stagnation: { patience: 5, maxSignal: 0.02 },
  }

  export const Topology = z.enum([
    "auto",
    "solo",
    "centralized",
    "fork_join",
    "tournament",
    "evolution",
    "verifier_loop",
  ])
  export type Topology = z.infer<typeof Topology>

  export const Role = z.enum([
    "generation",
    "proximity",
    "reflection",
    "ranking",
    "evolution",
    "revision",
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

  export const Repair = z
    .object({
      protocolVersion: z.literal("verifier-routed-v1"),
      minConfidence: z.number().finite().min(0.5).max(1),
    })
    .strict()
  export type Repair = z.infer<typeof Repair>

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
      repair: Repair.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.adaptive && value.topology !== "evolution") {
        ctx.addIssue({
          code: "custom",
          path: ["topology"],
          message: "Adaptive marginal-utility control requires an explicit evolution topology",
        })
      }
      if (value.adaptive && value.adaptive.minRounds > value.maxRounds) {
        ctx.addIssue({
          code: "custom",
          path: ["adaptive", "minRounds"],
          message: "Adaptive minimum rounds exceed the orchestration round budget",
        })
      }
      if (value.adaptive && Math.max(value.adaptive.minRounds, value.adaptive.patience + 1) > value.maxRounds) {
        ctx.addIssue({
          code: "custom",
          path: ["adaptive", "patience"],
          message: "Adaptive patience cannot be observed within the orchestration round budget",
        })
      }
      if (value.repair && value.topology !== "verifier_loop") {
        ctx.addIssue({
          code: "custom",
          path: ["topology"],
          message: "Verifier-routed repair requires an explicit verifier_loop topology",
        })
      }
      if (value.topology === "verifier_loop" && !value.repair) {
        ctx.addIssue({
          code: "custom",
          path: ["repair"],
          message: "Verifier loop topology requires a verifier-routed repair contract",
        })
      }
      if (value.topology === "verifier_loop" && value.minIndependentVerifiers !== 2) {
        ctx.addIssue({
          code: "custom",
          path: ["minIndependentVerifiers"],
          message: "Verifier loop topology requires two independent verifiers",
        })
      }
      if (value.adaptive && value.repair) {
        ctx.addIssue({
          code: "custom",
          path: ["repair"],
          message: "Adaptive evolution and verifier-routed repair are separate bounded controllers",
        })
      }
    })
  export type Orchestration = z.infer<typeof Orchestration>

  const Hash = z.string().regex(/^[a-f0-9]{64}$/)

  export const AuditTransfer = z
    .object({
      protocolVersion: z.literal("score-history-prior-v1"),
      poolSHA256: Hash,
      sourceManifestSHA256: Hash,
      selectionSHA256: Hash,
      selectionMethod: z.enum(["pca-gmm-profile-v1", "holdout-embedding-gmm-v1"]),
      sourceModels: z
        .array(z.string().min(1).max(240))
        .min(3)
        .max(64)
        .refine((items) => new Set(items).size === items.length, "Audit transfer source models must be unique"),
      calibrationSamples: z.number().int().min(2).max(64),
      maxCalibrationMAE: z.number().positive().max(1),
    })
    .strict()
  export type AuditTransfer = z.infer<typeof AuditTransfer>

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
      transfer: AuditTransfer.optional(),
      promotionRequired: z.boolean().optional(),
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
      if (value.transfer && value.transfer.calibrationSamples > value.budget) {
        ctx.addIssue({
          code: "custom",
          path: ["transfer", "calibrationSamples"],
          message: "Audit transfer calibration exceeds its budget",
        })
      }
      if (value.promotionRequired && !value.transfer) {
        ctx.addIssue({
          code: "custom",
          path: ["promotionRequired"],
          message: "Audit promotion requires a transfer-qualified proactive audit",
        })
      }
      if (value.promotionRequired && value.mode === "failure") {
        ctx.addIssue({
          code: "custom",
          path: ["mode"],
          message: "A failure-only audit cannot qualify a population performance evaluation",
        })
      }
    })
  export type Audit = z.infer<typeof Audit>

  export const FailureValidatorKind = z.enum(["correctness", "topic", "novelty"])
  export type FailureValidatorKind = z.infer<typeof FailureValidatorKind>

  const FailureIdentity = z
    .object({
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      promptSHA256: Hash,
      configSHA256: Hash,
    })
    .strict()

  export const FailureTopic = z
    .object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
      commitment: Hash,
    })
    .strict()
  export type FailureTopic = z.infer<typeof FailureTopic>

  export const FailureDiscovery = z
    .object({
      protocolVersion: z.literal("topic-aware-failure-v1"),
      sourcePoolSHA256: Hash,
      topicModel: z
        .object({
          kind: z.enum(["predefined", "bertopic"]),
          identity: FailureIdentity,
        })
        .strict(),
      topics: z
        .array(FailureTopic)
        .min(2)
        .max(64)
        .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Failure topics must be unique")
        .refine(
          (items) => new Set(items.map((item) => item.commitment)).size === items.length,
          "Failure topic commitments must be unique",
        )
        .refine(
          (items) => items.every((item, index) => !index || items[index - 1]!.id < item.id),
          "Failure topics must be sorted by ID",
        ),
      generator: FailureIdentity,
      validators: z
        .array(
          z
            .object({
              kind: FailureValidatorKind,
              identity: FailureIdentity,
            })
            .strict(),
        )
        .length(FailureValidatorKind.options.length)
        .refine(
          (items) => new Set(items.map((item) => item.kind)).size === items.length,
          "Failure discovery requires every validator class",
        )
        .refine(
          (items) => items.every((item, index) => item.kind === FailureValidatorKind.options[index]),
          "Failure discovery validators must use canonical kind order",
        ),
      embedding: z
        .object({
          identity: FailureIdentity,
          dimensions: z.number().int().min(2).max(64),
          regularization: z.number().positive().max(0.01).default(1e-6),
        })
        .strict(),
      budget: z.number().int().min(2).max(512),
      anchorsPerAttempt: z.number().int().min(1).max(8),
      exploration: z.number().positive().max(4).default(Math.SQRT2),
      failureThreshold: z.number().min(0).max(1),
      targetFailures: z.number().int().positive().max(512).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.targetFailures !== undefined && value.targetFailures > value.budget) {
        ctx.addIssue({
          code: "custom",
          path: ["targetFailures"],
          message: "Failure discovery target exceeds its attempt budget",
        })
      }
      if (value.budget < value.topics.length) {
        ctx.addIssue({
          code: "custom",
          path: ["budget"],
          message: "Failure discovery budget must initialize every topic arm",
        })
      }
      const actors = [value.generator, ...value.validators.map((item) => item.identity)]
      const identities = actors.map((item) => `${item.promptSHA256}:${item.configSHA256}`)
      if (new Set(identities).size !== identities.length) {
        ctx.addIssue({
          code: "custom",
          path: ["validators"],
          message: "Failure generator and validators must use distinct prompt/config commitments",
        })
      }
    })
  export type FailureDiscovery = z.infer<typeof FailureDiscovery>

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

  export const Novelty = z.enum(["not_required", "known", "rediscovery", "minor", "publication", "major"])
  export type Novelty = z.infer<typeof Novelty>

  export const SemanticAudit = z
    .object({
      protocolVersion: z.literal("semantic-audit-v1"),
      reviewer: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["gate", "human", "external"]),
        })
        .strict(),
      scope: z
        .object({
          objectiveSHA256: Hash,
          criteria: z
            .array(
              z
                .object({
                  id: z.string().min(1).max(100),
                  requirement: z.string().min(1).max(500),
                })
                .strict(),
            )
            .min(1)
            .max(24)
            .refine(
              (items) => new Set(items.map((item) => item.id)).size === items.length,
              "Semantic criterion IDs must be unique",
            ),
          forbiddenShortcuts: z
            .array(
              z
                .object({
                  id: z.string().min(1).max(100),
                  description: z.string().min(1).max(500),
                })
                .strict(),
            )
            .min(1)
            .max(24)
            .refine(
              (items) => new Set(items.map((item) => item.id)).size === items.length,
              "Forbidden semantic shortcut IDs must be unique",
            ),
          literature: z
            .object({
              cutoff: z.iso.date(),
              corpusSHA256: Hash,
            })
            .strict(),
          noveltyFloor: Novelty,
        })
        .strict(),
      minReviewers: z.number().int().min(2).max(5),
      minConfidence: z.number().finite().min(0.5).max(1),
    })
    .strict()
  export type SemanticAudit = z.infer<typeof SemanticAudit>

  export const SynthesisTool = z.enum(["google_search", "paper_search", "web_browse"])
  export type SynthesisTool = z.infer<typeof SynthesisTool>

  const SynthesisIdentity = z
    .object({
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      promptSHA256: Hash,
      configSHA256: Hash,
    })
    .strict()

  export const ScientificSynthesis = z
    .object({
      protocolVersion: z.literal("scientific-synthesis-v1"),
      querySHA256: Hash,
      referenceSHA256: Hash,
      referenceFactsSHA256: Hash,
      referenceFactCount: z.number().int().min(1).max(2_048),
      cutoff: z.iso.date(),
      tools: z
        .array(SynthesisTool)
        .min(1)
        .max(SynthesisTool.options.length)
        .refine((items) => new Set(items).size === items.length, "Scientific synthesis tools must be unique")
        .refine(
          (items) =>
            items.every(
              (item, index) =>
                !index || SynthesisTool.options.indexOf(items[index - 1]!) < SynthesisTool.options.indexOf(item),
            ),
          "Scientific synthesis tools must use canonical order",
        ),
      traceSchemaSHA256: Hash,
      filterPolicySHA256: Hash,
      maxToolEvents: z.number().int().min(1).max(10_000),
      decomposer: SynthesisIdentity,
      judges: z
        .object({
          precision: SynthesisIdentity,
          recall: SynthesisIdentity,
        })
        .strict(),
      minGeneratedFacts: z.number().int().min(1).max(512),
      minPrecision: z.number().min(0).max(1),
      minRecall: z.number().min(0).max(1),
      minF1: z.number().min(0).max(1),
      cleanRoomRequired: z.literal(true),
      judgeFailurePolicy: z.literal("inconclusive"),
    })
    .strict()
    .superRefine((value, ctx) => {
      const identities = [value.decomposer, value.judges.precision, value.judges.recall]
      const prompts = identities.map((item) => item.promptSHA256)
      if (new Set(prompts).size !== prompts.length) {
        ctx.addIssue({
          code: "custom",
          path: ["judges"],
          message: "Decomposition, precision, and recall require distinct prompt commitments",
        })
      }
    })
  export type ScientificSynthesis = z.infer<typeof ScientificSynthesis>

  export const AutonomyLevel = z.enum(["essentially_autonomous", "human_ai_collaboration", "primarily_human"])
  export type AutonomyLevel = z.infer<typeof AutonomyLevel>

  export const HumanAIAutonomy = z
    .object({
      protocolVersion: z.literal("human-ai-autonomy-v1"),
      claimedLevel: AutonomyLevel,
      recorder: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          artifactSHA256: Hash,
          source: z.literal("evaluator_runtime"),
        })
        .strict(),
      traceSchemaSHA256: Hash,
      classificationPolicySHA256: Hash,
      maxEvents: z.number().int().min(2).max(10_000),
      rawRetention: z.literal("required"),
      disclosure: z.enum(["evaluator_retained", "public_essential_after_release"]),
      completeTraceRequired: z.literal(true),
      uncertaintyPolicy: z.literal("inconclusive"),
    })
    .strict()
  export type HumanAIAutonomy = z.infer<typeof HumanAIAutonomy>

  export const FormalTier = z.enum(["kernel", "fresh_recheck", "external_crosscheck"])
  export type FormalTier = z.infer<typeof FormalTier>

  export const FormalRelation = z.enum(["exact_proof", "exact_refutation", "repaired_proof"])
  export type FormalRelation = z.infer<typeof FormalRelation>

  export const FormalForbidden = z.enum(["sorry", "admit", "debug.skipKernelTC", "native_decide"])
  export type FormalForbidden = z.infer<typeof FormalForbidden>

  export const FormalVerifierRole = z.enum([
    "lean_kernel",
    "source_auditor",
    "axiom_auditor",
    "fresh_rechecker",
    "sandbox_comparator",
    "external_checker",
  ])
  export type FormalVerifierRole = z.infer<typeof FormalVerifierRole>

  const FormalVerifier = z
    .object({
      role: FormalVerifierRole,
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      artifactSHA256: Hash,
    })
    .strict()

  export const ProofBlueprint = z
    .object({
      protocolVersion: z.literal("proof-blueprint-v1"),
      graphSchemaSHA256: Hash,
      compilerArtifactSHA256: Hash,
      sketchValidatorArtifactSHA256: Hash,
      reviewerArtifactSHA256: Hash,
      reviewerPromptSHA256: Hash,
      nodePolicy: z.literal("and-or-monotone-v1"),
      failurePolicy: z.literal("preserve-and-refine"),
      memoization: z.literal("goal-sha256"),
      finalAuthority: z.literal("formal-proof-v1"),
      directAttemptFirst: z.literal(true),
      verifiedSketchRequired: z.literal(true),
      completeFailureHistoryRequired: z.literal(true),
      maxNodes: z.number().int().min(2).max(512),
      maxDepth: z.number().int().min(1).max(32),
      maxParallel: z.number().int().min(1).max(32),
      maxAttemptsPerGoal: z.number().int().min(1).max(16),
      maxRefinementsPerGoal: z.number().int().min(0).max(16),
      leaseDurationMs: z.number().int().min(1_000).max(3_600_000),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.maxParallel > value.maxNodes) {
        ctx.addIssue({
          code: "custom",
          path: ["maxParallel"],
          message: "Proof blueprint parallelism cannot exceed its graph node budget",
        })
      }
      const artifacts = [
        value.graphSchemaSHA256,
        value.compilerArtifactSHA256,
        value.sketchValidatorArtifactSHA256,
        value.reviewerArtifactSHA256,
        value.reviewerPromptSHA256,
      ]
      if (new Set(artifacts).size === artifacts.length) return
      ctx.addIssue({
        code: "custom",
        path: ["graphSchemaSHA256"],
        message: "Proof blueprint schema, compiler, validator, reviewer, and rubric require distinct artifacts",
      })
    })
  export type ProofBlueprint = z.infer<typeof ProofBlueprint>

  export const FormalProof = z
    .object({
      protocolVersion: z.literal("formal-proof-v1"),
      language: z.literal("lean4"),
      tier: FormalTier,
      relation: FormalRelation,
      challengeSHA256: Hash,
      statementSHA256: Hash,
      declaration: z.string().min(1).max(500),
      module: z.string().min(1).max(500),
      leanVersion: z.string().min(1).max(200),
      leanToolchainSHA256: Hash,
      lakeManifestSHA256: Hash,
      dependencyTreeSHA256: Hash,
      verifiers: z.array(FormalVerifier).min(2).max(FormalVerifierRole.options.length),
      sandboxImageSHA256: Hash.optional(),
      forbiddenConstructs: z.array(FormalForbidden).length(FormalForbidden.options.length),
      allowedAxioms: z.array(z.string().min(1).max(300)).max(64),
      maxFiles: z.number().int().min(6).max(10_000),
      completeManifestRequired: z.literal(true),
      warningPolicy: z.literal("fail"),
      semanticPolicy: z.literal("formal_statement_only"),
      blueprint: ProofBlueprint.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const roles = value.verifiers.map((item) => item.role)
      const required =
        value.tier === "kernel"
          ? ["lean_kernel", "source_auditor", "axiom_auditor"]
          : value.tier === "fresh_recheck"
            ? ["lean_kernel", "source_auditor", "axiom_auditor", "fresh_rechecker"]
            : FormalVerifierRole.options
      if (new Set(roles).size !== roles.length || JSON.stringify(roles) !== JSON.stringify(required)) {
        ctx.addIssue({
          code: "custom",
          path: ["verifiers"],
          message: "Formal proof verifier roles must exactly match the frozen trust tier in canonical order",
        })
      }
      const artifacts = value.verifiers.map((item) => item.artifactSHA256)
      if (new Set(artifacts).size !== artifacts.length) {
        ctx.addIssue({
          code: "custom",
          path: ["verifiers"],
          message: "Formal proof trust roles require distinct verifier artifacts",
        })
      }
      if (Boolean(value.sandboxImageSHA256) !== (value.tier === "external_crosscheck")) {
        ctx.addIssue({
          code: "custom",
          path: ["sandboxImageSHA256"],
          message: "Only the external cross-check tier requires a frozen sandbox image",
        })
      }
      if (JSON.stringify(value.forbiddenConstructs) !== JSON.stringify(FormalForbidden.options)) {
        ctx.addIssue({
          code: "custom",
          path: ["forbiddenConstructs"],
          message: "Formal proof forbidden constructs must use the complete canonical protocol policy",
        })
      }
      if (
        new Set(value.allowedAxioms).size !== value.allowedAxioms.length ||
        value.allowedAxioms.some(
          (item, index) => Boolean(index) && value.allowedAxioms[index - 1]!.localeCompare(item) >= 0,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["allowedAxioms"],
          message: "Formal proof allowed axioms must be unique and use canonical order",
        })
      }
      if (value.allowedAxioms.includes("sorryAx")) {
        ctx.addIssue({
          code: "custom",
          path: ["allowedAxioms"],
          message: "A formal proof protocol can never allow sorryAx",
        })
      }
      const kernel = value.verifiers.find((item) => item.role === "lean_kernel")
      if (value.blueprint && value.blueprint.compilerArtifactSHA256 !== kernel?.artifactSHA256) {
        ctx.addIssue({
          code: "custom",
          path: ["blueprint", "compilerArtifactSHA256"],
          message: "Proof blueprint sketches and attempts must use the formal protocol's frozen Lean kernel",
        })
      }
    })
  export type FormalProof = z.infer<typeof FormalProof>

  export const ReplicationEstimator = z.enum(["mean", "median", "iqm", "pass_rate"])
  export type ReplicationEstimator = z.infer<typeof ReplicationEstimator>

  const ReplicationAxis = z
    .object({
      id: z.string().min(1).max(120),
      commitmentSHA256: Hash,
    })
    .strict()

  const ReplicationInterval = z.discriminatedUnion("method", [
    z
      .object({
        method: z.literal("stratified-bootstrap-percentile-v1"),
        confidence: z.literal(0.95),
        resamples: z.number().int().min(1_000).max(50_000),
        seed: z.number().int().min(0).max(0xffffffff),
      })
      .strict(),
    z
      .object({
        method: z.literal("wilson-score-v1"),
        confidence: z.literal(0.95),
      })
      .strict(),
  ])

  export const Replication = z
    .object({
      protocolVersion: z.literal("replicated-evaluation-v1"),
      validatorSHA256: Hash,
      environmentSHA256: Hash,
      sampling: z
        .object({
          design: z.literal("crossed-stratified-cluster-v1"),
          stratumKind: z.string().min(1).max(120),
          clusterKind: z.string().min(1).max(120),
          strata: z
            .array(ReplicationAxis)
            .min(1)
            .max(64)
            .refine(
              (items) => new Set(items.map((item) => item.id)).size === items.length,
              "Replication strata must be unique",
            )
            .refine(
              (items) => new Set(items.map((item) => item.commitmentSHA256)).size === items.length,
              "Replication stratum commitments must be unique",
            )
            .refine(
              (items) =>
                JSON.stringify(items.map((item) => item.id)) ===
                JSON.stringify(items.map((item) => item.id).toSorted()),
              "Replication strata must be sorted",
            ),
          clusters: z
            .array(ReplicationAxis)
            .min(3)
            .max(32)
            .refine(
              (items) => new Set(items.map((item) => item.id)).size === items.length,
              "Replication clusters must be unique",
            )
            .refine(
              (items) => new Set(items.map((item) => item.commitmentSHA256)).size === items.length,
              "Replication cluster commitments must be unique",
            )
            .refine(
              (items) =>
                JSON.stringify(items.map((item) => item.id)) ===
                JSON.stringify(items.map((item) => item.id).toSorted()),
              "Replication clusters must be sorted",
            ),
        })
        .strict()
        .refine(
          (value) => value.strata.length * value.clusters.length <= 512,
          "A replicated evaluation may contain at most 512 frozen units",
        ),
      estimator: ReplicationEstimator,
      interval: ReplicationInterval,
      decision: z
        .object({
          rule: z.literal("conservative-bound-v1"),
          direction: z.enum(["maximize", "minimize", "pass"]),
          target: z.number().finite(),
          maxIntervalWidth: z.number().finite().nonnegative().optional(),
        })
        .strict(),
      failurePolicy: z.literal("fail-closed"),
    })
    .strict()
    .superRefine((value, ctx) => {
      const pass = value.estimator === "pass_rate"
      if (pass !== (value.interval.method === "wilson-score-v1")) {
        ctx.addIssue({
          code: "custom",
          path: ["interval", "method"],
          message: "Pass-rate replication requires Wilson intervals; numeric estimators require stratified bootstrap",
        })
      }
      if (pass !== (value.decision.direction === "pass")) {
        ctx.addIssue({
          code: "custom",
          path: ["decision", "direction"],
          message: "Pass-rate replication requires pass direction; numeric estimators require maximize or minimize",
        })
      }
      if (!pass && value.sampling.clusters.length < 5) {
        ctx.addIssue({
          code: "custom",
          path: ["sampling", "clusters"],
          message: "Numeric stratified bootstrap requires at least five independent clusters",
        })
      }
      if (pass && (value.decision.target < 0 || value.decision.target > 1)) {
        ctx.addIssue({
          code: "custom",
          path: ["decision", "target"],
          message: "Pass-rate replication target must be between zero and one",
        })
      }
      if (pass && value.sampling.strata.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["sampling", "strata"],
          message: "Wilson pass-rate intervals require one stratum of independent Bernoulli clusters",
        })
      }
    })
  export type Replication = z.infer<typeof Replication>

  export const Split = z.enum(["development", "validation", "held_out", "release"])
  export type Split = z.infer<typeof Split>

  export const ConfirmationClaim = z
    .object({
      taskID: z.string().min(1).max(500),
      split: z.enum(["held_out", "release"]),
      manifestSHA256: Hash,
      validatorSHA256: Hash,
      environmentSHA256: Hash,
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "external"]),
        })
        .strict(),
      source: z
        .object({
          repository: z.string().url(),
          revision: z.string().regex(/^[a-f0-9]{40}$/),
        })
        .strict()
        .optional(),
      metric: z.string().min(1).max(200),
      direction: z.enum(["maximize", "minimize"]),
      target: z.number().finite(),
    })
    .strict()

  export const Confirmation = z
    .object({
      protocolVersion: z.literal("sealed-confirmation-v1"),
      optimization: z
        .object({
          split: z.enum(["development", "validation"]),
          manifestSHA256: Hash,
        })
        .strict(),
      claim: ConfirmationClaim,
      selection: z
        .object({
          rule: z.literal("terminal-verified-best-v1"),
          subjects: z.literal(1),
        })
        .strict(),
      exposure: z
        .object({
          policy: z.literal("terminal-receipt-only"),
          searchFeedback: z.literal(false),
          memoryCapture: z.literal(false),
        })
        .strict(),
      failurePolicy: z.literal("fail-closed"),
    })
    .strict()
    .refine(
      (value) => value.optimization.manifestSHA256 !== value.claim.manifestSHA256,
      "Optimization and claim manifests must be distinct",
    )
  export type Confirmation = z.infer<typeof Confirmation>

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
      search: Search.optional(),
      audit: Audit.optional(),
      failureDiscovery: FailureDiscovery.optional(),
      launch: Launch.optional(),
      recipe: HarnessRecipe.Materialized.optional(),
      integrity: Integrity.optional(),
      evolution: Evolution.optional(),
      interventions: Interventions.optional(),
      simulation: Simulation.optional(),
      evaluatorAudit: EvaluatorAudit.optional(),
      semanticAudit: SemanticAudit.optional(),
      synthesis: ScientificSynthesis.optional(),
      autonomy: HumanAIAutonomy.optional(),
      formalProof: FormalProof.optional(),
      replication: Replication.optional(),
      confirmation: Confirmation.optional(),
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
      if (value.search && value.profile !== "optimize") {
        ctx.addIssue({
          code: "custom",
          path: ["search"],
          message: "Adaptive candidate search requires the optimize profile",
        })
      }
      if (
        value.search &&
        (!value.benchmark.metric || !["maximize", "minimize"].includes(value.benchmark.direction ?? ""))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["search"],
          message: "Adaptive candidate search requires a numeric benchmark metric and direction",
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
          value.failureDiscovery ||
          value.integrity ||
          value.evolution ||
          value.interventions ||
          value.simulation ||
          value.evaluatorAudit ||
          value.semanticAudit ||
          value.synthesis ||
          value.autonomy ||
          value.formalProof ||
          value.replication ||
          value.confirmation) &&
        !value.benchmark.evaluatorVersion
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorVersion"],
          message: "Evaluator-controlled validation needs an evaluator version",
        })
      }
      if (value.failureDiscovery && !value.audit) {
        ctx.addIssue({
          code: "custom",
          path: ["failureDiscovery"],
          message: "Topic-aware failure discovery requires a bound active audit",
        })
      }
      if (
        value.failureDiscovery &&
        value.audit &&
        value.failureDiscovery.failureThreshold !== value.audit.failureThreshold
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["failureDiscovery", "failureThreshold"],
          message: "Failure discovery must use the active audit failure threshold",
        })
      }
      if (value.failureDiscovery && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Topic-aware failure discovery requires a capability-authenticated evaluator source",
        })
      }
      if (
        (value.launch ||
          value.failureDiscovery ||
          value.integrity ||
          value.evolution ||
          value.interventions ||
          value.simulation ||
          value.evaluatorAudit ||
          value.semanticAudit ||
          value.synthesis ||
          value.autonomy ||
          value.formalProof ||
          value.replication ||
          value.confirmation) &&
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
      if (
        value.semanticAudit &&
        value.semanticAudit.scope.objectiveSHA256 !==
          new Bun.CryptoHasher("sha256").update(value.objective).digest("hex")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["semanticAudit", "scope", "objectiveSHA256"],
          message: "Semantic audit objective commitment does not match the bound objective",
        })
      }
      if (
        value.semanticAudit &&
        value.semanticAudit.reviewer.name === value.benchmark.evaluator &&
        value.semanticAudit.reviewer.version === value.benchmark.evaluatorVersion
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["semanticAudit", "reviewer"],
          message: "Semantic review requires an identity distinct from the score evaluator",
        })
      }
      if (
        value.semanticAudit &&
        value.evaluatorAudit &&
        value.semanticAudit.reviewer.name === value.evaluatorAudit.auditor.name &&
        value.semanticAudit.reviewer.version === value.evaluatorAudit.auditor.version
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["semanticAudit", "reviewer"],
          message: "Semantic review and evaluator qualification require distinct identities",
        })
      }
      if (value.synthesis && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Clean-room synthesis requires a capability-authenticated evaluator source",
        })
      }
      if (value.synthesis && (value.benchmark.metric !== "factual_f1" || value.benchmark.direction !== "maximize")) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "metric"],
          message: "Scientific synthesis requires factual_f1 as a maximized primary metric",
        })
      }
      if (value.synthesis && !value.evaluatorAudit) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorAudit"],
          message: "Scientific synthesis requires independent evaluator qualification",
        })
      }
      if (
        value.synthesis &&
        value.evaluatorAudit &&
        ["wrong_answer", "unsupported_claim", "data_leakage"].some(
          (fault) => !value.evaluatorAudit?.requiredFaults.includes(fault as EvaluatorFault),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorAudit", "requiredFaults"],
          message: "Scientific synthesis qualification must test wrong answers, unsupported claims, and data leakage",
        })
      }
      if (value.synthesis && value.contamination.publicDataCutoff !== value.synthesis.cutoff) {
        ctx.addIssue({
          code: "custom",
          path: ["contamination", "publicDataCutoff"],
          message: "Scientific synthesis cutoff must match the frozen contamination policy",
        })
      }
      if (value.synthesis && value.synthesis.tools.some((tool) => !value.tools.includes(tool))) {
        ctx.addIssue({
          code: "custom",
          path: ["tools"],
          message: "Scientific synthesis retrieval tools must be present in the run tool allowlist",
        })
      }
      if (value.autonomy && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Human-AI autonomy tracing requires a capability-authenticated evaluator source",
        })
      }
      if (
        value.autonomy?.claimedLevel !== undefined &&
        value.autonomy.claimedLevel !== "essentially_autonomous" &&
        value.intervention !== "human_reprompted"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["intervention"],
          message: "Collaborative or primarily-human claims require the human_reprompted intervention label",
        })
      }
      if (value.formalProof && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Formal proof validation requires a capability-authenticated evaluator source",
        })
      }
      if (
        value.replication &&
        (!value.benchmark.metric || value.benchmark.direction === undefined || value.benchmark.target === undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["replication"],
          message: "Replicated evaluation requires a benchmark metric, direction, and target",
        })
      }
      if (
        value.replication &&
        (value.replication.decision.direction !== value.benchmark.direction ||
          value.replication.decision.target !== value.benchmark.target)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["replication", "decision"],
          message: "Replicated evaluation decision must match the bound benchmark direction and target",
        })
      }
      if (value.replication && value.benchmark.evaluatorSource === "human") {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark", "evaluatorSource"],
          message: "Replicated evaluation requires a capability-authenticated evaluator source",
        })
      }
      if (value.confirmation && value.profile !== "optimize") {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation"],
          message: "Sealed confirmation requires the optimize profile",
        })
      }
      if (value.confirmation && !value.search) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation"],
          message: "Sealed confirmation requires backend-managed adaptive search",
        })
      }
      if (value.confirmation && value.confirmation.optimization.split !== value.benchmark.split) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation", "optimization", "split"],
          message: "The confirmation optimization split must match the bound benchmark split",
        })
      }
      if (
        value.confirmation &&
        (value.confirmation.claim.metric !== value.benchmark.metric ||
          value.confirmation.claim.direction !== value.benchmark.direction ||
          value.confirmation.claim.target !== value.benchmark.target)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation", "claim"],
          message: "The sealed claim metric, direction, and target must match the optimization objective",
        })
      }
      if (
        value.confirmation &&
        value.confirmation.claim.evaluator.name === value.benchmark.evaluator &&
        value.confirmation.claim.evaluator.version === value.benchmark.evaluatorVersion &&
        value.confirmation.claim.evaluator.source === value.benchmark.evaluatorSource
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation", "claim", "evaluator"],
          message: "Sealed confirmation requires an evaluator identity distinct from optimization",
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
