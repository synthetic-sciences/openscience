import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import z from "zod"

export namespace SessionResearch {
  export const Domain = z
    .enum(["general", "statistics", "biology", "physics", "chemistry", "ml", "weather", "posttrain", "evidence"])
    .describe(
      "Primary workflow domain. Use weather for forecast postprocessing or meteorology, posttrain for fine-tuning/alignment/checkpoint training, evidence for literature synthesis, and ml for other machine-learning experiments.",
    )
  export type Domain = z.infer<typeof Domain>

  export const Template = z.enum(["minimal", "empirical", "evidence"])
  export type Template = z.infer<typeof Template>

  export const Status = z.enum(["pending", "running", "completed", "blocked"])
  export type Status = z.infer<typeof Status>

  export const Stage = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(120),
    status: Status.default("pending"),
    detail: z.string().trim().max(1_000).optional(),
    updatedAt: z.number(),
  })
  export type Stage = z.infer<typeof Stage>

  export const Deliverable = z.object({
    path: z.string().trim().min(1).max(1_000),
    label: z.string().trim().min(1).max(120),
    required: z.boolean().default(true),
  })
  export type Deliverable = z.infer<typeof Deliverable>

  export const Check = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(120),
    status: z.enum(["pending", "passed", "failed"]),
    evidence: z.string().trim().max(2_000).optional(),
    detail: z.string().trim().max(1_000).optional(),
    updatedAt: z.number(),
  })
  export type Check = z.infer<typeof Check>

  export const Failure = z.object({
    id: z.string(),
    stage: z.string().trim().min(1).max(120),
    candidate: z.string().trim().min(1).max(240),
    message: z.string().trim().min(1).max(4_000),
    disposition: z.string().trim().max(1_000).optional(),
    recordedAt: z.number(),
  })
  export type Failure = z.infer<typeof Failure>

  export const Outcome = z.enum(["advanced", "neutral", "regressed", "failed", "inconclusive"])
  export type Outcome = z.infer<typeof Outcome>

  export const Trial = z
    .object({
      id: z.string(),
      stage: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      branch: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      candidate: z.string().trim().min(1).max(240),
      outcome: Outcome,
      summary: z.string().trim().min(1).max(2_000),
      evidence: z.string().trim().max(2_000).optional(),
      recordedAt: z.number(),
    })
    .superRefine((value, ctx) => {
      if ((value.outcome === "advanced" || value.outcome === "regressed") && !value.evidence) {
        ctx.addIssue({ code: "custom", path: ["evidence"], message: `${value.outcome} trials require evidence` })
      }
    })
  export type Trial = z.infer<typeof Trial>

  export const Observation = z.object({
    sessionID: z.string(),
    trialID: z.string(),
    outcome: Outcome,
    evidence: z.string().trim().min(1).max(2_000),
    note: z.string().trim().min(1).max(2_000),
    recordedAt: z.number(),
  })
  export type Observation = z.infer<typeof Observation>

  export const Lesson = z.object({
    id: z.string(),
    domain: Domain,
    situation: z.string().trim().min(1).max(500),
    guidance: z.string().trim().min(1).max(1_000),
    confidence: z.enum(["tentative", "supported"]),
    status: z.enum(["active", "rejected"]),
    supports: z.array(Observation).max(20),
    contradictions: z.array(Observation).max(20),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Lesson = z.infer<typeof Lesson>

  export const Experience = z.object({
    version: z.literal(1),
    lessons: z.array(Lesson),
  })
  export type Experience = z.infer<typeof Experience>

  export const Budget = z.object({
    reserveUsd: z.number().min(0).max(100).default(1),
    finalizationCalls: z.number().int().nonnegative().default(0),
    finalizing: z.boolean().default(false),
    exhausted: z.boolean().default(false),
    lastBalanceUsd: z.number().optional(),
    updatedAt: z.number(),
  })
  export type Budget = z.infer<typeof Budget>

  export const Contract = z.object({
    version: z.literal(1),
    objective: z.string().trim().min(1).max(2_000),
    domain: Domain,
    template: Template,
    stages: z.array(Stage),
    deliverables: z.array(Deliverable),
    checks: z.array(Check),
    failures: z.array(Failure),
    trials: z.array(Trial).default([]),
    budget: Budget,
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Contract = z.infer<typeof Contract>

  export const Gate = z.object({
    id: z.enum(["stages", "deliverables", "checks", "review", "runtime"]),
    label: z.string(),
    status: z.enum(["passed", "pending", "failed"]),
    complete: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    detail: z.string(),
  })
  export type Gate = z.infer<typeof Gate>

  export const Strategy = z.object({
    mode: z.enum(["explore", "refine", "pivot", "fuse", "verify"]),
    stage: z.string().optional(),
    attempts: z.number().int().nonnegative(),
    branches: z.number().int().nonnegative(),
    repeatedCandidates: z.array(z.string()),
    reason: z.string(),
    guidance: z.array(z.string()),
  })
  export type Strategy = z.infer<typeof Strategy>

  export const Assessment = z.object({
    configured: z.boolean(),
    status: z.enum(["unconfigured", "running", "blocked", "ready"]),
    readiness: z.number().int().min(0).max(100),
    gates: z.array(Gate),
    missing: z.array(z.string()),
    openFindings: z.number().int().nonnegative(),
    failedCandidates: z.number().int().nonnegative(),
    strategy: Strategy,
  })
  export type Assessment = z.infer<typeof Assessment>

  const file = (sessionID: string) => path.join(Global.Path.data, "research", `${encodeURIComponent(sessionID)}.json`)
  const experienceFile = (projectID: string) =>
    path.join(Global.Path.data, "research-experience", `${encodeURIComponent(projectID)}.json`)
  const experienceLimit = 200

  const phases: Record<Domain, Array<{ id: string; label: string }>> = {
    general: [
      { id: "scope", label: "Scope the question" },
      { id: "execute", label: "Execute the work" },
      { id: "verify", label: "Verify the result" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    statistics: [
      { id: "design", label: "Freeze the statistical design" },
      { id: "simulate", label: "Run simulations" },
      { id: "infer", label: "Estimate and compare methods" },
      { id: "calibrate", label: "Check calibration and error rates" },
      { id: "verify", label: "Recompute key quantities" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    biology: [
      { id: "inputs", label: "Validate biological inputs" },
      { id: "split", label: "Control leakage and confounding" },
      { id: "analyze", label: "Run the analysis" },
      { id: "controls", label: "Run negative and positive controls" },
      { id: "verify", label: "Verify biological conclusions" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    physics: [
      { id: "model", label: "Specify the physical model" },
      { id: "solve", label: "Run the solver" },
      { id: "converge", label: "Check convergence and invariants" },
      { id: "uncertainty", label: "Quantify uncertainty" },
      { id: "verify", label: "Cross-check independently" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    chemistry: [
      { id: "model", label: "Specify candidate mechanisms" },
      { id: "fit", label: "Fit the global model" },
      { id: "identify", label: "Audit identifiability" },
      { id: "uncertainty", label: "Quantify uncertainty" },
      { id: "verify", label: "Verify chemistry and numerics" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    ml: [
      { id: "split", label: "Freeze leakage-safe splits" },
      { id: "select", label: "Select against fair baselines" },
      { id: "lock", label: "Lock the final model" },
      { id: "evaluate", label: "Evaluate once on holdout" },
      { id: "robustness", label: "Run robustness checks" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    weather: [
      { id: "split", label: "Freeze temporal and spatial splits" },
      { id: "fit", label: "Fit postprocessing models" },
      { id: "score", label: "Score probabilistic forecasts" },
      { id: "bootstrap", label: "Quantify uncertainty" },
      { id: "verify", label: "Check leakage and calibration" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    posttrain: [
      { id: "baseline", label: "Freeze the baseline" },
      { id: "train", label: "Run post-training" },
      { id: "resume", label: "Verify checkpoint resume" },
      { id: "evaluate", label: "Evaluate capability and format" },
      { id: "verify", label: "Reload and reproduce" },
      { id: "finalize", label: "Finalize deliverables" },
    ],
    evidence: [
      { id: "scope", label: "Freeze the research question" },
      { id: "sources", label: "Collect primary sources" },
      { id: "claims", label: "Build the claim-evidence matrix" },
      { id: "conflicts", label: "Adjudicate contradictions" },
      { id: "verify", label: "Verify quotes and numbers" },
      { id: "finalize", label: "Finalize the synthesis" },
    ],
  }

  const decisions: Record<Domain, string> = {
    general: "execute",
    statistics: "simulate",
    biology: "analyze",
    physics: "solve",
    chemistry: "fit",
    ml: "select",
    weather: "fit",
    posttrain: "train",
    evidence: "claims",
  }

  const outputs: Record<Template, Deliverable[]> = {
    minimal: [],
    empirical: [
      { path: "analysis.py", label: "Rerunnable analysis", required: true },
      { path: "metrics.json", label: "Machine-readable metrics", required: true },
      { path: "report.md", label: "Research report", required: true },
      { path: "REPRODUCE.md", label: "Reproduction instructions", required: true },
    ],
    evidence: [
      { path: "report.md", label: "Evidence synthesis", required: true },
      { path: "claims.csv", label: "Claim-evidence matrix", required: true },
      { path: "sources.csv", label: "Source inventory", required: true },
      { path: "REPRODUCE.md", label: "Reproduction instructions", required: true },
    ],
  }

  const validations: Record<Template, Array<{ id: string; label: string }>> = {
    minimal: [{ id: "artifact-inspection", label: "Inspect every requested deliverable" }],
    empirical: [
      { id: "clean-run", label: "Run the saved entry point in a clean process" },
      { id: "machine-output", label: "Recompute report numbers from machine outputs" },
      { id: "checkpoint-reload", label: "Reload saved models or checkpoints" },
      { id: "figure-qa", label: "Inspect every generated figure" },
    ],
    evidence: [
      { id: "source-verification", label: "Verify claims against primary sources" },
      { id: "quote-verification", label: "Verify every quotation and attributed number" },
      { id: "contradiction-audit", label: "Adjudicate material contradictions" },
      { id: "artifact-inspection", label: "Inspect the final synthesis and tables" },
    ],
  }

  function initial(input: {
    objective: string
    domain: Domain
    template: Template
    deliverables?: Deliverable[]
    reserveUsd?: number
  }): Contract {
    const now = Date.now()
    return Contract.parse({
      version: 1,
      objective: input.objective,
      domain: input.domain,
      template: input.template,
      stages: phases[input.domain].map((stage) => ({ ...stage, status: "pending", updatedAt: now })),
      // An explicit list is the user's requested result contract, not an
      // add-on to template filenames. This matters for evidence tasks whose
      // exact machine-readable names often differ from the generic defaults.
      deliverables: input.deliverables?.length ? input.deliverables : outputs[input.template],
      checks: validations[input.template].map((check) => ({ ...check, status: "pending", updatedAt: now })),
      failures: [],
      trials: [],
      budget: {
        reserveUsd: input.reserveUsd ?? 1,
        finalizationCalls: 0,
        finalizing: false,
        exhausted: false,
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    })
  }

  export async function read(sessionID: string): Promise<Contract | undefined> {
    const parsed = Contract.safeParse(await JsonStore.read(file(sessionID)))
    return parsed.success ? parsed.data : undefined
  }

  export async function define(
    sessionID: string,
    input: {
      objective: string
      domain: Domain
      template: Template
      deliverables?: Deliverable[]
      reserveUsd?: number
    },
  ): Promise<Contract> {
    const next = initial(input)
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.safeParse(data)
      if (!current.success) return next
      const stages = next.stages.map((stage) => current.data.stages.find((item) => item.id === stage.id) ?? stage)
      const checks = next.checks.map((check) => current.data.checks.find((item) => item.id === check.id) ?? check)
      return Contract.parse({
        ...next,
        stages,
        checks,
        failures: current.data.failures,
        trials: current.data.trials,
        budget: { ...current.data.budget, reserveUsd: input.reserveUsd ?? current.data.budget.reserveUsd },
        createdAt: current.data.createdAt,
        updatedAt: Date.now(),
      })
    })
    return (await read(sessionID))!
  }

  export async function stage(
    sessionID: string,
    input: { id: string; status: Status; detail?: string },
  ): Promise<Contract> {
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      if (!current.stages.some((stage) => stage.id === input.id)) {
        throw new Error(`Research stage ${input.id} is not part of this contract`)
      }
      if (
        input.status === "completed" &&
        decisions[current.domain] === input.id &&
        !current.trials.some((trial) => trial.stage === input.id)
      ) {
        throw new Error(
          `Research stage ${input.id} cannot be completed until at least one material trial is recorded with action trial`,
        )
      }
      return {
        ...current,
        stages: current.stages.map((stage) =>
          stage.id === input.id
            ? { ...stage, status: input.status, detail: input.detail, updatedAt: Date.now() }
            : stage,
        ),
        updatedAt: Date.now(),
      }
    })
    return (await read(sessionID))!
  }

  export async function check(
    sessionID: string,
    input: { id: string; label?: string; status: "pending" | "passed" | "failed"; evidence?: string; detail?: string },
  ): Promise<Contract> {
    if (input.status !== "pending" && !input.evidence?.trim()) {
      throw new Error(`Research check ${input.id} requires observed evidence before it can be marked ${input.status}`)
    }
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      const known = current.checks.find((check) => check.id === input.id)
      const item = Check.parse({
        id: input.id,
        label: input.label ?? known?.label ?? input.id,
        status: input.status,
        evidence: input.evidence,
        detail: input.detail,
        updatedAt: Date.now(),
      })
      return {
        ...current,
        checks: known
          ? current.checks.map((check) => (check.id === input.id ? item : check))
          : [...current.checks, item],
        updatedAt: Date.now(),
      }
    })
    return (await read(sessionID))!
  }

  export async function fail(
    sessionID: string,
    input: { stage: string; candidate: string; message: string; disposition?: string },
    key?: string,
  ): Promise<Contract> {
    const item = Failure.parse({
      ...input,
      id: `failure-${key ?? crypto.randomUUID()}`,
      recordedAt: Date.now(),
    })
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      if (current.failures.some((failure) => failure.id === item.id)) return current
      return { ...current, failures: [...current.failures, item], updatedAt: Date.now() }
    })
    return (await read(sessionID))!
  }

  export async function trial(
    sessionID: string,
    input: Omit<Trial, "id" | "recordedAt">,
    key?: string,
  ): Promise<Contract> {
    const item = Trial.parse({
      ...input,
      id: `trial-${key ?? crypto.randomUUID()}`,
      recordedAt: Date.now(),
    })
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      if (current.trials.some((trial) => trial.id === item.id)) return current
      if (!current.stages.some((stage) => stage.id === input.stage)) {
        throw new Error(`Research stage ${input.stage} is not part of this contract`)
      }
      return { ...current, trials: [...current.trials, item], updatedAt: Date.now() }
    })
    return (await read(sessionID))!
  }

  type Entry = {
    stage: string
    branch: string
    candidate: string
    outcome: Outcome
    summary: string
    evidence?: string
    recordedAt: number
  }

  function entries(contract: Contract, stage?: string): Entry[] {
    return [
      ...contract.trials,
      ...contract.failures.map((failure) => ({
        stage: failure.stage,
        branch: "failure",
        candidate: failure.candidate,
        outcome: "failed" as const,
        summary: failure.message,
        evidence: failure.disposition,
        recordedAt: failure.recordedAt,
      })),
    ]
      .filter((entry) => !stage || entry.stage === stage)
      .toSorted((a, b) => a.recordedAt - b.recordedAt)
  }

  function signature(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  }

  function compact(value: string) {
    return value.trim().replace(/\s+/g, " ")
  }

  function fingerprint(domain: Domain, situation: string, guidance: string) {
    const value = [domain, compact(situation).toLowerCase(), compact(guidance).toLowerCase()].join("\0")
    return `lesson-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`
  }

  function quote(value: string, limit: number) {
    return JSON.stringify(compact(value).slice(0, limit))
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026")
  }

  function confidence(supports: Observation[]) {
    return new Set(supports.map((item) => item.sessionID)).size > 1 ? ("supported" as const) : ("tentative" as const)
  }

  export async function experience(projectID: string, domain?: Domain): Promise<Lesson[]> {
    const parsed = Experience.safeParse(await JsonStore.read(experienceFile(projectID)))
    if (!parsed.success) return []
    return parsed.data.lessons
      .filter((lesson) => !domain || lesson.domain === domain)
      .toSorted((a, b) => {
        const rank = Number(b.confidence === "supported") - Number(a.confidence === "supported")
        return rank || b.updatedAt - a.updatedAt
      })
  }

  export async function learn(
    projectID: string,
    sessionID: string,
    input: { sourceTrial: string; situation: string; guidance: string; evidence?: string },
  ): Promise<Lesson> {
    const contract = await read(sessionID)
    if (!contract) throw new Error("No research completion contract has been defined for this session")
    const trial = contract.trials.find((item) => item.id === input.sourceTrial)
    if (!trial) throw new Error(`Research trial ${input.sourceTrial} does not exist in this session`)
    if (trial.outcome === "inconclusive") {
      throw new Error("An inconclusive trial cannot create reusable project experience")
    }
    const evidence = input.evidence ?? trial.evidence
    if (!evidence?.trim()) {
      throw new Error(`Research trial ${trial.id} needs observed evidence before it can create project experience`)
    }
    const now = Date.now()
    const situation = compact(input.situation)
    const guidance = compact(input.guidance)
    const id = fingerprint(contract.domain, situation, guidance)
    const observation = Observation.parse({
      sessionID,
      trialID: trial.id,
      outcome: trial.outcome,
      evidence,
      note: trial.summary,
      recordedAt: now,
    })
    await JsonStore.update(experienceFile(projectID), (data) => {
      const parsed = Experience.safeParse(data)
      const current = parsed.success ? parsed.data : { version: 1 as const, lessons: [] }
      const known = current.lessons.find((lesson) => lesson.id === id)
      if (known?.status === "rejected") {
        throw new Error(
          `Project lesson ${id} was rejected by counterevidence; record a differently scoped lesson instead`,
        )
      }
      if (known?.supports.some((item) => item.sessionID === sessionID && item.trialID === trial.id)) return current
      const supports = [...(known?.supports ?? []), observation].slice(-20)
      const lesson = Lesson.parse({
        id,
        domain: contract.domain,
        situation: known?.situation ?? situation,
        guidance: known?.guidance ?? guidance,
        confidence: confidence(supports),
        status: "active",
        supports,
        contradictions: known?.contradictions ?? [],
        createdAt: known?.createdAt ?? now,
        updatedAt: now,
      })
      return Experience.parse({
        version: 1,
        lessons: (known
          ? current.lessons.map((item) => (item.id === id ? lesson : item))
          : [...current.lessons, lesson]
        )
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, experienceLimit),
      })
    })
    return (await experience(projectID)).find((lesson) => lesson.id === id)!
  }

  export async function unlearn(
    projectID: string,
    sessionID: string,
    input: { lesson: string; sourceTrial: string; reason: string; evidence: string },
  ): Promise<Lesson> {
    const contract = await read(sessionID)
    if (!contract) throw new Error("No research completion contract has been defined for this session")
    const trial = contract.trials.find((item) => item.id === input.sourceTrial)
    if (!trial) throw new Error(`Research trial ${input.sourceTrial} does not exist in this session`)
    if (trial.outcome === "inconclusive") {
      throw new Error("An inconclusive trial cannot reject reusable project experience")
    }
    const now = Date.now()
    const observation = Observation.parse({
      sessionID,
      trialID: trial.id,
      outcome: trial.outcome,
      evidence: input.evidence,
      note: input.reason,
      recordedAt: now,
    })
    await JsonStore.update(experienceFile(projectID), (data) => {
      const current = Experience.parse(data)
      const known = current.lessons.find((lesson) => lesson.id === input.lesson)
      if (!known) throw new Error(`Project lesson ${input.lesson} does not exist`)
      if (known.domain !== contract.domain) {
        throw new Error(`Project lesson ${input.lesson} belongs to the ${known.domain} domain, not ${contract.domain}`)
      }
      if (known.contradictions.some((item) => item.sessionID === sessionID && item.trialID === input.sourceTrial)) {
        return current
      }
      const lesson = Lesson.parse({
        ...known,
        status: "rejected",
        contradictions: [...known.contradictions, observation].slice(-20),
        updatedAt: now,
      })
      return Experience.parse({
        version: 1,
        lessons: current.lessons
          .map((item) => (item.id === input.lesson ? lesson : item))
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, experienceLimit),
      })
    })
    return (await experience(projectID)).find((lesson) => lesson.id === input.lesson)!
  }

  export function strategy(contract?: Contract): Strategy {
    if (!contract) {
      return Strategy.parse({
        mode: "explore",
        attempts: 0,
        branches: 0,
        repeatedCandidates: [],
        reason: "No research contract has been defined",
        guidance: [
          "Define the objective, lifecycle stages, required Results, and verification checks before expensive work.",
        ],
      })
    }
    const stage =
      contract.stages.find((item) => item.status === "running")?.id ??
      contract.stages.find((item) => item.status === "pending")?.id
    const history = entries(contract, stage)
    const negatives = history.filter((entry) => entry.outcome !== "advanced")
    const counts = negatives.reduce<Record<string, { label: string; count: number }>>((all, entry) => {
      const key = signature(entry.candidate)
      const current = all[key]
      return { ...all, [key]: { label: current?.label ?? entry.candidate, count: (current?.count ?? 0) + 1 } }
    }, {})
    const repeatedCandidates = Object.values(counts)
      .filter((item) => item.count > 1)
      .map((item) => item.label)
    const recent = history.slice(-3)
    const stalled = recent.length === 3 && recent.every((entry) => entry.outcome !== "advanced")
    const last = history.at(-1)
    const repeated =
      last?.outcome !== "advanced" &&
      repeatedCandidates.some((candidate) => signature(candidate) === signature(last?.candidate ?? ""))
    const improved = new Set(
      history
        .filter((entry) => entry.outcome === "advanced" && entry.branch !== "failure")
        .map((entry) => entry.branch),
    )
    const complete = contract.stages.every((item) => item.status === "completed")
    const mode = complete
      ? ("verify" as const)
      : stalled || repeated
        ? ("pivot" as const)
        : improved.size > 1
          ? ("fuse" as const)
          : improved.size === 1
            ? ("refine" as const)
            : ("explore" as const)
    const reason = (() => {
      if (mode === "verify")
        return "All research stages are marked complete; new exploration would weaken the completion boundary"
      if (mode === "pivot") {
        if (repeated) return `The latest non-advancing candidate repeated a recorded attempt`
        return "The last three recorded attempts did not advance the result"
      }
      if (mode === "fuse") return `${improved.size} distinct branches produced useful evidence`
      if (mode === "refine") return "One branch has advanced the result and is the strongest current continuation"
      return history.length
        ? "No branch has advanced the result yet"
        : "No material attempt has been recorded for this stage"
    })()
    const guidance = {
      explore: [
        "State the falsifier before running compute and try materially different approach families, not cosmetic variants.",
        "Record each material result, including neutral and inconclusive outcomes, before choosing the next branch.",
        ...(stage === decisions[contract.domain]
          ? [`This decision stage cannot be completed until at least one material trial is recorded for ${stage}.`]
          : []),
      ],
      refine: [
        "Continue the strongest branch while keeping its baseline, split, controls, and success criterion fixed.",
        "Prefer one targeted change whose effect can be attributed independently.",
      ],
      pivot: [
        "Do not rerun a recorded non-advancing candidate unchanged or hide it behind renamed files, seeds, or parameters.",
        "Change the assumption, data representation, method family, or evidence source; record why the new branch is genuinely different.",
      ],
      fuse: [
        "Combine only independently useful elements from the advancing branches and preserve their shared controls.",
        "Treat the fused candidate as a new branch and verify that its gain survives a clean rerun.",
      ],
      verify: [
        "Stop opening new branches. Run the declared checks, independent review, clean reproduction, and artifact inspection.",
        "If a check fails, reopen the responsible stage and record the failed verification as a new attempt.",
      ],
    }[mode]
    return Strategy.parse({
      mode,
      stage,
      attempts: history.length,
      branches: new Set(history.filter((entry) => entry.branch !== "failure").map((entry) => entry.branch)).size,
      repeatedCandidates,
      reason,
      guidance,
    })
  }

  export type Evidence = {
    artifacts: Array<{ path?: string }>
    jobs: Array<{ status: string }>
    kernels: Array<{ status: string }>
    findings: Array<{ verdict?: string; status?: string; severity?: string }>
    reviewed: boolean
    busy: boolean
  }

  function ratio(complete: number, total: number) {
    return total === 0 ? 1 : complete / total
  }

  function match(pattern: string, value: string) {
    return new Bun.Glob(pattern).match(value) || new Bun.Glob(`**/${pattern}`).match(value)
  }

  export function assess(contract: Contract | undefined, evidence: Evidence): Assessment {
    if (!contract) {
      return Assessment.parse({
        configured: false,
        status: "unconfigured",
        readiness: 0,
        gates: [],
        missing: [],
        openFindings: 0,
        failedCandidates: 0,
        strategy: strategy(),
      })
    }
    const required = contract.deliverables.filter((item) => item.required)
    const paths = evidence.artifacts.flatMap((item) => (item.path ? [item.path] : []))
    const missing = required.filter((item) => !paths.some((value) => match(item.path, value)))
    const stages = contract.stages.filter((stage) => stage.status === "completed").length
    const checks = contract.checks.filter((check) => check.status === "passed" && !!check.evidence?.trim()).length
    const failed = contract.checks.filter((check) => check.status === "failed").length
    const open = evidence.findings.filter(
      (finding) =>
        finding.verdict === "refutes" &&
        finding.status !== "confirmed" &&
        (finding.severity === "blocking" || finding.severity === "major"),
    ).length
    const running = evidence.jobs.filter((job) => job.status === "queued" || job.status === "running").length
    const jobFailures = evidence.jobs.filter(
      (job) => job.status === "failed" || job.status === "interrupted" || job.status === "cancelled",
    ).length
    const activeKernels = evidence.kernels.filter(
      (kernel) => kernel.status === "pending" || kernel.status === "running",
    ).length
    const kernelFailures = evidence.kernels.filter((kernel) => kernel.status === "error").length
    const active = running + activeKernels
    const runtimeFailures = jobFailures + kernelFailures
    const recovered =
      runtimeFailures > 0 &&
      stages === contract.stages.length &&
      missing.length === 0 &&
      checks === contract.checks.length &&
      failed === 0 &&
      evidence.reviewed &&
      open === 0
    const gates: Gate[] = [
      {
        id: "stages",
        label: "Research stages",
        status: stages === contract.stages.length ? "passed" : "pending",
        complete: stages,
        total: contract.stages.length,
        detail: `${stages}/${contract.stages.length} stages complete`,
      },
      {
        id: "deliverables",
        label: "Required Results",
        status: missing.length ? "pending" : "passed",
        complete: required.length - missing.length,
        total: required.length,
        detail: missing.length
          ? `${missing.length} required ${missing.length === 1 ? "Result" : "Results"} missing`
          : "All required Results saved",
      },
      {
        id: "checks",
        label: "Verification checks",
        status: failed ? "failed" : checks === contract.checks.length ? "passed" : "pending",
        complete: checks,
        total: contract.checks.length,
        detail: failed
          ? `${failed} verification ${failed === 1 ? "check failed" : "checks failed"}`
          : `${checks}/${contract.checks.length} checks passed`,
      },
      {
        id: "review",
        label: "Independent review",
        status: open ? "failed" : evidence.reviewed ? "passed" : "pending",
        complete: open || !evidence.reviewed ? 0 : 1,
        total: 1,
        detail: open
          ? `${open} blocking or major ${open === 1 ? "finding" : "findings"} remain open`
          : evidence.reviewed
            ? "Independent review completed without open major findings"
            : "Independent review has not completed",
      },
      {
        id: "runtime",
        label: "Runtime health",
        status: active || evidence.busy ? "pending" : runtimeFailures && !recovered ? "failed" : "passed",
        complete: active || evidence.busy || (runtimeFailures && !recovered) ? 0 : 1,
        total: 1,
        detail: active
          ? `${active} kernel or compute ${active === 1 ? "task is" : "tasks are"} still active`
          : evidence.busy
            ? "Session is still running"
            : recovered
              ? `${runtimeFailures} failed runtime ${runtimeFailures === 1 ? "attempt is" : "attempts are"} retained; final checks and review passed`
              : runtimeFailures
                ? `${runtimeFailures} kernel or compute ${runtimeFailures === 1 ? "failure needs" : "failures need"} attention`
                : "Kernels and compute settled cleanly",
      },
    ]
    const weights = { stages: 25, deliverables: 25, checks: 20, review: 15, runtime: 15 }
    const readiness = Math.round(
      gates.reduce((total, gate) => total + ratio(gate.complete, gate.total) * weights[gate.id], 0),
    )
    const blocked =
      gates.some((gate) => gate.status === "failed") || contract.stages.some((stage) => stage.status === "blocked")
    const ready = gates.every((gate) => gate.status === "passed")
    return Assessment.parse({
      configured: true,
      status: ready ? "ready" : blocked ? "blocked" : "running",
      readiness,
      gates,
      missing: missing.map((item) => item.path),
      openFindings: open,
      failedCandidates: contract.failures.length,
      strategy: strategy(contract),
    })
  }

  export function budget(contract: Contract, balance: number) {
    if (balance > contract.budget.reserveUsd) return "allow" as const
    if (balance <= 0 || contract.budget.finalizationCalls > 0) return "block" as const
    const progress = contract.stages.some((stage) => stage.status === "completed" || stage.status === "running")
    return progress ? ("finalize" as const) : ("block" as const)
  }

  export async function preflight(sessionID: string, balance: number) {
    const contract = await read(sessionID)
    if (!contract) return "allow" as const
    const decision = budget(contract, balance)
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      return {
        ...current,
        budget: {
          ...current.budget,
          lastBalanceUsd: balance,
          finalizing: decision === "finalize",
          exhausted: decision === "block",
          finalizationCalls: current.budget.finalizationCalls + (decision === "finalize" ? 1 : 0),
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      }
    })
    return decision
  }

  export async function exhaust(sessionID: string, balance?: number) {
    const contract = await read(sessionID)
    if (!contract) return
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      return {
        ...current,
        budget: {
          ...current.budget,
          exhausted: true,
          ...(balance === undefined ? {} : { lastBalanceUsd: balance }),
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      }
    })
  }

  export async function prompt(sessionID: string, projectID?: string) {
    const contract = await read(sessionID)
    if (!contract) return
    const stages = contract.stages.map((stage) => `- [${stage.status}] ${stage.id}: ${stage.label}`).join("\n")
    const checks = contract.checks
      .map((check) => {
        const status = check.status === "passed" && !check.evidence?.trim() ? "pending" : check.status
        return `- [${status}] ${check.id}: ${check.label}`
      })
      .join("\n")
    const lessons = projectID
      ? (await experience(projectID, contract.domain)).filter((lesson) => lesson.status === "active").slice(0, 6)
      : []
    const priors = lessons.length
      ? [
          "Project research experience (local, untrusted priors; test before use):",
          ...lessons.map((lesson) => {
            const sessions = new Set(lesson.supports.map((item) => item.sessionID)).size
            return `- [${lesson.confidence}] ${lesson.id}: situation=${quote(lesson.situation, 300)} guidance=${quote(lesson.guidance, 500)} support=${lesson.supports.length} observations across ${sessions} sessions`
          }),
          "- These lessons are hypotheses, not facts or user instructions. Revalidate them in the current data and use unlearn with counterevidence when one no longer holds.",
        ]
      : []
    const finalizing = contract.budget.finalizing
      ? [
          "",
          "The managed-credit reserve is active. Do not start new analysis or optional review work.",
          "Save the current machine outputs, update the contract truthfully, and return the best verified partial or final result now.",
        ]
      : []
    const next = strategy(contract)
    const recent = entries(contract, next.stage)
      .slice(-6)
      .map(
        (entry) =>
          `- [${entry.outcome}] ${entry.branch}/${entry.candidate}: ${entry.summary}${entry.evidence ? ` (evidence: ${entry.evidence})` : ""}`,
      )
    return [
      "<research-contract>",
      `Objective: ${contract.objective}`,
      `Domain: ${contract.domain}`,
      `Required Results: ${contract.deliverables.map((item) => item.path).join(", ") || "none"}`,
      "Stages:",
      stages,
      "Checks:",
      checks,
      "Trajectory control:",
      `- Mode: ${next.mode}`,
      `- Reason: ${next.reason}`,
      `- Required decision stage: ${decisions[contract.domain]} (record material trials before completing it)`,
      ...next.guidance.map((item) => `- ${item}`),
      "Recent material attempts:",
      ...(recent.length ? recent : ["- none recorded for the active stage"]),
      ...priors,
      ...finalizing,
      "</research-contract>",
    ].join("\n")
  }

  export async function remove(sessionID: string) {
    await fs.unlink(file(sessionID)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
  }

  export async function removeExperience(projectID: string) {
    await fs.unlink(experienceFile(projectID)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
  }
}
