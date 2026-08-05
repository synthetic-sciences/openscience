import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessBenchmark } from "./benchmark"
import { HarnessContract } from "./contract"
import { HarnessLaunch } from "./launch"

export namespace HarnessOrchestrator {
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  export const WorkerAgent = z.enum(["task", "biology", "physics", "ml", "critique", "physics-critique", "reviewer"])
  const Agent = WorkerAgent
  const Status = z.enum(["pending", "executed", "completed", "failed", "cancelled"])
  const Lane = z.enum(["producer-a", "producer-b"])
  const WorkerPolicy = z.enum(["claimed-v1", "task-attested-v1"])

  const Usage = z
    .object({
      steps: z.number().int().nonnegative().optional(),
      tokens: z.number().int().nonnegative().optional(),
      costUSD: z.number().nonnegative().optional(),
      wallTimeMs: z.number().int().nonnegative().optional(),
    })
    .strict()

  const Allocation = Usage

  export const WorkerReceipt = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      workID: z.string().regex(/^[a-f0-9]{64}$/),
      workerSessionID: z.string().min(1),
      turnID: z.string().min(1),
      agent: Agent,
      workPromptSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      taskPromptSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      outcome: z.enum(["completed", "failed"]),
      usage: Usage,
      toolCalls: z.number().int().nonnegative(),
      failedToolCalls: z.number().int().nonnegative(),
      startedAt: z.number().int().positive(),
      completedAt: z.number().int().positive(),
      provisional: z.literal(true),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.failedToolCalls > value.toolCalls) {
        ctx.addIssue({ code: "custom", path: ["failedToolCalls"], message: "Failed tool calls exceed all tool calls" })
      }
      if (value.completedAt < value.startedAt) {
        ctx.addIssue({ code: "custom", path: ["completedAt"], message: "Worker receipt ends before it starts" })
      }
    })
  export type WorkerReceipt = z.infer<typeof WorkerReceipt>

  export const Verdict = z
    .object({
      decision: z.enum(["support", "reject", "abstain"]),
      severity: z.enum(["none", "minor", "critical", "unknown"]).optional(),
      confidence: z.number().min(0).max(1),
      checks: z
        .array(
          z
            .object({
              id: z.string().min(1).max(200),
              status: z.enum(["passed", "failed", "inconclusive"]),
              evidenceRefs: z.array(z.string().min(1).max(2_048)).min(1).max(16),
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.decision === "support" && value.checks.some((check) => check.status !== "passed")) {
        ctx.addIssue({ code: "custom", path: ["checks"], message: "A supporting verdict requires every check to pass" })
      }
      if (value.decision === "reject" && !value.checks.some((check) => check.status === "failed")) {
        ctx.addIssue({ code: "custom", path: ["checks"], message: "A rejecting verdict requires a failed check" })
      }
      if (value.decision === "abstain" && !value.checks.some((check) => check.status === "inconclusive")) {
        ctx.addIssue({
          code: "custom",
          path: ["checks"],
          message: "An abstaining verdict requires an inconclusive check",
        })
      }
      if (value.severity === undefined) return
      if (value.decision === "support" && value.severity !== "none") {
        ctx.addIssue({ code: "custom", path: ["severity"], message: "Supporting verdict severity must be none" })
      }
      if (value.decision === "reject" && !["minor", "critical"].includes(value.severity)) {
        ctx.addIssue({
          code: "custom",
          path: ["severity"],
          message: "Rejecting verdict severity must be minor or critical",
        })
      }
      if (value.decision === "abstain" && value.severity !== "unknown") {
        ctx.addIssue({
          code: "custom",
          path: ["severity"],
          message: "Abstaining verdict severity must be unknown",
        })
      }
    })
  export type Verdict = z.infer<typeof Verdict>

  const Submission = z
    .object({
      summary: z.string().min(1).max(8_000),
      artifactRefs: z.array(z.string().min(1).max(2_048)).max(32).default([]),
      evidenceRefs: z.array(z.string().min(1).max(2_048)).max(32).default([]),
      usage: Usage.optional(),
      verdict: Verdict.optional(),
    })
    .strict()

  export const Result = Submission.extend({
    completedAt: z.number().int().positive(),
  }).strict()
  export type Result = z.infer<typeof Result>

  export const CheckpointSubmit = z
    .object({
      evaluatorToken: z.string().min(32).max(1_024),
      round: z.number().int().min(1).max(8),
      utility: z.number().finite().min(0).max(1),
      uncertainty: z.number().finite().min(0).max(1),
      evidenceRefs: z
        .array(z.string().min(1).max(2_048))
        .min(1)
        .max(32)
        .refine((items) => new Set(items).size === items.length, "Checkpoint evidence references must be unique"),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()

  export const Checkpoint = CheckpointSubmit.omit({ evaluatorToken: true })
    .extend({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      gain: z.number().finite().nullable(),
      qualified: z.boolean(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Checkpoint = z.infer<typeof Checkpoint>

  const CheckpointInput = CheckpointSubmit.omit({ evaluatorToken: true })
    .extend({ sessionID: z.string().min(1) })
    .strict()

  const checkpointID = (fingerprint: string, sessionID: string, value: Omit<z.infer<typeof Checkpoint>, "id">) =>
    digest({
      fingerprint,
      sessionID,
      round: value.round,
      utility: value.utility,
      uncertainty: value.uncertainty,
      evidenceRefs: value.evidenceRefs,
      evaluatedAt: value.evaluatedAt,
      gain: value.gain,
      qualified: value.qualified,
      recordedAt: value.recordedAt,
    })

  function progress(config: HarnessContract.Adaptive, checkpoints: Checkpoint[], maxRounds: number) {
    return checkpoints.reduce(
      (state, item, index) => {
        const previous = checkpoints[index - 1]
        const gain = previous ? item.utility - previous.utility : null
        const qualified = item.uncertainty <= config.maxUncertainty
        const stalled = !qualified ? 0 : gain === null ? 0 : gain < config.minUtilityGain ? state.stalled + 1 : 0
        const target =
          qualified &&
          item.round >= config.minRounds &&
          config.targetUtility !== undefined &&
          item.utility >= config.targetUtility
        const exhausted = qualified && item.round >= config.minRounds && stalled >= config.patience
        const reason = target
          ? ("target_reached" as const)
          : exhausted
            ? ("marginal_utility_exhausted" as const)
            : item.round === maxRounds
              ? ("max_rounds" as const)
              : undefined
        return {
          stalled,
          expected: [...state.expected, { gain, qualified }],
          reasons: [...state.reasons, reason],
        }
      },
      {
        stalled: 0,
        expected: [] as Array<{ gain: number | null; qualified: boolean }>,
        reasons: [] as Array<"target_reached" | "marginal_utility_exhausted" | "max_rounds" | undefined>,
      },
    )
  }

  const Adaptive = HarnessContract.Adaptive.extend({
    checkpoints: z.array(Checkpoint).max(8),
    stalled: z.number().int().nonnegative().max(8),
    phase: z.enum(["searching", "finalizing"]),
    stopReason: z.enum(["target_reached", "marginal_utility_exhausted", "max_rounds"]).optional(),
  })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.checkpoints.map((item) => item.id)).size !== value.checkpoints.length) {
        ctx.addIssue({
          code: "custom",
          path: ["checkpoints"],
          message: "Adaptive checkpoint identities must be unique",
        })
      }
      if (value.checkpoints.some((item, index) => item.round !== index + 1)) {
        ctx.addIssue({ code: "custom", path: ["checkpoints"], message: "Adaptive checkpoints must be sequential" })
      }
      if (value.phase === "searching" && value.stopReason) {
        ctx.addIssue({
          code: "custom",
          path: ["stopReason"],
          message: "Searching orchestration cannot have a stop reason",
        })
      }
      if (value.phase === "finalizing" && !value.stopReason) {
        ctx.addIssue({
          code: "custom",
          path: ["stopReason"],
          message: "Finalizing orchestration requires a stop reason",
        })
      }
    })
  export type Adaptive = z.infer<typeof Adaptive>

  export const Work = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      role: HarnessContract.Role,
      label: z.string().min(1).max(160),
      round: z.number().int().nonnegative(),
      agent: Agent,
      dependencies: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(16)
        .refine((items) => new Set(items).size === items.length, "Work dependencies must be unique"),
      prompt: z.string().min(1).max(8_000),
      allocation: Allocation,
      lane: Lane.optional(),
      status: Status,
      workerSessionID: z.string().min(1).optional(),
      workerReceipt: WorkerReceipt.optional(),
      result: Result.optional(),
      failure: z.string().min(1).max(4_000).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.status === "completed" && !value.result) {
        ctx.addIssue({ code: "custom", path: ["result"], message: "Completed work requires a result" })
      }
      if (value.status === "completed" && !value.workerSessionID) {
        ctx.addIssue({ code: "custom", path: ["workerSessionID"], message: "Completed work requires a worker session" })
      }
      if (value.status === "failed" && !value.failure) {
        ctx.addIssue({ code: "custom", path: ["failure"], message: "Failed work requires a failure reason" })
      }
      if (value.status === "failed" && !value.workerSessionID) {
        ctx.addIssue({ code: "custom", path: ["workerSessionID"], message: "Failed work requires a worker session" })
      }
      if (value.status === "executed" && (!value.workerSessionID || !value.workerReceipt)) {
        ctx.addIssue({ code: "custom", message: "Executed work requires a worker receipt and session" })
      }
      if (value.status === "executed" && (value.result || value.failure)) {
        ctx.addIssue({ code: "custom", message: "Executed work cannot contain settled state" })
      }
      if (
        value.status === "pending" &&
        (value.result || value.failure || value.workerSessionID || value.workerReceipt)
      ) {
        ctx.addIssue({ code: "custom", message: "Pending work cannot contain settled state" })
      }
      if (
        value.status === "cancelled" &&
        (value.result || value.failure || value.workerSessionID || value.workerReceipt)
      ) {
        ctx.addIssue({ code: "custom", message: "Cancelled work cannot contain settled state" })
      }
      if (value.status === "completed" && value.failure) {
        ctx.addIssue({ code: "custom", path: ["failure"], message: "Completed work cannot contain a failure" })
      }
      if (value.status === "failed" && value.result) {
        ctx.addIssue({ code: "custom", path: ["result"], message: "Failed work cannot contain a result" })
      }
    })
  export type Work = z.infer<typeof Work>

  export const RepairRoute = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      attempt: z.number().int().min(1).max(8),
      candidateID: z.string().regex(/^[a-f0-9]{64}$/),
      actionID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      verifierIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .min(1)
        .max(2)
        .refine((items) => new Set(items).size === items.length, "Repair route verifiers must be unique"),
      decision: z.enum(["accept", "revise", "restart", "investigate"]),
      confidence: z.number().finite().min(0).max(1),
      evidenceRefs: z
        .array(z.string().min(1).max(2_048))
        .min(1)
        .max(128)
        .refine((items) => new Set(items).size === items.length, "Repair route evidence must be unique"),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type RepairRoute = z.infer<typeof RepairRoute>

  const Repair = HarnessContract.Repair.extend({
    phase: z.enum(["producing", "verifying", "investigating", "completed"]),
    candidateID: z.string().regex(/^[a-f0-9]{64}$/),
    verifierIDs: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(2)
      .refine((items) => new Set(items).size === items.length, "Repair panel verifiers must be unique"),
    evidenceID: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    routes: z.array(RepairRoute).max(8),
    stopReason: z.enum(["accepted", "attempt_limit", "work_failed"]).optional(),
  })
    .strict()
    .superRefine((value, ctx) => {
      if (value.phase === "verifying" && !value.verifierIDs.length) {
        ctx.addIssue({ code: "custom", path: ["verifierIDs"], message: "Verifying repair needs a verifier panel" })
      }
      if (value.phase !== "verifying" && value.verifierIDs.length) {
        ctx.addIssue({ code: "custom", path: ["verifierIDs"], message: "Only verification may retain a live panel" })
      }
      if (value.phase === "investigating" && !value.evidenceID) {
        ctx.addIssue({ code: "custom", path: ["evidenceID"], message: "Investigation needs an evidence work item" })
      }
      if (value.phase !== "investigating" && value.evidenceID) {
        ctx.addIssue({ code: "custom", path: ["evidenceID"], message: "Only investigation may retain evidence work" })
      }
      if (value.phase === "completed" && !value.stopReason) {
        ctx.addIssue({ code: "custom", path: ["stopReason"], message: "Completed repair needs a stop reason" })
      }
      if (value.phase !== "completed" && value.stopReason) {
        ctx.addIssue({ code: "custom", path: ["stopReason"], message: "Active repair cannot have a stop reason" })
      }
      if (value.routes.some((item, index) => item.attempt !== index + 1)) {
        ctx.addIssue({ code: "custom", path: ["routes"], message: "Repair routes must be sequential" })
      }
    })
  export type Repair = z.infer<typeof Repair>

  function routeID(fingerprint: string, sessionID: string, route: Omit<RepairRoute, "id"> | RepairRoute) {
    return digest({
      fingerprint,
      sessionID,
      attempt: route.attempt,
      candidateID: route.candidateID,
      actionID: route.actionID,
      verifierIDs: route.verifierIDs,
      decision: route.decision,
      confidence: route.confidence,
      evidenceRefs: route.evidenceRefs,
      recordedAt: route.recordedAt,
    })
  }

  function decision(verifiers: Work[], minConfidence: number): RepairRoute["decision"] {
    const verdicts = verifiers.map((item) => item.result?.verdict)
    if (verdicts.some((item) => item?.decision === "reject" && item.severity === "critical")) return "restart"
    if (verdicts.some((item) => item?.decision === "abstain" || item?.severity === "unknown")) return "investigate"
    if (verdicts.some((item) => item?.decision === "reject" && item.severity === "minor")) return "revise"
    if (verdicts.every((item) => item?.decision === "support" && item.confidence >= minConfidence)) return "accept"
    return "investigate"
  }

  function lane(work: Pick<Work, "role" | "label">) {
    if (work.role === "generation" && work.label === "seed-a") return "producer-a" as const
    if (work.role === "generation" && work.label === "seed-b") return "producer-b" as const
    if (work.role === "evolution" && /^evolved-candidate-\d+$/.test(work.label)) return "producer-a" as const
    if (work.role === "evolution" && /^divergent-candidate-\d+$/.test(work.label)) return "producer-b" as const
  }

  function workID(
    runID: string,
    work: Pick<Work, "role" | "label" | "dependencies" | "round" | "lane">,
    policy: "legacy-v1" | "fresh-v1" | "producer-lanes-v1",
    workers: z.infer<typeof WorkerPolicy>,
  ) {
    return digest({
      runID,
      role: work.role,
      label: work.label,
      dependencies: work.dependencies,
      round: work.round,
      ...(policy === "legacy-v1" ? {} : { sessionPolicy: policy }),
      ...(workers === "claimed-v1" ? {} : { workerPolicy: workers }),
      ...(work.lane ? { lane: work.lane } : {}),
    })
  }

  function receiptID(fingerprint: string, runID: string, receipt: Omit<WorkerReceipt, "id">) {
    return digest({
      fingerprint,
      runID,
      workID: receipt.workID,
      workerSessionID: receipt.workerSessionID,
      turnID: receipt.turnID,
      agent: receipt.agent,
      workPromptSHA256: receipt.workPromptSHA256,
      taskPromptSHA256: receipt.taskPromptSHA256,
      outcome: receipt.outcome,
      usage: receipt.usage,
      toolCalls: receipt.toolCalls,
      failedToolCalls: receipt.failedToolCalls,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      provisional: receipt.provisional,
    })
  }

  export const Selection = z
    .object({
      topology: HarnessContract.Topology.exclude(["auto"]),
      source: z.enum(["contract", "policy"]),
      reasons: z.array(z.string().min(1)).min(1),
      traits: HarnessContract.Traits,
    })
    .strict()
  export type Selection = z.infer<typeof Selection>

  export const Consensus = z
    .object({
      status: z.enum(["supported", "rejected", "disputed", "insufficient"]),
      verifierCount: z.number().int().nonnegative(),
      support: z.number().int().nonnegative(),
      reject: z.number().int().nonnegative(),
      abstain: z.number().int().nonnegative(),
      confidence: z.number().min(0).max(1),
      evidenceRefs: z.array(z.string().min(1).max(2_048)).max(128),
      provisional: z.literal(true),
      derivedAt: z.number().int().positive(),
    })
    .strict()
  export type Consensus = z.infer<typeof Consensus>

  function summarize(verifiers: Work[], derivedAt: number) {
    const verdicts = verifiers.flatMap((item) => (item.result?.verdict ? [item.result.verdict] : []))
    const support = verdicts.filter((verdict) => verdict.decision === "support").length
    const reject = verdicts.filter((verdict) => verdict.decision === "reject").length
    const abstain = verdicts.filter((verdict) => verdict.decision === "abstain").length
    const status =
      verdicts.length < 2
        ? "insufficient"
        : support === verdicts.length
          ? "supported"
          : reject === verdicts.length
            ? "rejected"
            : "disputed"
    const evidenceRefs = [
      ...new Set(
        verifiers.flatMap((item) => [
          ...(item.result?.evidenceRefs ?? []),
          ...(item.result?.verdict?.checks.flatMap((check) => check.evidenceRefs) ?? []),
        ]),
      ),
    ]
    return Consensus.parse({
      status,
      verifierCount: verdicts.length,
      support,
      reject,
      abstain,
      confidence: verdicts.length
        ? verdicts.reduce((sum, verdict) => sum + verdict.confidence, 0) / verdicts.length
        : 0,
      evidenceRefs,
      provisional: true,
      derivedAt,
    })
  }

  export const State = z
    .object({
      schemaVersion: z.literal(3),
      protocolVersion: z.enum(["coalition-v1", "coalition-v2", "coalition-v3"]),
      sessionPolicy: z.enum(["legacy-v1", "fresh-v1", "producer-lanes-v1"]),
      workerPolicy: WorkerPolicy,
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      contractFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      objective: z.string().min(1),
      selection: Selection,
      maxWorkers: z.number().int().min(1).max(2),
      maxRounds: z.number().int().min(1).max(8),
      minIndependentVerifiers: z.number().int().min(1).max(2),
      status: z.enum(["active", "awaiting_checkpoint", "completed"]),
      adaptive: Adaptive.optional(),
      repair: Repair.optional(),
      consensus: Consensus.optional(),
      work: z.record(z.string(), Work),
      order: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
      revision: z.number().int().nonnegative(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Orchestration order must be unique" })
      }
      if (Object.keys(value.work).length !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["work"], message: "Orchestration work must exactly match its order" })
      }
      const items = Object.values(value.work)
      if (value.sessionPolicy === "producer-lanes-v1" && value.selection.topology !== "evolution") {
        ctx.addIssue({ code: "custom", path: ["sessionPolicy"], message: "Producer lanes require evolution topology" })
      }
      for (const work of items) {
        const expected = value.sessionPolicy === "producer-lanes-v1" ? lane(work) : undefined
        if (work.lane !== expected) {
          ctx.addIssue({ code: "custom", path: ["work", work.id, "lane"], message: "Producer lane assignment drifted" })
        }
        if (work.id !== workID(value.runID, work, value.sessionPolicy, value.workerPolicy)) {
          ctx.addIssue({
            code: "custom",
            path: ["work", work.id, "id"],
            message: "Orchestration work identity drifted",
          })
        }
      }
      const turns = new Set<string>()
      for (const work of items) {
        const receipt = work.workerReceipt
        if (value.workerPolicy === "task-attested-v1" && ["executed", "completed", "failed"].includes(work.status)) {
          if (!receipt) {
            ctx.addIssue({ code: "custom", path: ["work", work.id], message: "Settled work lacks a Task receipt" })
            continue
          }
        }
        if (!receipt) continue
        if (value.workerPolicy !== "task-attested-v1") {
          ctx.addIssue({
            code: "custom",
            path: ["work", work.id],
            message: "Claimed worker state cannot contain receipts",
          })
        }
        if (
          receipt.workID !== work.id ||
          receipt.workerSessionID !== work.workerSessionID ||
          receipt.agent !== work.agent ||
          receipt.workPromptSHA256 !== digest(work.prompt) ||
          receipt.id !== receiptID(value.contractFingerprint, value.runID, receipt)
        ) {
          ctx.addIssue({ code: "custom", path: ["work", work.id, "workerReceipt"], message: "Worker receipt drifted" })
        }
        if (receipt.startedAt < value.createdAt || receipt.completedAt > value.updatedAt) {
          ctx.addIssue({
            code: "custom",
            path: ["work", work.id, "workerReceipt"],
            message: "Worker receipt falls outside the persisted orchestration window",
          })
        }
        if (turns.has(receipt.turnID)) {
          ctx.addIssue({ code: "custom", path: ["work"], message: "A Task turn cannot attest multiple work items" })
        }
        turns.add(receipt.turnID)
        if (work.status === "completed" && receipt.outcome !== "completed") {
          ctx.addIssue({ code: "custom", path: ["work", work.id], message: "Completed work has a failed Task receipt" })
        }
      }
      const sessions = new Map<string, Work[]>()
      for (const work of items) {
        if (!work.workerSessionID) continue
        sessions.set(work.workerSessionID, [...(sessions.get(work.workerSessionID) ?? []), work])
      }
      for (const works of sessions.values()) {
        if (works.length === 1) continue
        const lanes = new Set(works.map((work) => work.lane))
        if (
          value.sessionPolicy === "producer-lanes-v1" &&
          lanes.size === 1 &&
          !lanes.has(undefined) &&
          works.every((work) => ["generation", "evolution"].includes(work.role))
        ) {
          continue
        }
        ctx.addIssue({
          code: "custom",
          path: ["work"],
          message: "Coalition worker session crossed isolation boundaries",
        })
      }
      if (value.sessionPolicy === "producer-lanes-v1") {
        for (const name of Lane.options) {
          const works = items.filter((work) => work.lane === name && work.workerSessionID)
          if (new Set(works.map((work) => work.workerSessionID)).size <= 1) continue
          ctx.addIssue({ code: "custom", path: ["work"], message: `Producer lane ${name} changed worker session` })
        }
      }
      if (value.consensus && value.status !== "completed") {
        ctx.addIssue({ code: "custom", path: ["consensus"], message: "Consensus requires settled orchestration" })
      }
      if (value.adaptive && value.protocolVersion !== "coalition-v2") {
        ctx.addIssue({
          code: "custom",
          path: ["protocolVersion"],
          message: "Adaptive orchestration requires coalition-v2",
        })
      }
      if (value.repair && value.protocolVersion !== "coalition-v3") {
        ctx.addIssue({
          code: "custom",
          path: ["protocolVersion"],
          message: "Verifier-routed repair requires coalition-v3",
        })
      }
      if (value.repair && value.selection.topology !== "verifier_loop") {
        ctx.addIssue({ code: "custom", path: ["repair"], message: "Repair state requires verifier_loop topology" })
      }
      if (value.status === "awaiting_checkpoint" && !value.adaptive) {
        ctx.addIssue({ code: "custom", path: ["status"], message: "Only adaptive orchestration awaits checkpoints" })
      }
      if (value.adaptive?.checkpoints.some((item) => item.round > value.maxRounds)) {
        ctx.addIssue({ code: "custom", path: ["adaptive", "checkpoints"], message: "Checkpoint exceeds max rounds" })
      }
      if (
        value.adaptive?.checkpoints.some(
          (item) => item.id !== checkpointID(value.contractFingerprint, value.sessionID, item),
        )
      ) {
        ctx.addIssue({ code: "custom", path: ["adaptive", "checkpoints"], message: "Checkpoint content hash drifted" })
      }
      if (value.adaptive) {
        const derived = progress(value.adaptive, value.adaptive.checkpoints, value.maxRounds)
        if (
          value.adaptive.checkpoints.some((item, index) => {
            const expected = derived.expected[index]!
            return item.gain !== expected.gain || item.qualified !== expected.qualified
          })
        ) {
          ctx.addIssue({ code: "custom", path: ["adaptive", "checkpoints"], message: "Checkpoint derivation drifted" })
        }
        if (derived.reasons.slice(0, -1).some((reason) => reason !== undefined)) {
          ctx.addIssue({
            code: "custom",
            path: ["adaptive", "checkpoints"],
            message: "Checkpoints continued after a stop",
          })
        }
        const reason = derived.reasons.at(-1)
        const phase = reason ? "finalizing" : "searching"
        if (
          value.adaptive.stalled !== derived.stalled ||
          value.adaptive.phase !== phase ||
          value.adaptive.stopReason !== reason
        ) {
          ctx.addIssue({ code: "custom", path: ["adaptive"], message: "Adaptive control state drifted" })
        }
      }
      if (value.repair) {
        const items = Object.values(value.work)
        if (value.repair.routes.length > value.maxRounds) {
          ctx.addIssue({ code: "custom", path: ["repair", "routes"], message: "Repair exceeded attempt limit" })
        }
        if (!value.work[value.repair.candidateID]) {
          ctx.addIssue({ code: "custom", path: ["repair", "candidateID"], message: "Repair candidate is missing" })
        }
        if (value.repair.verifierIDs.some((id) => value.work[id]?.role !== "verification")) {
          ctx.addIssue({ code: "custom", path: ["repair", "verifierIDs"], message: "Repair panel drifted" })
        }
        if (value.repair.evidenceID && value.work[value.repair.evidenceID]?.role !== "investigation") {
          ctx.addIssue({ code: "custom", path: ["repair", "evidenceID"], message: "Repair evidence work drifted" })
        }
        for (const route of value.repair.routes) {
          const verifiers = route.verifierIDs.map((id) => value.work[id]).filter((item): item is Work => !!item)
          const action = route.actionID ? value.work[route.actionID] : undefined
          const terminal = route.decision === "accept" || route.attempt === value.maxRounds
          const expectedRole =
            route.decision === "revise"
              ? "revision"
              : route.decision === "restart"
                ? "generation"
                : route.decision === "investigate"
                  ? "investigation"
                  : undefined
          const expectedDependencies =
            route.decision === "restart" ? route.verifierIDs : [route.candidateID, ...route.verifierIDs]
          const expectedLabel =
            route.decision === "revise"
              ? `targeted-revision-${route.attempt}`
              : route.decision === "restart"
                ? `clean-restart-${route.attempt}`
                : `evidence-investigation-${route.attempt}`
          if (
            route.id !== routeID(value.contractFingerprint, value.sessionID, route) ||
            verifiers.length !== value.minIndependentVerifiers ||
            verifiers.some((item) => item.status !== "completed" || item.role !== "verification") ||
            route.candidateID !== verifiers[0]?.dependencies[0] ||
            route.verifierIDs.some((id) => value.work[id]?.dependencies[0] !== route.candidateID) ||
            route.decision !== decision(verifiers, value.repair.minConfidence) ||
            terminal === !!action ||
            (!!action &&
              (action.role !== expectedRole ||
                action.label !== expectedLabel ||
                action.round !== route.attempt ||
                JSON.stringify(action.dependencies) !== JSON.stringify(expectedDependencies)))
          ) {
            ctx.addIssue({ code: "custom", path: ["repair", "routes"], message: "Repair route derivation drifted" })
            break
          }
          const evidenceRefs = [
            ...new Set(
              verifiers.flatMap((item) => [
                ...(item.result?.evidenceRefs ?? []),
                ...(item.result?.verdict?.checks.flatMap((check) => check.evidenceRefs) ?? []),
              ]),
            ),
          ]
          const confidence =
            verifiers.reduce((sum, item) => sum + (item.result?.verdict?.confidence ?? 0), 0) / verifiers.length
          if (JSON.stringify(route.evidenceRefs) !== JSON.stringify(evidenceRefs) || route.confidence !== confidence) {
            ctx.addIssue({ code: "custom", path: ["repair", "routes"], message: "Repair route evidence drifted" })
            break
          }
        }
        const final = value.repair.routes.at(-1)
        if (
          value.repair.stopReason === "accepted" &&
          (final?.decision !== "accept" || value.repair.routes.length > value.maxRounds)
        ) {
          ctx.addIssue({ code: "custom", path: ["repair", "stopReason"], message: "Repair acceptance drifted" })
        }
        if (value.repair.stopReason === "attempt_limit" && value.repair.routes.length !== value.maxRounds) {
          ctx.addIssue({ code: "custom", path: ["repair", "stopReason"], message: "Repair attempt stop drifted" })
        }
        if (value.repair.stopReason === "attempt_limit" && final?.decision === "accept") {
          ctx.addIssue({ code: "custom", path: ["repair", "stopReason"], message: "Accepted repair cannot exhaust" })
        }
        if (value.repair.stopReason === "work_failed" && !items.some((item) => item.status === "failed")) {
          ctx.addIssue({ code: "custom", path: ["repair", "stopReason"], message: "Repair failure stop drifted" })
        }
        if (value.repair.phase === "completed" && value.status !== "completed") {
          ctx.addIssue({ code: "custom", path: ["status"], message: "Completed repair must settle orchestration" })
        }
        if (value.repair.phase !== "completed" && value.status === "completed") {
          ctx.addIssue({ code: "custom", path: ["status"], message: "Active repair cannot settle orchestration" })
        }
      }
      if (
        value.consensus &&
        value.consensus.support + value.consensus.reject + value.consensus.abstain !== value.consensus.verifierCount
      ) {
        ctx.addIssue({ code: "custom", path: ["consensus"], message: "Consensus verdict counts do not reconcile" })
      }
      if (value.consensus) {
        const final = value.repair?.stopReason === "work_failed" ? undefined : value.repair?.routes.at(-1)
        const verifiers = final
          ? final.verifierIDs.map((id) => value.work[id]!).filter(Boolean)
          : value.repair
            ? []
            : value.order.map((id) => value.work[id]!).filter((item) => item.role === "verification")
        if (JSON.stringify(value.consensus) !== JSON.stringify(summarize(verifiers, value.consensus.derivedAt))) {
          ctx.addIssue({ code: "custom", path: ["consensus"], message: "Consensus derivation drifted" })
        }
      }
      const seen = new Set<string>()
      for (const id of value.order) {
        const work = value.work[id]
        if (!work) {
          ctx.addIssue({ code: "custom", path: ["work", id], message: "Orchestration work is missing" })
          continue
        }
        if (work.id !== id) {
          ctx.addIssue({ code: "custom", path: ["work", id, "id"], message: "Orchestration work id drifted" })
        }
        for (const dependency of work.dependencies) {
          if (seen.has(dependency)) continue
          ctx.addIssue({
            code: "custom",
            path: ["work", id, "dependencies"],
            message: `Dependency ${dependency} must precede ${id}`,
          })
        }
        seen.add(id)
      }
    })
  export type State = z.infer<typeof State>

  export type Ready = Work & {
    resumeSessionID?: string
    context: Array<{
      id: string
      role: HarnessContract.Role
      summary: string
      artifactRefs: string[]
      evidenceRefs: string[]
    }>
  }

  const root = path.join(Global.Path.data, "harness", "orchestration")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const evolving = (role: HarnessContract.Role) => ["proximity", "reflection", "ranking", "evolution"].includes(role)

  function parse(data: Record<string, unknown>) {
    const migrated =
      data.schemaVersion === 1
        ? { ...data, schemaVersion: 3, sessionPolicy: "legacy-v1" as const, workerPolicy: "claimed-v1" as const }
        : data.schemaVersion === 2
          ? { ...data, schemaVersion: 3, workerPolicy: "claimed-v1" as const }
          : data
    return State.parse(migrated)
  }

  const required: Record<Exclude<HarnessContract.Topology, "auto">, HarnessContract.Role[]> = {
    solo: ["generation"],
    centralized: ["generation", "reflection", "verification"],
    fork_join: ["generation", "simulation", "synthesis", "verification"],
    tournament: ["generation", "proximity", "reflection", "ranking", "verification"],
    evolution: ["generation", "proximity", "reflection", "ranking", "evolution", "investigation", "verification"],
    verifier_loop: ["generation", "revision", "verification", "investigation"],
  }

  function supports(topology: Exclude<HarnessContract.Topology, "auto">, roles?: HarnessContract.Role[]) {
    if (!roles) return true
    return required[topology].every((role) => roles.includes(role))
  }

  export function infer(contract: HarnessContract.Info): HarnessContract.Traits {
    const benchmark = HarnessBenchmark.resolve(contract.benchmark.name)
    const text = `${contract.objective} ${benchmark.task}`.toLowerCase()
    const profile = contract.profile
    const packs = contract.packs ?? []
    const decomposability = clamp(
      (benchmark.family === "generalist" ? 0.78 : 0.48) +
        (packs.length > 1 ? 0.12 : 0) +
        (/multi[- ]?step|end[- ]?to[- ]?end|workflow|survey|portfolio/.test(text) ? 0.12 : 0),
    )
    const sequentiality = clamp(
      (profile === "theory" ? 0.82 : profile === "reproduce" ? 0.66 : 0.38) +
        (/proof|derive|derivation|replay|protocol order/.test(text) ? 0.12 : 0),
    )
    const toolIntensity = clamp(
      Math.max(contract.tools.length / 12, ["numerical", "training", "forecast"].includes(profile) ? 0.72 : 0.35),
    )
    const uncertainty = clamp(
      (["optimize", "reproduce"].includes(profile) ? 0.68 : 0.42) +
        (/discover|novel|unknown|open[- ]ended|hypothesis/.test(text) ? 0.2 : 0),
    )
    const verificationRisk = clamp(
      (["held_out", "release"].includes(contract.benchmark.split) ? 0.72 : 0.48) +
        (packs.length ? 0.12 : 0) +
        (/sota|state.of.the.art|causal|mechanis|safety/.test(text) ? 0.14 : 0),
    )
    const novelty = clamp(
      (profile === "optimize" ? 0.68 : 0.38) + (/discover|novel|evolve|improve|new method/.test(text) ? 0.22 : 0),
    )
    const crossDomain = clamp(packs.length / 3 + (benchmark.family === "generalist" ? 0.3 : 0))
    return HarnessContract.Traits.parse({
      decomposability,
      sequentiality,
      toolIntensity,
      uncertainty,
      verificationRisk,
      novelty,
      crossDomain,
    })
  }

  export function select(contract: HarnessContract.Info): Selection {
    const config = contract.orchestration
    const traits = config?.traits ?? infer(contract)
    const roles = config?.roles
    if (config?.topology && config.topology !== "auto") {
      if (!supports(config.topology, roles)) {
        throw new Error(`Orchestration roles do not permit the contract topology ${config.topology}`)
      }
      return Selection.parse({ topology: config.topology, source: "contract", reasons: ["contract-topology"], traits })
    }
    const workers = config?.maxWorkers ?? 2
    const steps = contract.budget.steps ?? Number.POSITIVE_INFINITY
    const tokens = contract.budget.tokens ?? Number.POSITIVE_INFINITY
    const candidates = contract.budget.candidates ?? Number.POSITIVE_INFINITY
    const small = workers === 1 || steps < 24 || tokens < 12_000 || candidates < 2
    const choose = (topology: Exclude<HarnessContract.Topology, "auto">, reasons: string[]): Selection | undefined =>
      supports(topology, roles) && (topology !== "verifier_loop" || !!config?.repair)
        ? Selection.parse({ topology, source: "policy", reasons, traits })
        : undefined
    if (small) return choose("solo", ["bounded-coordination-budget"]) ?? selectSolo(traits, roles)
    if (traits.sequentiality >= 0.72 && traits.decomposability < 0.58) {
      return (
        (traits.verificationRisk >= 0.62
          ? (choose("verifier_loop", ["sequential-task", "verifier-routed-repair"]) ??
            choose("centralized", ["sequential-task", "verification-gate"]))
          : choose("solo", ["sequential-task"])) ?? selectSolo(traits, roles)
      )
    }
    if (traits.toolIntensity >= 0.76 && traits.decomposability < 0.64) {
      return choose("centralized", ["tool-coordination-overhead", "central-control"]) ?? selectSolo(traits, roles)
    }
    if (traits.novelty >= 0.7 && traits.uncertainty >= 0.66) {
      return choose("evolution", ["open-ended-search", "high-uncertainty"]) ?? selectSolo(traits, roles)
    }
    if (traits.uncertainty >= 0.62 && traits.verificationRisk >= 0.66) {
      return choose("tournament", ["independent-hypotheses", "pairwise-critique"]) ?? selectSolo(traits, roles)
    }
    if (traits.decomposability >= 0.66 || traits.crossDomain >= 0.64) {
      return choose("fork_join", ["decomposable-work", "bounded-parallelism"]) ?? selectSolo(traits, roles)
    }
    if (traits.verificationRisk >= 0.62) {
      return (
        choose("verifier_loop", ["verifier-routed-repair"]) ??
        choose("centralized", ["verification-gate"]) ??
        selectSolo(traits, roles)
      )
    }
    return selectSolo(traits, roles)
  }

  function verify(state: State, contract: HarnessContract.Info) {
    if (state.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Orchestration state belongs to a different contract`)
    }
    const selection = select(contract)
    const config = contract.orchestration
    const adaptive = state.adaptive
      ? {
          protocolVersion: state.adaptive.protocolVersion,
          minRounds: state.adaptive.minRounds,
          patience: state.adaptive.patience,
          minUtilityGain: state.adaptive.minUtilityGain,
          maxUncertainty: state.adaptive.maxUncertainty,
          targetUtility: state.adaptive.targetUtility,
        }
      : undefined
    const repair = state.repair
      ? { protocolVersion: state.repair.protocolVersion, minConfidence: state.repair.minConfidence }
      : undefined
    const protocol = config?.repair ? "coalition-v3" : config?.adaptive ? "coalition-v2" : "coalition-v1"
    if (
      state.objective !== contract.objective ||
      JSON.stringify(state.selection) !== JSON.stringify(selection) ||
      state.maxWorkers !== (config?.maxWorkers ?? 2) ||
      state.maxRounds !== (config?.maxRounds ?? 2) ||
      state.minIndependentVerifiers !== (config?.minIndependentVerifiers ?? 1) ||
      JSON.stringify(adaptive) !== JSON.stringify(config?.adaptive) ||
      JSON.stringify(repair) !== JSON.stringify(config?.repair) ||
      (state.workerPolicy === "task-attested-v1" && state.protocolVersion !== protocol)
    ) {
      throw new Error(`Orchestration control state drifted from its bound contract`)
    }
    return state
  }

  function selectSolo(traits: HarnessContract.Traits, roles?: HarnessContract.Role[]): Selection {
    if (!supports("solo", roles)) throw new Error(`Orchestration roles must permit generation`)
    return Selection.parse({ topology: "solo", source: "policy", reasons: ["coordination-not-justified"], traits })
  }

  function agent(role: HarnessContract.Role, contract: HarnessContract.Info) {
    if (role === "reflection" || role === "investigation") {
      return contract.profile === "theory" || contract.profile === "numerical" ? "physics-critique" : "critique"
    }
    if (role === "verification") {
      return contract.profile === "theory" || contract.profile === "numerical" ? "physics-critique" : "reviewer"
    }
    if (["proximity", "ranking", "synthesis"].includes(role)) return "task"
    const family = HarnessBenchmark.resolve(contract.benchmark.name).family
    if (family === "biology") return "biology"
    if (family === "physics") return "physics"
    if (family === "ml" || contract.profile === "training" || contract.profile === "forecast") return "ml"
    return "task"
  }

  function instruction(role: HarnessContract.Role) {
    const lines: Record<HarnessContract.Role, string> = {
      generation:
        "Develop one independent, executable solution or hypothesis. State assumptions and produce artifact references.",
      proximity:
        "Cluster upstream proposals by mechanism and failure mode. Preserve distinct ideas; do not select a winner.",
      reflection:
        "Adversarially test upstream work for correctness, novelty, leakage, and missing controls. Return actionable falsifiers.",
      ranking:
        "Run pairwise comparisons using the declared objective and evidence. Emit a provisional ranking with uncertainty.",
      evolution:
        "Create a new candidate by combining verified strengths while explicitly avoiding documented failure modes.",
      revision:
        "Repair only the evidence-backed failed checks in the upstream candidate. Preserve supported components, expose every change, and return a complete replacement artifact rather than a patch to hidden reasoning.",
      verification:
        "Verify from a fresh session using artifacts and observable evidence only. Do not trust producer conclusions or hidden reasoning. Return support, reject, or abstain with confidence and evidence-backed checks; classify severity as none, minor, critical, or unknown; do not inspect another verifier's verdict.",
      investigation:
        "Acquire observable evidence for inconclusive checks and search for counterexamples, edge cases, sabotage, reward hacking, and distribution-shift failures. Do not revise the candidate.",
      simulation:
        "Execute the appropriate simulator or numerical check and report configuration, invariants, convergence, and artifacts.",
      synthesis:
        "Join upstream outputs without erasing disagreement. Separate supported results, unresolved conflicts, and next tests.",
    }
    return lines[role]
  }

  function unit(
    contract: HarnessContract.Info,
    selection: Selection,
    role: HarnessContract.Role,
    label: string,
    dependencies: string[] = [],
    round = 0,
    lane?: z.infer<typeof Lane>,
  ): Omit<Work, "allocation"> {
    const policy = selection.topology === "evolution" ? "producer-lanes-v1" : "fresh-v1"
    const id = workID(contract.runID, { role, label, dependencies, round, lane }, policy, "task-attested-v1")
    return {
      id,
      role,
      label,
      round,
      agent: agent(role, contract),
      dependencies,
      ...(lane ? { lane } : {}),
      prompt: [
        `<scientific-coalition role="${role}" topology="${selection.topology}" round="${round}"${lane ? ` lane="${lane}"` : ""}>`,
        `Objective: ${contract.objective}`,
        instruction(role),
        ...(lane
          ? [
              "This is a persistent producer lane. On resumed rounds, inspect the new dependency artifacts and feedback, retain only useful tested context, and use tools to propose, test, repair, and critique the edit before returning one candidate.",
              "Lane memory is search context only. It cannot certify a benchmark result, replace observable evidence, or influence verifier authority.",
            ]
          : []),
        ...(selection.topology === "verifier_loop" && role === "generation" && label.startsWith("clean-restart-")
          ? [
              "Start from a blank solution. Use upstream verifier summaries only as failure constraints; do not reconstruct, quote, or minimally edit the rejected candidate.",
            ]
          : []),
        ...(selection.topology === "verifier_loop" && role === "verification"
          ? [
              "Severity is controller input: none means all checks pass; minor means a localized correction can preserve the candidate premise; critical means the premise or global reasoning is invalid; unknown means evidence is insufficient.",
              "The backend, not this worker, chooses accept, revise, restart, or investigate after every independent verifier settles.",
            ]
          : []),
        "Return a concise result, artifact references, evidence references, and actual resource usage.",
        "Your output is provisional orchestration state, never benchmark evidence or a final scientific claim.",
        "</scientific-coalition>",
      ].join("\n"),
      status: "pending",
    }
  }

  function plan(contract: HarnessContract.Info, selection: Selection) {
    const items: Array<Omit<Work, "allocation">> = []
    const add = (
      role: HarnessContract.Role,
      label: string,
      dependencies: string[] = [],
      round = 0,
      lane?: z.infer<typeof Lane>,
    ) => {
      const item = unit(contract, selection, role, label, dependencies, round, lane)
      items.push(item)
      return item.id
    }
    const verify = (dependencies: string[], round: number) =>
      Array.from({ length: contract.orchestration?.minIndependentVerifiers ?? 1 }, (_, index) =>
        add("verification", `independent-verification-${index + 1}`, dependencies, round),
      )
    if (selection.topology === "solo") add("generation", "direct-solution")
    if (selection.topology === "centralized") {
      const generated = add("generation", "central-proposal")
      const reflected = add("reflection", "central-critique", [generated])
      verify([generated, reflected], 1)
    }
    if (selection.topology === "fork_join") {
      const generated = add("generation", "analytical-branch")
      const simulated = add("simulation", "computational-branch")
      const synthesis = add("synthesis", "evidence-join", [generated, simulated], 1)
      verify([synthesis], 1)
    }
    if (selection.topology === "tournament") {
      const first = add("generation", "independent-proposal-a")
      const second = add("generation", "independent-proposal-b")
      const proximity = add("proximity", "proposal-map", [first, second])
      const reflection = add("reflection", "tournament-critique", [first, second, proximity])
      const ranking = add("ranking", "pairwise-ranking", [proximity, reflection], 1)
      verify([first, second, ranking], 1)
    }
    if (selection.topology === "evolution") {
      const first = add("generation", "seed-a", [], 0, "producer-a")
      const second = add("generation", "seed-b", [], 0, "producer-b")
      const evolved = Array.from({ length: contract.orchestration?.maxRounds ?? 2 }).reduce(
        (parents: string[], _, index) => {
          const round = index + 1
          const proximity = add("proximity", `mechanism-map-${round}`, parents, round)
          const reflection = add("reflection", `adversarial-reflection-${round}`, [...parents, proximity], round)
          const ranking = add("ranking", `pairwise-tournament-${round}`, [proximity, reflection], round)
          return [
            add("evolution", `evolved-candidate-${round}`, [ranking, reflection], round, "producer-a"),
            add("evolution", `divergent-candidate-${round}`, [ranking, reflection], round, "producer-b"),
          ]
        },
        [first, second],
      )
      const investigation = add("investigation", "failure-discovery", evolved, contract.orchestration?.maxRounds ?? 2)
      verify([...evolved, investigation], (contract.orchestration?.maxRounds ?? 2) + 1)
    }
    if (selection.topology === "verifier_loop") add("generation", "initial-candidate")
    return items
  }

  function allocation(contract: HarnessContract.Info, count: number): z.infer<typeof Allocation> {
    const share = (value: number | undefined) => (value === undefined ? undefined : Math.floor(value / count))
    return Allocation.parse({
      steps: share(contract.budget.steps),
      tokens: share(contract.budget.tokens),
      costUSD: contract.budget.costUSD === undefined ? undefined : contract.budget.costUSD / count,
      wallTimeMs: share(contract.budget.wallTimeMs),
    })
  }

  export async function initialize(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    await HarnessLaunch.ready(contract)
    const selection = select(contract)
    const planned = plan(contract, selection)
    if (!planned.length) throw new Error(`Orchestration policy produced no work`)
    const capacity = contract.orchestration?.repair
      ? contract.orchestration.maxRounds * (contract.orchestration.minIndependentVerifiers + 1)
      : planned.length
    if (contract.budget.steps !== undefined && contract.budget.steps < capacity) {
      throw new Error(`Contract step budget cannot allocate one step to every orchestration unit`)
    }
    const budget = allocation(contract, capacity)
    const work = Object.fromEntries(planned.map((item) => [item.id, Work.parse({ ...item, allocation: budget })]))
    const now = Date.now()
    const state = State.parse({
      schemaVersion: 3,
      protocolVersion: contract.orchestration?.repair
        ? "coalition-v3"
        : contract.orchestration?.adaptive
          ? "coalition-v2"
          : "coalition-v1",
      sessionPolicy: selection.topology === "evolution" ? "producer-lanes-v1" : "fresh-v1",
      workerPolicy: "task-attested-v1",
      runID: contract.runID,
      sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      objective: contract.objective,
      selection,
      maxWorkers: contract.orchestration?.maxWorkers ?? 2,
      maxRounds: contract.orchestration?.maxRounds ?? 2,
      minIndependentVerifiers: contract.orchestration?.minIndependentVerifiers ?? 1,
      status: "active",
      adaptive: contract.orchestration?.adaptive
        ? {
            ...contract.orchestration.adaptive,
            checkpoints: [],
            stalled: 0,
            phase: "searching",
          }
        : undefined,
      repair: contract.orchestration?.repair
        ? {
            ...contract.orchestration.repair,
            phase: "producing",
            candidateID: planned[0]!.id,
            verifierIDs: [],
            routes: [],
          }
        : undefined,
      work,
      order: planned.map((item) => item.id),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    await JsonStore.update(file(sessionID), (data) => {
      if (!Object.keys(data).length) return state
      const current = parse(data)
      if (current.contractFingerprint === state.contractFingerprint) return current
      throw new Error(`Orchestration state belongs to a different contract`)
    })
    return read(sessionID)
  }

  export async function read(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    return verify(parse(await JsonStore.read(file(sessionID))), contract)
  }

  function resume(state: State, work: Work) {
    if (state.sessionPolicy !== "producer-lanes-v1" || !work.lane) return
    const index = state.order.indexOf(work.id)
    return state.order
      .slice(0, index)
      .map((id) => state.work[id]!)
      .findLast((item) => item.lane === work.lane && item.status === "completed")?.workerSessionID
  }

  function worker(state: State, work: Work, sessionID: string) {
    const expected = resume(state, work)
    if (expected) {
      if (sessionID !== expected) {
        throw new Error(`Producer lane ${work.lane} must resume its prior worker session`)
      }
      return
    }
    if (Object.values(state.work).some((item) => item.workerSessionID === sessionID)) {
      throw new Error(`Each fresh coalition role requires a distinct worker session`)
    }
  }

  const WorkerAttestation = z
    .object({
      sessionID: z.string().min(1),
      workID: z.string().regex(/^[a-f0-9]{64}$/),
      workerSessionID: z.string().min(1),
      turnID: z.string().min(1),
      agent: Agent,
      prompt: z.string().min(1).max(128_000),
      outcome: z.enum(["completed", "failed"]),
      usage: Usage,
      toolCalls: z.number().int().nonnegative(),
      failedToolCalls: z.number().int().nonnegative(),
      startedAt: z.number().int().positive(),
      completedAt: z.number().int().positive(),
    })
    .strict()

  export async function attest(input: z.input<typeof WorkerAttestation>) {
    const value = WorkerAttestation.parse(input)
    const contract = await HarnessContract.read(value.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${value.sessionID}`)
    await JsonStore.update(file(value.sessionID), (data) => {
      const state = verify(parse(data), contract)
      if (state.workerPolicy !== "task-attested-v1") {
        throw new Error(`Legacy orchestration does not accept Task execution receipts`)
      }
      const work = state.work[value.workID]
      if (!work) throw new Error(`Unknown orchestration work ${value.workID}`)
      const base = {
        workID: work.id,
        workerSessionID: value.workerSessionID,
        turnID: value.turnID,
        agent: value.agent,
        workPromptSHA256: digest(work.prompt),
        taskPromptSHA256: digest(value.prompt),
        outcome: value.outcome,
        usage: Usage.parse(value.usage),
        toolCalls: value.toolCalls,
        failedToolCalls: value.failedToolCalls,
        startedAt: value.startedAt,
        completedAt: value.completedAt,
        provisional: true as const,
      }
      const receipt = WorkerReceipt.parse({
        id: receiptID(state.contractFingerprint, state.runID, base),
        ...base,
      })
      if (work.status === "executed") {
        if (JSON.stringify(work.workerReceipt) === JSON.stringify(receipt)) return state
        throw new Error(`Task execution receipt is immutable`)
      }
      if (work.status !== "pending") throw new Error(`Orchestration work ${work.id} cannot accept a Task receipt`)
      if (!ready(state).some((item) => item.id === work.id)) {
        throw new Error(`Orchestration work is not ready for Task execution`)
      }
      if (value.agent !== work.agent) throw new Error(`Task execution used the wrong coalition agent`)
      if (!value.prompt.includes(work.prompt)) throw new Error(`Task execution omitted the canonical coalition prompt`)
      const now = Date.now()
      if (value.startedAt < state.createdAt || value.completedAt > now) {
        throw new Error(`Task execution timestamps fall outside the orchestration window`)
      }
      if (Object.values(state.work).some((item) => item.workerReceipt?.turnID === value.turnID)) {
        throw new Error(`Task turn already attests another orchestration work item`)
      }
      worker(state, work, value.workerSessionID)
      return State.parse({
        ...state,
        work: {
          ...state.work,
          [work.id]: {
            ...work,
            status: "executed",
            workerSessionID: value.workerSessionID,
            workerReceipt: receipt,
          },
        },
        revision: state.revision + 1,
        updatedAt: now,
      })
    })
    return read(value.sessionID)
  }

  export function ready(state: State): Ready[] {
    const current = State.parse(state)
    return current.order.flatMap((id) => {
      const work = current.work[id]!
      if (work.status !== "pending") return []
      if (!work.dependencies.every((dependency) => current.work[dependency]?.status === "completed")) return []
      if (
        current.adaptive &&
        evolving(work.role) &&
        work.round > 1 &&
        !current.adaptive.checkpoints.some((item) => item.round === work.round - 1)
      ) {
        return []
      }
      if (
        current.adaptive &&
        work.role === "investigation" &&
        !current.adaptive.checkpoints.some((item) => item.round === work.round)
      ) {
        return []
      }
      const context = work.dependencies.map((dependency) => {
        const parent = current.work[dependency]!
        return {
          id: parent.id,
          role: parent.role,
          summary: parent.result!.summary,
          artifactRefs: parent.result!.artifactRefs,
          evidenceRefs: parent.result!.evidenceRefs,
        }
      })
      const sessionID = resume(current, work)
      return [{ ...work, ...(sessionID ? { resumeSessionID: sessionID } : {}), context }]
    })
  }

  function within(usage: z.infer<typeof Usage> | undefined, budget: z.infer<typeof Allocation>) {
    if (!usage) return
    const checks: Array<[keyof z.infer<typeof Usage>, number | undefined, number | undefined]> = [
      ["steps", usage.steps, budget.steps],
      ["tokens", usage.tokens, budget.tokens],
      ["costUSD", usage.costUSD, budget.costUSD],
      ["wallTimeMs", usage.wallTimeMs, budget.wallTimeMs],
    ]
    const exceeded = checks.find(([, value, limit]) => value !== undefined && limit !== undefined && value > limit)
    if (exceeded) throw new Error(`Work exceeded its ${exceeded[0]} allocation`)
  }

  function due(state: Pick<State, "adaptive" | "order" | "work">) {
    if (!state.adaptive || state.adaptive.phase !== "searching") return
    const round = state.adaptive.checkpoints.length + 1
    const items = state.order.map((id) => state.work[id]!).filter((item) => item.round === round && evolving(item.role))
    if (!items.length || items.some((item) => item.status !== "completed")) return
    return round
  }

  function append(state: State, items: Array<Omit<Work, "allocation">>) {
    const budget = state.work[state.order[0]!]!.allocation
    const added = items.map((item) => Work.parse({ ...item, allocation: budget }))
    return {
      ...state,
      work: Object.fromEntries([...Object.entries(state.work), ...added.map((item) => [item.id, item] as const)]),
      order: [...state.order, ...added.map((item) => item.id)],
    }
  }

  function panel(state: State, contract: HarnessContract.Info, dependencies: string[], attempt: number) {
    const verifiers = Array.from({ length: state.minIndependentVerifiers }, (_, index) =>
      unit(
        contract,
        state.selection,
        "verification",
        `repair-verification-${attempt}-${index + 1}`,
        dependencies,
        attempt,
      ),
    )
    const next = append(state, verifiers)
    return State.parse({
      ...next,
      repair: {
        ...state.repair!,
        phase: "verifying",
        verifierIDs: verifiers.map((item) => item.id),
        evidenceID: undefined,
      },
    })
  }

  function advance(state: State, contract: HarnessContract.Info, now: number): State {
    if (!state.repair) return state
    if (state.repair.phase === "completed") return state
    if (state.repair.phase === "producing") {
      const candidate = state.work[state.repair.candidateID]!
      if (["failed", "cancelled"].includes(candidate.status)) {
        return State.parse({
          ...state,
          status: "completed",
          repair: { ...state.repair, phase: "completed", verifierIDs: [], stopReason: "work_failed" },
        })
      }
      if (candidate.status !== "completed") return state
      return panel(state, contract, [candidate.id], state.repair.routes.length + 1)
    }
    if (state.repair.phase === "investigating") {
      const evidence = state.work[state.repair.evidenceID!]!
      if (["failed", "cancelled"].includes(evidence.status)) {
        return State.parse({
          ...state,
          status: "completed",
          repair: {
            ...state.repair,
            phase: "completed",
            verifierIDs: [],
            evidenceID: undefined,
            stopReason: "work_failed",
          },
        })
      }
      if (evidence.status !== "completed") return state
      return panel(
        { ...state, repair: { ...state.repair, verifierIDs: [], evidenceID: undefined } },
        contract,
        [state.repair.candidateID, evidence.id],
        state.repair.routes.length + 1,
      )
    }
    const verifiers = state.repair.verifierIDs.map((id) => state.work[id]!)
    if (verifiers.some((item) => !["completed", "failed", "cancelled"].includes(item.status))) return state
    if (verifiers.some((item) => item.status !== "completed")) {
      return State.parse({
        ...state,
        status: "completed",
        repair: { ...state.repair, phase: "completed", verifierIDs: [], stopReason: "work_failed" },
      })
    }
    const route = decision(verifiers, state.repair.minConfidence)
    const attempt = state.repair.routes.length + 1
    const stopping = route === "accept" || attempt === state.maxRounds
    const dependencies =
      route === "restart" ? state.repair.verifierIDs : [state.repair.candidateID, ...state.repair.verifierIDs]
    const role =
      route === "revise"
        ? ("revision" as const)
        : route === "restart"
          ? ("generation" as const)
          : ("investigation" as const)
    const label =
      route === "revise"
        ? `targeted-revision-${attempt}`
        : route === "restart"
          ? `clean-restart-${attempt}`
          : `evidence-investigation-${attempt}`
    const action = stopping ? undefined : unit(contract, state.selection, role, label, dependencies, attempt)
    const evidenceRefs = [
      ...new Set(
        verifiers.flatMap((item) => [
          ...item.result!.evidenceRefs,
          ...item.result!.verdict!.checks.flatMap((check) => check.evidenceRefs),
        ]),
      ),
    ]
    const record = {
      attempt,
      candidateID: state.repair.candidateID,
      actionID: action?.id,
      verifierIDs: state.repair.verifierIDs,
      decision: route,
      confidence:
        verifiers.reduce((sum, item) => sum + item.result!.verdict!.confidence, 0) / state.minIndependentVerifiers,
      evidenceRefs,
      recordedAt: now,
    }
    const recorded = RepairRoute.parse({ id: routeID(state.contractFingerprint, state.sessionID, record), ...record })
    const routes = [...state.repair.routes, recorded]
    if (stopping) {
      return State.parse({
        ...state,
        status: "completed",
        repair: {
          ...state.repair,
          phase: "completed",
          verifierIDs: [],
          routes,
          stopReason: route === "accept" ? "accepted" : "attempt_limit",
        },
      })
    }
    if (!action) throw new Error(`Repair route did not produce its required action`)
    const next = append(state, [action])
    if (route === "investigate") {
      return State.parse({
        ...next,
        repair: {
          ...state.repair,
          phase: "investigating",
          verifierIDs: [],
          evidenceID: action.id,
          routes,
        },
      })
    }
    return State.parse({
      ...next,
      repair: {
        ...state.repair,
        phase: "producing",
        candidateID: action.id,
        verifierIDs: [],
        routes,
      },
    })
  }

  function settle(state: State, now: number): State {
    const work = Object.fromEntries(
      state.order.map((id) => {
        const item = state.work[id]!
        const blocked = item.dependencies.some((dependency) =>
          ["failed", "cancelled"].includes(state.work[dependency]?.status ?? "pending"),
        )
        return [id, blocked && item.status === "pending" ? { ...item, status: "cancelled" as const } : item]
      }),
    )
    const done = Object.values(work).every((item) => ["completed", "failed", "cancelled"].includes(item.status))
    const checkpoint = due({ ...state, work })
    const final = state.repair?.stopReason === "work_failed" ? undefined : state.repair?.routes.at(-1)
    const verifiers = final
      ? final.verifierIDs.map((id) => work[id]!)
      : state.repair
        ? []
        : state.order.map((id) => work[id]!).filter((item) => item.role === "verification")
    const consensus = done ? summarize(verifiers, now) : undefined
    const status = state.repair
      ? state.repair.phase === "completed" && done
        ? "completed"
        : "active"
      : done
        ? "completed"
        : checkpoint
          ? "awaiting_checkpoint"
          : "active"
    return State.parse({ ...state, work, status, consensus, updatedAt: now })
  }

  function finale(state: State, contract: HarnessContract.Info, round: number) {
    const parents = state.order.filter((id) => {
      const item = state.work[id]!
      return item.role === "evolution" && item.round === round && item.status === "completed"
    })
    if (parents.length < 2)
      throw new Error(`Adaptive finalization requires two completed candidates from round ${round}`)
    const probeBudget = state.order
      .map((id) => state.work[id]!)
      .find((item) => item.role === "investigation")?.allocation
    const verifyBudget = state.order
      .map((id) => state.work[id]!)
      .find((item) => item.role === "verification")?.allocation
    if (!probeBudget || !verifyBudget)
      throw new Error(`Adaptive finalization could not reserve investigation and verification`)
    const cancelled = Object.fromEntries(
      state.order.map((id) => {
        const item = state.work[id]!
        const stop =
          item.status === "pending" && (item.round > round || ["investigation", "verification"].includes(item.role))
        return [id, stop ? { ...item, status: "cancelled" as const } : item]
      }),
    )
    const probe = Work.parse({
      ...unit(contract, state.selection, "investigation", `adaptive-failure-discovery-${round}`, parents, round),
      allocation: probeBudget,
    })
    const verifiers = Array.from({ length: state.minIndependentVerifiers }, (_, index) =>
      Work.parse({
        ...unit(
          contract,
          state.selection,
          "verification",
          `adaptive-independent-verification-${index + 1}-${round}`,
          [...parents, probe.id],
          round + 1,
        ),
        allocation: verifyBudget,
      }),
    )
    return State.parse({
      ...state,
      work: Object.fromEntries([
        ...Object.entries(cancelled),
        [probe.id, probe],
        ...verifiers.map((item) => [item.id, item] as const),
      ]),
      order: [...state.order, probe.id, ...verifiers.map((item) => item.id)],
    })
  }

  export async function checkpoint(input: z.input<typeof CheckpointInput>, contract: HarnessContract.Info) {
    const value = CheckpointInput.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    if (bound.sessionID !== value.sessionID) throw new Error(`Utility checkpoint does not match the harness contract`)
    await JsonStore.update(file(value.sessionID), (data) => {
      const state = verify(parse(data), bound)
      if (!state.adaptive) throw new Error(`Orchestration does not declare adaptive marginal-utility control`)
      const existing = state.adaptive.checkpoints.find((item) => item.round === value.round)
      if (existing) {
        const previous = {
          round: existing.round,
          utility: existing.utility,
          uncertainty: existing.uncertainty,
          evidenceRefs: existing.evidenceRefs,
          evaluatedAt: existing.evaluatedAt,
        }
        const submitted = {
          round: value.round,
          utility: value.utility,
          uncertainty: value.uncertainty,
          evidenceRefs: value.evidenceRefs,
          evaluatedAt: value.evaluatedAt,
        }
        if (JSON.stringify(previous) === JSON.stringify(submitted)) return state
        throw new Error(`Adaptive checkpoint for round ${value.round} is immutable`)
      }
      if (state.adaptive.phase !== "searching") throw new Error(`Adaptive search is already finalizing`)
      const expected = state.adaptive.checkpoints.length + 1
      if (value.round !== expected) throw new Error(`Expected adaptive checkpoint for round ${expected}`)
      if (due(state) !== value.round) throw new Error(`Adaptive round ${value.round} has not completed`)
      const completed = state.order
        .map((id) => state.work[id]!)
        .filter((item) => item.round === value.round && evolving(item.role))
        .map((item) => item.result!.completedAt)
      const now = Date.now()
      if (value.evaluatedAt < Math.max(bound.createdAt, ...completed)) {
        throw new Error(`Adaptive checkpoint predates the completed round`)
      }
      if (value.evaluatedAt > now + 300_000) throw new Error(`Adaptive checkpoint timestamp is implausibly far ahead`)
      const previous = state.adaptive.checkpoints.at(-1)
      const gain = previous ? value.utility - previous.utility : null
      const qualified = value.uncertainty <= state.adaptive.maxUncertainty
      const stalled = !qualified
        ? 0
        : gain === null
          ? 0
          : gain < state.adaptive.minUtilityGain
            ? state.adaptive.stalled + 1
            : 0
      const target =
        qualified &&
        value.round >= state.adaptive.minRounds &&
        state.adaptive.targetUtility !== undefined &&
        value.utility >= state.adaptive.targetUtility
      const exhausted = qualified && value.round >= state.adaptive.minRounds && stalled >= state.adaptive.patience
      const reason = target
        ? "target_reached"
        : exhausted
          ? "marginal_utility_exhausted"
          : value.round === state.maxRounds
            ? "max_rounds"
            : undefined
      const record = {
        round: value.round,
        utility: value.utility,
        uncertainty: value.uncertainty,
        evidenceRefs: value.evidenceRefs,
        evaluatedAt: value.evaluatedAt,
        gain,
        qualified,
        recordedAt: now,
      }
      const checkpoint = Checkpoint.parse({
        id: checkpointID(state.contractFingerprint, state.sessionID, record),
        ...record,
      })
      const adaptive: Adaptive = {
        ...state.adaptive,
        checkpoints: [...state.adaptive.checkpoints, checkpoint],
        stalled,
        phase: reason ? "finalizing" : "searching",
        stopReason: reason,
      }
      const updated = State.parse({
        ...state,
        adaptive,
        status: "active",
        revision: state.revision + 1,
        updatedAt: now,
      })
      const next = reason && value.round < state.maxRounds ? finale(updated, bound, value.round) : updated
      return settle(next, now)
    })
    return read(value.sessionID)
  }

  export async function complete(input: {
    sessionID: string
    workID: string
    workerSessionID: string
    result: z.input<typeof Submission>
  }) {
    const submission = Submission.parse(input.result)
    const contract = await HarnessContract.read(input.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${input.sessionID}`)
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = verify(parse(data), contract)
      const work = state.work[input.workID]
      if (!work) throw new Error(`Unknown orchestration work ${input.workID}`)
      const usage = work.workerReceipt?.usage ?? submission.usage
      const submitted = { ...submission, ...(usage ? { usage } : {}) }
      if (work.status === "completed") {
        const previous = {
          summary: work.result!.summary,
          artifactRefs: work.result!.artifactRefs,
          evidenceRefs: work.result!.evidenceRefs,
          usage: work.result!.usage,
          verdict: work.result!.verdict,
        }
        if (work.workerSessionID === input.workerSessionID && JSON.stringify(previous) === JSON.stringify(submitted)) {
          return state
        }
        throw new Error(`Completed orchestration work is immutable`)
      }
      if (state.workerPolicy === "task-attested-v1" && work.status !== "executed") {
        throw new Error(`Orchestration work must be executed by the Task tool before completion`)
      }
      if (state.workerPolicy === "claimed-v1" && work.status !== "pending") {
        throw new Error(`Orchestration work ${input.workID} is not pending`)
      }
      if (!work.dependencies.every((dependency) => state.work[dependency]?.status === "completed")) {
        throw new Error(`Orchestration work cannot complete before its dependencies`)
      }
      if (state.workerPolicy === "claimed-v1") worker(state, work, input.workerSessionID)
      if (state.workerPolicy === "task-attested-v1" && work.workerSessionID !== input.workerSessionID) {
        throw new Error(`Coalition completion does not match the Task execution receipt`)
      }
      if (work.workerReceipt?.outcome === "failed") {
        throw new Error(`A failed Task execution cannot complete coalition work`)
      }
      if (
        work.workerReceipt &&
        submission.usage &&
        JSON.stringify(submission.usage) !== JSON.stringify(work.workerReceipt.usage)
      ) {
        throw new Error(`Coalition usage does not match the Task execution receipt`)
      }
      if (work.role === "verification" && !submission.verdict) {
        throw new Error(`Verification work requires a structured verdict`)
      }
      if (work.role === "verification" && !submission.evidenceRefs.length) {
        throw new Error(`Verification work requires observable evidence references`)
      }
      if (state.repair && work.role === "verification" && !submission.verdict?.severity) {
        throw new Error(`Verifier-routed repair requires a severity classification`)
      }
      if (work.role !== "verification" && submission.verdict) {
        throw new Error(`Only verification work may submit a verdict`)
      }
      const now = Date.now()
      const result = Result.parse({ ...submitted, completedAt: now })
      within(result.usage, work.allocation)
      const next: State = {
        ...state,
        work: {
          ...state.work,
          [work.id]: { ...work, status: "completed", workerSessionID: input.workerSessionID, result },
        },
        revision: state.revision + 1,
        updatedAt: now,
      }
      return settle(advance(next, contract, now), now)
    })
    return read(input.sessionID)
  }

  export async function fail(input: { sessionID: string; workID: string; workerSessionID: string; failure: string }) {
    const contract = await HarnessContract.read(input.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${input.sessionID}`)
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = verify(parse(data), contract)
      const work = state.work[input.workID]
      if (!work) throw new Error(`Unknown orchestration work ${input.workID}`)
      if (work.status === "failed") {
        if (work.workerSessionID === input.workerSessionID && work.failure === input.failure) return state
        throw new Error(`Failed orchestration work is immutable`)
      }
      if (state.workerPolicy === "task-attested-v1" && work.status !== "executed") {
        throw new Error(`Orchestration work must be executed by the Task tool before failure settlement`)
      }
      if (state.workerPolicy === "claimed-v1" && work.status !== "pending") {
        throw new Error(`Orchestration work ${input.workID} is not pending`)
      }
      if (!work.dependencies.every((dependency) => state.work[dependency]?.status === "completed")) {
        throw new Error(`Orchestration work cannot fail before its dependencies`)
      }
      if (state.workerPolicy === "claimed-v1") worker(state, work, input.workerSessionID)
      if (state.workerPolicy === "task-attested-v1" && work.workerSessionID !== input.workerSessionID) {
        throw new Error(`Coalition failure does not match the Task execution receipt`)
      }
      const now = Date.now()
      const next: State = {
        ...state,
        work: {
          ...state.work,
          [work.id]: {
            ...work,
            status: "failed",
            workerSessionID: input.workerSessionID,
            failure: z.string().min(1).max(4_000).parse(input.failure),
          },
        },
        revision: state.revision + 1,
        updatedAt: now,
      }
      return settle(advance(next, contract, now), now)
    })
    return read(input.sessionID)
  }
}
