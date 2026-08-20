import { SessionResearch } from "@/session/research"
import { Instance } from "@/project/instance"
import { Tool } from "./tool"
import z from "zod"

const Define = z.object({
  action: z.literal("define"),
  objective: z.string().trim().min(1).max(2_000),
  domain: SessionResearch.Domain.default("general"),
  template: SessionResearch.Template.default("empirical"),
  deliverables: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(1_000),
        label: z.string().trim().min(1).max(120),
        required: z.boolean().default(true),
      }),
    )
    .max(40)
    .describe("Complete required Result set. Omit to use the selected template defaults.")
    .optional(),
  reserve_usd: z.number().min(0).max(100).optional(),
})

const Stage = z.object({
  action: z.literal("stage"),
  stage: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  status: SessionResearch.Status,
  detail: z.string().trim().max(1_000).optional(),
  evidence: z
    .string()
    .trim()
    .max(2_000)
    .describe("Observed boundary evidence to retain as stage detail. This does not satisfy a verification check.")
    .optional(),
})

const Check = z
  .object({
    action: z.literal("check"),
    check: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["pending", "passed", "failed"]),
    evidence: z.string().trim().min(1).max(2_000).optional(),
    detail: z.string().trim().max(1_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "pending" && !value.evidence) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: `${value.status} checks require observed evidence` })
    }
  })

const Failure = z.object({
  action: z.literal("failure"),
  stage: z.string().trim().min(1).max(120),
  candidate: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(4_000),
  disposition: z.string().trim().max(1_000).optional(),
})

const Trial = z
  .object({
    action: z.literal("trial"),
    stage: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .describe("Contract stage ID that produced this attempt, such as solve or simulate."),
    branch: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .describe("Stable approach-family ID. Reuse it for refinements; change it for a genuinely different approach."),
    candidate: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .describe("Short unique label for the concrete hypothesis, method, fit, simulation, or evidence candidate."),
    outcome: SessionResearch.Outcome.describe(
      "Observable result: advanced, neutral, regressed, failed, or inconclusive.",
    ),
    summary: z.string().trim().min(1).max(2_000).describe("What was attempted and what the observable result showed."),
    evidence: z
      .string()
      .trim()
      .max(2_000)
      .describe("Artifact path, metric, source, or check supporting the outcome. Required for advanced or regressed.")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.outcome === "advanced" || value.outcome === "regressed") && !value.evidence) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: `${value.outcome} trials require evidence` })
    }
  })

const Learn = z.object({
  action: z.literal("learn"),
  source_trial: z.string().trim().min(1).max(200).describe("Trial ID returned by a prior material attempt."),
  situation: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Reusable project condition under which the lesson applies; never store a scientific conclusion here."),
  guidance: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe("Reusable method or operational guidance to test in later sessions."),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe("Artifact, metric, source, or check supporting the lesson. Defaults to the source trial's evidence.")
    .optional(),
})

const Unlearn = z.object({
  action: z.literal("unlearn"),
  lesson: z.string().regex(/^lesson-[a-f0-9]{20}$/),
  source_trial: z.string().trim().min(1).max(200).describe("Current-session trial that contradicts the lesson."),
  reason: z.string().trim().min(1).max(1_000),
  evidence: z.string().trim().min(1).max(2_000).describe("Counterevidence that invalidates the prior lesson."),
})

const Status = z.object({ action: z.literal("status") })

const Params = z
  .object({
    action: z.enum(["define", "stage", "check", "trial", "failure", "learn", "unlearn", "status"]),
    objective: Define.shape.objective.optional(),
    domain: SessionResearch.Domain.optional(),
    template: SessionResearch.Template.optional(),
    deliverables: Define.shape.deliverables,
    reserve_usd: Define.shape.reserve_usd,
    stage: Stage.shape.stage.optional(),
    check: Check.shape.check.optional(),
    label: Check.shape.label,
    status: z.enum(["pending", "running", "completed", "blocked", "passed", "failed"]).optional(),
    evidence: Check.shape.evidence,
    detail: Check.shape.detail,
    candidate: Failure.shape.candidate.optional(),
    message: Failure.shape.message.optional(),
    disposition: Failure.shape.disposition,
    branch: Trial.shape.branch.optional(),
    outcome: SessionResearch.Outcome.optional(),
    summary: Trial.shape.summary.optional(),
    source_trial: Learn.shape.source_trial.optional(),
    situation: Learn.shape.situation.optional(),
    guidance: Learn.shape.guidance.optional(),
    lesson: Unlearn.shape.lesson.optional(),
    reason: Unlearn.shape.reason.optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = [Define, Stage, Check, Trial, Failure, Learn, Unlearn, Status].find(
      (schema) => schema.safeParse(value).success,
    )
    if (parsed) return
    ctx.addIssue({ code: "custom", message: `Invalid fields for research contract action ${value.action}` })
  })

export const ResearchContractTool = Tool.define("research_contract", {
  description: [
    "Define and update the durable completion contract for a multi-stage research task.",
    "Use define before expensive work, stage at real lifecycle boundaries, check after deterministic verification,",
    "trial after every material research attempt, failure for a candidate that could not produce a valid result, and status to inspect the saved contract.",
    "A trial is a hypothesis, method, fit, simulation, or evidence branch that reached an observable outcome; do not record every command or transient tool error.",
    "For action trial, always provide stage, branch, candidate, outcome, and summary; also provide evidence when outcome is advanced or regressed.",
    "The domain's decision stage cannot be completed until at least one material trial has been recorded for that stage.",
    "Stage evidence is retained as lifecycle detail but never counts as a passed verification check; checks need their own observed evidence.",
    "Use learn only after an evidence-backed trial exposes reusable project method guidance; source-trial evidence is inherited when omitted, and the lesson remains tentative until an independent session supports it. Reinforce an injected lesson with its exact stored situation and guidance. Use unlearn with counterevidence when a prior no longer holds.",
    "The contract survives provider interruptions and drives trajectory-aware explore, refine, pivot, fuse, and verify guidance.",
  ].join(" "),
  parameters: Params,
  async execute(params, ctx) {
    const lesson = await (async () => {
      if (params.action === "learn") {
        const input = Learn.parse(params)
        return SessionResearch.learn(Instance.project.id, ctx.sessionID, {
          sourceTrial: input.source_trial,
          situation: input.situation,
          guidance: input.guidance,
          evidence: input.evidence,
        })
      }
      if (params.action === "unlearn") {
        const input = Unlearn.parse(params)
        return SessionResearch.unlearn(Instance.project.id, ctx.sessionID, {
          lesson: input.lesson,
          sourceTrial: input.source_trial,
          reason: input.reason,
          evidence: input.evidence,
        })
      }
    })()
    const contract = await (async () => {
      if (params.action === "define") {
        const input = Define.parse(params)
        return SessionResearch.define(ctx.sessionID, {
          objective: input.objective,
          domain: input.domain,
          template: input.template,
          deliverables: input.deliverables,
          reserveUsd: input.reserve_usd,
        })
      }
      if (params.action === "stage") {
        const input = Stage.parse(params)
        return SessionResearch.stage(ctx.sessionID, {
          id: input.stage,
          status: input.status,
          detail: input.detail ?? input.evidence,
        })
      }
      if (params.action === "check") {
        const input = Check.parse(params)
        return SessionResearch.check(ctx.sessionID, {
          id: input.check,
          label: input.label,
          status: input.status,
          evidence: input.evidence,
          detail: input.detail,
        })
      }
      if (params.action === "failure") {
        const input = Failure.parse(params)
        return SessionResearch.fail(
          ctx.sessionID,
          {
            stage: input.stage,
            candidate: input.candidate,
            message: input.message,
            disposition: input.disposition,
          },
          ctx.callID,
        )
      }
      if (params.action === "trial") {
        const input = Trial.parse(params)
        return SessionResearch.trial(
          ctx.sessionID,
          {
            stage: input.stage,
            branch: input.branch,
            candidate: input.candidate,
            outcome: input.outcome,
            summary: input.summary,
            evidence: input.evidence,
          },
          ctx.callID,
        )
      }
      const current = await SessionResearch.read(ctx.sessionID)
      if (!current) throw new Error("No research completion contract has been defined for this session")
      return current
    })()
    const completed = contract.stages.filter((stage) => stage.status === "completed").length
    const passed = contract.checks.filter((check) => check.status === "passed" && !!check.evidence?.trim()).length
    const failed = contract.checks.filter((check) => check.status === "failed").length
    const strategy = SessionResearch.strategy(contract)
    const lessons = await SessionResearch.experience(Instance.project.id, contract.domain)
    const active = lessons.filter((item) => item.status === "active")
    const recent = contract.trials.slice(-6)
    return {
      title:
        params.action === "define"
          ? "Research contract defined"
          : params.action === "learn" || params.action === "unlearn"
            ? "Research experience updated"
            : "Research contract updated",
      output: [
        `Objective: ${contract.objective}`,
        `Domain: ${contract.domain}`,
        `Stages: ${completed}/${contract.stages.length} complete`,
        `Checks: ${passed}/${contract.checks.length} passed${failed ? `, ${failed} failed` : ""}`,
        `Required Results: ${
          contract.deliverables
            .filter((item) => item.required)
            .map((item) => item.path)
            .join(", ") || "none"
        }`,
        `Recorded candidate failures: ${contract.failures.length}`,
        `Recorded material attempts: ${contract.trials.length}`,
        ...(recent.length
          ? ["Recent trial IDs:", ...recent.map((item) => `- ${item.id}: ${item.candidate} [${item.outcome}]`)]
          : []),
        `Trajectory mode: ${strategy.mode} - ${strategy.reason}`,
        `Active project lessons: ${active.length} (${active.filter((item) => item.confidence === "supported").length} independently supported)`,
        ...(lesson
          ? [
              `Lesson ${lesson.id}: ${lesson.status}, ${lesson.confidence}, supported by ${lesson.supports.length} recorded ${lesson.supports.length === 1 ? "observation" : "observations"}`,
            ]
          : []),
        `Managed-credit finalization reserve: $${contract.budget.reserveUsd.toFixed(2)}`,
      ].join("\n"),
      metadata: {
        researchContract: {
          action: params.action,
          domain: contract.domain,
          template: contract.template,
          completedStages: completed,
          totalStages: contract.stages.length,
          passedChecks: passed,
          totalChecks: contract.checks.length,
          failedChecks: failed,
          failedCandidates: contract.failures.length,
          materialAttempts: contract.trials.length,
          trajectoryMode: strategy.mode,
          activeLessons: active.length,
          supportedLessons: active.filter((item) => item.confidence === "supported").length,
          lessonID: lesson?.id,
          lessonStatus: lesson?.status,
        },
      },
    }
  },
})
