import { SessionResearch } from "@/session/research"
import { Instance } from "@/project/instance"
import { ArtifactStore } from "@/artifact/store"
import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"
import { Tool } from "./tool"
import z from "zod"

const EvidenceRequests = z
  .array(z.string().trim().min(3).max(1_000))
  .min(1)
  .max(8)
  .describe("Runtime-verified refs: artifact:<id>, artifact-path:<path>, tool:<name>, or tool-call:<id>.")

const Domain = z.enum([
  "general",
  "statistics",
  "biology",
  "physics",
  "chemistry",
  "ml",
  "weather",
  "posttrain",
  "evidence",
])

const Define = z.object({
  action: z.literal("define"),
  objective: z.string().trim().min(1).max(2_000),
  domain: Domain.default("general"),
  template: SessionResearch.Template.default("minimal"),
  deliverables: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(1_000),
        label: z.string().trim().min(1).max(120),
        required: z.boolean().default(true),
      }),
    )
    .max(40)
    .optional(),
  reserve_usd: z.number().min(0).max(100).optional(),
  max_model_calls: z.number().int().positive().max(10_000).optional(),
  max_tool_calls: z.number().int().positive().max(100_000).optional(),
  max_tokens: z.number().int().positive().max(1_000_000_000).optional(),
  max_minutes: z
    .number()
    .positive()
    .max(30 * 24 * 60)
    .optional(),
  max_cost_usd: z.number().positive().max(100_000).optional(),
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
    .describe("Lifecycle detail only; never passes a verification check.")
    .optional(),
})

const Check = z
  .object({
    action: z.literal("check"),
    check: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["pending", "passed", "failed"]),
    evidence: z.string().trim().min(1).max(2_000).optional(),
    evidence_refs: EvidenceRequests.optional(),
    detail: z.string().trim().max(1_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "pending" && !value.evidence_refs?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence_refs"],
        message: `${value.status} checks require runtime-verified evidence references`,
      })
    }
  })

const Failure = z.object({
  action: z.literal("failure"),
  stage: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Contract stage ID. Omit to use the active or next pending stage.")
    .optional(),
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
      .describe("Contract stage ID that produced this attempt."),
    branch: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    candidate: z.string().trim().min(1).max(240).describe("Unique label for the concrete candidate."),
    outcome: SessionResearch.Outcome.describe("Observed result."),
    summary: z.string().trim().min(1).max(2_000),
    evidence: z
      .string()
      .trim()
      .max(2_000)
      .describe("Supporting artifact, metric, source, or check; required for advanced/regressed.")
      .optional(),
    evidence_refs: EvidenceRequests.optional(),
    metric: SessionResearch.Metric.optional().describe(
      "Optional quantitative result. When baseline is supplied, the runtime rejects an outcome that contradicts the metric direction.",
    ),
  })
  .superRefine((value, ctx) => {
    if ((value.outcome === "advanced" || value.outcome === "regressed") && !value.evidence_refs?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence_refs"],
        message: `${value.outcome} trials require runtime-verified evidence references`,
      })
    }
  })

const Learn = z.object({
  action: z.literal("learn"),
  source_trial: z.string().trim().min(1).max(200),
  situation: z.string().trim().min(1).max(500),
  guidance: z.string().trim().min(1).max(1_000),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe("Support for the lesson; defaults to source-trial evidence.")
    .optional(),
  evidence_refs: EvidenceRequests.optional(),
})

const Unlearn = z.object({
  action: z.literal("unlearn"),
  lesson: z.string().regex(/^lesson-[a-f0-9]{20}$/),
  source_trial: z.string().trim().min(1).max(200).describe("Current trial contradicting the lesson."),
  reason: z.string().trim().min(1).max(1_000),
  evidence: z.string().trim().min(1).max(2_000).describe("Counterevidence invalidating the lesson."),
  evidence_refs: EvidenceRequests,
})

const Status = z.object({ action: z.literal("status") })

const Preregister = z.object({
  action: z.literal("preregister"),
  evidence_refs: EvidenceRequests.length(1).refine(
    (refs) => refs[0]?.startsWith("artifact:") || refs[0]?.startsWith("artifact-path:"),
    "Preregistration requires exactly one immutable artifact reference",
  ),
})

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function authority(ctx: Tool.Context) {
  const assistant = ctx.messages.find(
    (message) => message.info.role === "assistant" && message.info.id === ctx.messageID,
  )
  const parent = assistant?.info.role === "assistant" ? assistant.info.parentID : undefined
  const direct = parent
    ? ctx.messages.find((message) => message.info.role === "user" && message.info.id === parent)
    : undefined
  const candidate =
    direct ??
    ctx.messages.findLast(
      (message) =>
        message.info.role === "user" &&
        message.info.internal?.type !== "continuation" &&
        message.info.internal?.type !== "compaction",
    )
  const epoch =
    candidate?.info.role === "user" && candidate.info.internal?.type === "continuation"
      ? candidate.info.internal.epoch
      : undefined
  const owner = epoch
    ? ctx.messages.find((message) => message.info.role === "user" && message.info.id === epoch)
    : candidate
  if (owner?.info.role !== "user") return ""
  return owner.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
    .toLowerCase()
    .replace(/(?<=\d)[,_](?=\d)/g, "")
}

function authorized(text: string, value: number, unit: RegExp) {
  const amount = escape(String(value))
  const pair = new RegExp(
    `(?:${unit.source}[^,.;\\n]{0,24}(?<![\\d.])${amount}(?![\\d.])|(?<![\\d.])${amount}(?![\\d.])[^,.;\\n]{0,24}${unit.source})`,
    "i",
  )
  const match = pair.exec(text)
  if (!match) return false
  const start = Math.max(0, match.index - 64)
  const end = Math.min(text.length, match.index + match[0].length + 64)
  const window = text.slice(start, end)
  const limit =
    /\b(max(?:imum)?|limit|cap|ceiling|budget|up to|at most|no more than|(?:do not|don't) exceed|stop after|within)\b/i
  const denied =
    /\b(?:(?:do not|don't)\s+(?:set|use|apply|enforce|impose|add|create)|not set|without (?:a )?(?:hard )?(?:limit|cap|ceiling|budget)|unlimited|uncapped)\b/i
  return limit.test(window) && !denied.test(window)
}

function assertLimits(input: z.infer<typeof Define>, ctx: Tool.Context) {
  const text = authority(ctx)
  const limits = [
    ["max_model_calls", input.max_model_calls, /(?:model|inference)[\s-]*calls?/i],
    ["max_tool_calls", input.max_tool_calls, /tool[\s-]*calls?/i],
    ["max_tokens", input.max_tokens, /tokens?/i],
    ["max_minutes", input.max_minutes, /minutes?|mins?/i],
    ["max_cost_usd", input.max_cost_usd, /(?:usd|dollars?|\$)/i],
  ] as const
  for (const [field, value, unit] of limits) {
    if (value === undefined || authorized(text, value, unit)) continue
    throw new Error(
      `${field}=${value} is not an exact hard ceiling authorized by the current user request. Omit ${field} and use the runtime default.`,
    )
  }
}

async function evidenceContext(sessionID: string) {
  const sessions = new Set<string>()
  const visit = async (id: string): Promise<MessageV2.WithParts[]> => {
    if (sessions.has(id)) return []
    sessions.add(id)
    const [messages, children] = await Promise.all([Session.messages({ sessionID: id }), Session.children(id)])
    return [messages, ...(await Promise.all(children.map((child) => visit(child.id))))].flat()
  }
  const [messages, artifacts] = await Promise.all([visit(sessionID), ArtifactStore.list(Instance.project.id)])
  return { sessions, messages, artifacts }
}

async function evidence(
  requests: z.infer<typeof EvidenceRequests> | undefined,
  sessionID: string,
): Promise<SessionResearch.EvidenceReference[]> {
  if (!requests?.length) return []
  const context = await evidenceContext(sessionID)
  return Promise.all(
    requests.map(async (request) => {
      const parsed = (() => {
        if (request.startsWith("artifact-path:")) {
          return { kind: "artifact" as const, path: request.slice("artifact-path:".length) }
        }
        if (request.startsWith("artifact:")) {
          return { kind: "artifact" as const, artifactID: request.slice("artifact:".length) }
        }
        if (request.startsWith("tool-call:")) {
          return { kind: "tool" as const, callID: request.slice("tool-call:".length) }
        }
        if (request.startsWith("tool:")) return { kind: "tool" as const, tool: request.slice("tool:".length) }
        throw new Error(
          `Invalid evidence reference ${JSON.stringify(request)}; use artifact:<id>, artifact-path:<path>, tool:<name>, or tool-call:<id>`,
        )
      })()
      if (!Object.values(parsed).every((value) => value)) {
        throw new Error(`Evidence reference ${JSON.stringify(request)} has an empty selector`)
      }
      if (parsed.kind === "artifact") {
        const current = context.artifacts.find(
          (item) =>
            item.state === "active" &&
            context.sessions.has(item.current.sessionID) &&
            (!("artifactID" in parsed) || item.id === parsed.artifactID) &&
            (!("path" in parsed) || item.current.sourcePath === parsed.path),
        )
        if (!current) {
          throw new Error(`No active durable Result in this session tree matches ${request}`)
        }
        const detail = await ArtifactStore.get(Instance.project.id, current.id)
        const version = detail?.current
        if (!version || !context.sessions.has(version.sessionID)) {
          throw new Error(`Artifact version ${current.currentVersionID} is not in this session tree`)
        }
        const snapshot = await ArtifactStore.read(Instance.project.id, current.id, version.id)
        if (!snapshot || snapshot.info.sha256 !== version.sha256) {
          throw new Error(`Artifact ${current.id} version ${version.id} failed immutable blob verification`)
        }
        return SessionResearch.EvidenceReference.parse({
          kind: "artifact",
          ref: `${current.id}:${version.id}`,
          artifactID: current.id,
          versionID: version.id,
          path: version.sourcePath,
          sha256: version.sha256,
          verifiedAt: Date.now(),
        })
      }

      const tools = context.messages
        .flatMap((message) => message.parts)
        .filter(
          (
            part,
          ): part is MessageV2.ToolPart & {
            state: MessageV2.ToolStateCompleted | MessageV2.ToolStateError
          } =>
            part.type === "tool" &&
            (part.state.status === "completed" || part.state.status === "error") &&
            part.tool !== "research_contract",
        )
        .toSorted((a, b) => a.state.time.end - b.state.time.end)
      const found = tools.findLast(
        (part) =>
          (!("callID" in parsed) || part.callID === parsed.callID) &&
          (!("tool" in parsed) || part.tool === parsed.tool),
      )
      if (!found) {
        throw new Error(`No terminal tool call matches ${request}`)
      }
      const output = found.state.status === "completed" ? found.state.output : found.state.error
      return SessionResearch.EvidenceReference.parse({
        kind: "tool",
        ref: found.callID,
        tool: found.tool,
        callID: found.callID,
        status: found.state.status,
        outputHash: hash(output),
        verifiedAt: Date.now(),
      })
    }),
  )
}

const Params = z
  .object({
    action: z.enum(["define", "preregister", "stage", "check", "trial", "failure", "learn", "unlearn", "status"]),
    objective: Define.shape.objective.optional(),
    domain: Domain.optional(),
    template: SessionResearch.Template.optional(),
    deliverables: Define.shape.deliverables,
    reserve_usd: Define.shape.reserve_usd,
    max_model_calls: Define.shape.max_model_calls,
    max_tool_calls: Define.shape.max_tool_calls,
    max_tokens: Define.shape.max_tokens,
    max_minutes: Define.shape.max_minutes,
    max_cost_usd: Define.shape.max_cost_usd,
    stage: Stage.shape.stage.optional(),
    check: Check.shape.check.optional(),
    label: Check.shape.label,
    status: z.enum(["pending", "running", "completed", "blocked", "passed", "failed"]).optional(),
    evidence: Check.shape.evidence,
    evidence_refs: EvidenceRequests.optional(),
    detail: Check.shape.detail,
    candidate: Failure.shape.candidate.optional(),
    message: Failure.shape.message.optional(),
    disposition: Failure.shape.disposition,
    branch: Trial.shape.branch.optional(),
    outcome: SessionResearch.Outcome.optional(),
    summary: Trial.shape.summary.optional(),
    metric: SessionResearch.Metric.optional(),
    source_trial: Learn.shape.source_trial.optional(),
    situation: Learn.shape.situation.optional(),
    guidance: Learn.shape.guidance.optional(),
    lesson: Unlearn.shape.lesson.optional(),
    reason: Unlearn.shape.reason.optional(),
  })
  .superRefine((value, ctx) => {
    const schema = {
      define: Define,
      preregister: Preregister,
      stage: Stage,
      check: Check,
      trial: Trial,
      failure: Failure,
      learn: Learn,
      unlearn: Unlearn,
      status: Status,
    }[value.action]
    const parsed = schema.safeParse(value)
    if (parsed.success) return
    parsed.error.issues.forEach((issue) => ctx.addIssue({ code: "custom", path: issue.path, message: issue.message }))
  })

export const ResearchContractTool = Tool.define("research_contract", {
  description: [
    "Durable multi-stage research state. Define first, then update stages and record trials or failures.",
    "Settled checks and advanced/regressed trials need runtime-verified evidence_refs. Free text is explanation only.",
    "Add metric plus baseline when quantitative; contradictory outcomes fail.",
    "Learn methods only from verified trials; unlearn with verified counterevidence.",
    "Preregister freezes an empirical plan Result before trials and verifies hash and chronology.",
    "Never infer max_* fields: set only exact numeric ceilings from the user. Omitted limits are generous. Status inspects state.",
  ].join(" "),
  parameters: Params,
  formatValidationError(error) {
    return error.issues[0]?.message ?? "Invalid research contract input"
  },
  async execute(params, ctx) {
    const refs = await evidence(params.evidence_refs, ctx.sessionID)
    const lesson = await (async () => {
      if (params.action === "learn") {
        const input = Learn.parse(params)
        return SessionResearch.learn(Instance.project.id, ctx.sessionID, {
          sourceTrial: input.source_trial,
          situation: input.situation,
          guidance: input.guidance,
          evidence: input.evidence,
          evidenceRefs: refs,
        })
      }
      if (params.action === "unlearn") {
        const input = Unlearn.parse(params)
        return SessionResearch.unlearn(Instance.project.id, ctx.sessionID, {
          lesson: input.lesson,
          sourceTrial: input.source_trial,
          reason: input.reason,
          evidence: input.evidence,
          evidenceRefs: refs,
        })
      }
    })()
    const contract = await (async () => {
      if (params.action === "define") {
        const input = Define.parse(params)
        assertLimits(input, ctx)
        return SessionResearch.define(ctx.sessionID, {
          objective: input.objective,
          domain: input.domain,
          template: input.template,
          deliverables: input.deliverables,
          reserveUsd: input.reserve_usd,
          limits:
            input.max_model_calls || input.max_tool_calls || input.max_tokens || input.max_minutes || input.max_cost_usd
              ? {
                  ...(input.max_model_calls ? { modelCalls: input.max_model_calls } : {}),
                  ...(input.max_tool_calls ? { toolCalls: input.max_tool_calls } : {}),
                  ...(input.max_tokens ? { tokens: input.max_tokens } : {}),
                  ...(input.max_minutes ? { wallClockMs: input.max_minutes * 60_000 } : {}),
                  ...(input.max_cost_usd ? { costUsd: input.max_cost_usd } : {}),
                }
              : undefined,
        })
      }
      if (params.action === "preregister") {
        const input = Preregister.parse(params)
        const artifact = refs.find((item): item is SessionResearch.ArtifactReference => item.kind === "artifact")
        if (!artifact || input.evidence_refs.length !== 1) {
          throw new Error("Preregistration requires exactly one immutable artifact reference")
        }
        return SessionResearch.preregister(ctx.sessionID, artifact)
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
          evidenceRefs: refs,
          detail: input.detail,
        })
      }
      if (params.action === "failure") {
        const input = Failure.parse(params)
        const current = input.stage ? undefined : await SessionResearch.read(ctx.sessionID)
        const stage =
          input.stage ??
          current?.stages.find((item) => item.status === "running")?.id ??
          current?.stages.find((item) => item.status === "pending")?.id ??
          current?.stages[0]?.id
        if (!stage) throw new Error("No research contract stage is available for this failure")
        return SessionResearch.fail(
          ctx.sessionID,
          {
            stage,
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
            evidenceRefs: refs,
            metric: input.metric,
          },
          ctx.callID,
        )
      }
      const current = await SessionResearch.read(ctx.sessionID)
      if (!current) throw new Error("No research completion contract has been defined for this session")
      return current
    })()
    const completed = contract.stages.filter((stage) => stage.status === "completed").length
    const passed = contract.checks.filter((check) => check.status === "passed" && check.evidenceRefs.length).length
    const failed = contract.checks.filter((check) => check.status === "failed").length
    const strategy = SessionResearch.strategy(contract)
    const lessons = await SessionResearch.experience(Instance.project.id, contract.domain)
    const active = lessons.filter((item) => item.status === "active")
    const recent = contract.trials.slice(-6)
    return {
      title:
        params.action === "define"
          ? "Research contract defined"
          : params.action === "preregister"
            ? "Research plan preregistered"
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
        `Preregistration: ${contract.preregistration ? `${contract.preregistration.artifact.versionID} frozen at ${new Date(contract.preregistration.frozenAt).toISOString()}` : "none (exploratory)"}`,
        `Recorded candidate failures: ${contract.failures.length}`,
        `Recorded material attempts: ${contract.trials.length}`,
        ...(recent.length
          ? [
              "Recent trial IDs:",
              ...recent.map(
                (item) =>
                  `- ${item.id}: ${item.candidate} [${item.outcome}]${item.metric ? ` ${item.metric.name}=${item.metric.value}${item.metric.unit ? ` ${item.metric.unit}` : ""}` : ""} · ${item.evidenceRefs.length} verified ref(s)`,
              ),
            ]
          : []),
        `Trajectory mode: ${strategy.mode} - ${strategy.reason}`,
        `Active project lessons: ${active.length} (${active.filter((item) => item.confidence === "supported").length} independently supported)`,
        ...(lesson
          ? [
              `Lesson ${lesson.id}: ${lesson.status}, ${lesson.confidence}, supported by ${lesson.supports.length} recorded ${lesson.supports.length === 1 ? "observation" : "observations"}`,
            ]
          : []),
        `Managed-credit finalization reserve: $${contract.budget.reserveUsd.toFixed(2)}`,
        `Runtime limits: ${contract.budget.limits.modelCalls} model calls, ${contract.budget.limits.toolCalls} tool calls, ${contract.budget.limits.tokens} tokens, ${Math.round(contract.budget.limits.wallClockMs / 60_000)} minutes, $${contract.budget.limits.costUsd.toFixed(2)}`,
        `Runtime usage: ${contract.budget.runtimeModelCalls} model calls reserved${contract.budget.lastUsage ? `, ${contract.budget.lastUsage.toolCalls} tools, ${contract.budget.lastUsage.tokens} tokens, ${Math.round(contract.budget.lastUsage.wallClockMs / 1_000)} seconds, $${contract.budget.lastUsage.costUsd.toFixed(4)}` : ""}`,
        ...(refs.length ? [`Verified evidence references recorded: ${refs.map((item) => item.ref).join(", ")}`] : []),
      ].join("\n"),
      metadata: {
        researchContract: {
          action: params.action,
          domain: contract.domain,
          template: contract.template,
          preregistrationVersionID: contract.preregistration?.artifact.versionID,
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
