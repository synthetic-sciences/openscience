import fs from "node:fs/promises"
import path from "node:path"
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

  export const Assessment = z.object({
    configured: z.boolean(),
    status: z.enum(["unconfigured", "running", "blocked", "ready"]),
    readiness: z.number().int().min(0).max(100),
    gates: z.array(Gate),
    missing: z.array(z.string()),
    openFindings: z.number().int().nonnegative(),
    failedCandidates: z.number().int().nonnegative(),
  })
  export type Assessment = z.infer<typeof Assessment>

  const file = (sessionID: string) => path.join(Global.Path.data, "research", `${encodeURIComponent(sessionID)}.json`)

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
  ): Promise<Contract> {
    const item = Failure.parse({
      ...input,
      id: `failure-${crypto.randomUUID()}`,
      recordedAt: Date.now(),
    })
    await JsonStore.update(file(sessionID), (data) => {
      const current = Contract.parse(data)
      return { ...current, failures: [...current.failures, item], updatedAt: Date.now() }
    })
    return (await read(sessionID))!
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
      })
    }
    const required = contract.deliverables.filter((item) => item.required)
    const paths = evidence.artifacts.flatMap((item) => (item.path ? [item.path] : []))
    const missing = required.filter((item) => !paths.some((value) => match(item.path, value)))
    const stages = contract.stages.filter((stage) => stage.status === "completed").length
    const checks = contract.checks.filter((check) => check.status === "passed").length
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

  export async function prompt(sessionID: string) {
    const contract = await read(sessionID)
    if (!contract) return
    const stages = contract.stages.map((stage) => `- [${stage.status}] ${stage.id}: ${stage.label}`).join("\n")
    const checks = contract.checks.map((check) => `- [${check.status}] ${check.id}: ${check.label}`).join("\n")
    const finalizing = contract.budget.finalizing
      ? [
          "",
          "The managed-credit reserve is active. Do not start new analysis or optional review work.",
          "Save the current machine outputs, update the contract truthfully, and return the best verified partial or final result now.",
        ]
      : []
    return [
      "<research-contract>",
      `Objective: ${contract.objective}`,
      `Domain: ${contract.domain}`,
      `Required Results: ${contract.deliverables.map((item) => item.path).join(", ") || "none"}`,
      "Stages:",
      stages,
      "Checks:",
      checks,
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
}
