import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessIntegrity {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Artifact = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: Hash,
    })
    .strict()

  export const Subject = z
    .object({
      type: z.enum(["run", "candidate"]),
      id: z.string().min(1).max(240),
      artifact: Artifact,
    })
    .strict()

  export const Trace = z
    .object({
      artifact: Artifact,
      schemaSHA256: Hash,
      events: z.number().int().min(1).max(10_000_000),
      dropped: z.number().int().min(0).max(10_000_000),
      startedAt: z.number().int().positive(),
      endedAt: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.endedAt >= value.startedAt, "Trace end cannot predate its start")

  export const Model = z
    .object({
      name: z.string().min(1).max(500),
      baseArtifactSHA256: Hash,
      configSHA256: Hash,
      outputArtifactSHA256: Hash,
      lineageVerified: z.boolean(),
    })
    .strict()

  export const Audit = z
    .object({
      kind: HarnessContract.IntegrityAuditKind,
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      promptSHA256: Hash,
      decision: z.enum(["clean", "flagged", "abstain"]),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  export const Activity = z
    .object({
      unapprovedExternalModelCalls: z.number().int().min(0).max(10_000_000),
      benchmarkLookupEvents: z.number().int().min(0).max(10_000_000),
      hiddenCanaryManifestSHA256: Hash,
      hiddenCanariesTested: z.number().int().min(0).max(10_000),
      hiddenCanaryViolations: z.number().int().min(0).max(10_000),
    })
    .strict()
    .refine(
      (value) => value.hiddenCanaryViolations <= value.hiddenCanariesTested,
      "Hidden canary violations cannot exceed tested canaries",
    )

  export const Validator = z
    .object({
      name: z.literal("verify-benchmark-integrity"),
      version: z.literal(1),
      scriptSHA256: Hash,
    })
    .strict()

  export const Submit = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      protocol: HarnessContract.Integrity,
      subject: Subject,
      trace: Trace,
      model: Model,
      audits: z
        .array(Audit)
        .length(HarnessContract.IntegrityAuditKind.options.length)
        .refine(
          (items) => new Set(items.map((item) => item.kind)).size === items.length,
          "Integrity audits must be unique",
        ),
      activity: Activity,
      validator: Validator,
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()

  export const Failure = z.enum([
    "trace_schema",
    "trace_event_floor",
    "trace_coverage",
    "model_name",
    "model_base_artifact",
    "model_config",
    "model_lineage",
    "forbidden_model_artifact",
    "test_item_contamination",
    "external_model_use",
    "benchmark_lookup",
    "hidden_canary_manifest",
    "hidden_canary_coverage",
    "hidden_canary_violation",
  ])

  export const Checks = z
    .object({
      traceCompleteness: z.boolean(),
      modelIdentity: z.boolean(),
      testItemContamination: z.boolean(),
      externalModelUse: z.boolean(),
      benchmarkLookup: z.boolean(),
      hiddenCanary: z.boolean(),
    })
    .strict()

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      submissionID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      subject: Subject,
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "external"]),
        })
        .strict(),
      protocol: HarnessContract.Integrity,
      trace: Trace,
      traceCoverage: z.number().min(0).max(1),
      model: Model,
      audits: z.array(Audit).length(HarnessContract.IntegrityAuditKind.options.length),
      activity: Activity,
      validator: Validator,
      checks: Checks,
      status: z.enum(["passed", "failed"]),
      failures: z.array(Failure).max(Failure.options.length),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  const request = (input: {
    runID: string
    sessionID: string
    protocol: HarnessContract.Integrity
    subject: z.infer<typeof Subject>
    trace: z.infer<typeof Trace>
    model: z.infer<typeof Model>
    audits: z.infer<typeof Audit>[]
    activity: z.infer<typeof Activity>
    validator: z.infer<typeof Validator>
    evidence: string[]
    evaluatedAt: number
  }) => digest(input)

  function outcome(
    protocol: HarnessContract.Integrity,
    trace: z.infer<typeof Trace>,
    model: z.infer<typeof Model>,
    audits: z.infer<typeof Audit>[],
    activity: z.infer<typeof Activity>,
  ) {
    const coverage = trace.events / (trace.events + trace.dropped)
    const decision = (kind: HarnessContract.IntegrityAuditKind) =>
      audits.find((item) => item.kind === kind)?.decision === "clean"
    const traceFailures = [
      ...(trace.schemaSHA256 === protocol.traceSchemaSHA256 ? [] : ["trace_schema" as const]),
      ...(trace.events >= protocol.minEvents ? [] : ["trace_event_floor" as const]),
      ...(coverage >= protocol.minCoverage ? [] : ["trace_coverage" as const]),
    ]
    const modelFailures = [
      ...(model.name === protocol.assignedModel.name ? [] : ["model_name" as const]),
      ...(model.baseArtifactSHA256 === protocol.assignedModel.baseArtifactSHA256
        ? []
        : ["model_base_artifact" as const]),
      ...(model.configSHA256 === protocol.assignedModel.configSHA256 ? [] : ["model_config" as const]),
      ...(model.lineageVerified ? [] : ["model_lineage" as const]),
      ...(protocol.forbiddenModelArtifacts.includes(model.outputArtifactSHA256)
        ? ["forbidden_model_artifact" as const]
        : []),
    ]
    const auditFailures = [
      ...(decision("test_item_contamination") ? [] : ["test_item_contamination" as const]),
      ...(decision("external_model_use") && activity.unapprovedExternalModelCalls === 0
        ? []
        : ["external_model_use" as const]),
      ...(decision("benchmark_lookup") && activity.benchmarkLookupEvents === 0 ? [] : ["benchmark_lookup" as const]),
    ]
    const canaryFailures = [
      ...(activity.hiddenCanaryManifestSHA256 === protocol.hiddenCanaryManifestSHA256
        ? []
        : ["hidden_canary_manifest" as const]),
      ...(activity.hiddenCanariesTested >= protocol.minHiddenCanaries ? [] : ["hidden_canary_coverage" as const]),
      ...(activity.hiddenCanaryViolations === 0 ? [] : ["hidden_canary_violation" as const]),
    ]
    const failures = Failure.array().parse([...traceFailures, ...modelFailures, ...auditFailures, ...canaryFailures])
    const checks = Checks.parse({
      traceCompleteness: traceFailures.length === 0,
      modelIdentity: modelFailures.length === 0,
      testItemContamination: !auditFailures.includes("test_item_contamination"),
      externalModelUse: !auditFailures.includes("external_model_use"),
      benchmarkLookup: !auditFailures.includes("benchmark_lookup"),
      hiddenCanary: canaryFailures.length === 0,
    })
    return {
      traceCoverage: coverage,
      checks,
      status: failures.length ? ("failed" as const) : ("passed" as const),
      failures,
    }
  }

  const State = z
    .object({
      schemaVersion: z.literal(1),
      items: z.record(Hash, Info),
      order: z.array(Hash),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Integrity receipt order must be unique" })
      }
      for (const id of value.order) {
        const receipt = value.items[id]
        if (!receipt) {
          ctx.addIssue({ code: "custom", path: ["order"], message: `Integrity receipt ${id} is missing` })
          continue
        }
        if (receipt.receiptID !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Integrity receipt key does not match its ID" })
        }
        const payload = structuredClone(receipt) as Record<string, unknown>
        delete payload.receiptID
        if (digest(payload) !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Integrity receipt content hash is invalid" })
        }
        const derived = outcome(receipt.protocol, receipt.trace, receipt.model, receipt.audits, receipt.activity)
        if (
          !same(
            {
              traceCoverage: receipt.traceCoverage,
              checks: receipt.checks,
              status: receipt.status,
              failures: receipt.failures,
            },
            derived,
          )
        ) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Integrity receipt outcome derivation drifted" })
        }
        if (
          receipt.submissionID !==
          request({
            runID: receipt.runID,
            sessionID: receipt.sessionID,
            protocol: receipt.protocol,
            subject: receipt.subject,
            trace: receipt.trace,
            model: receipt.model,
            audits: receipt.audits,
            activity: receipt.activity,
            validator: receipt.validator,
            evidence: receipt.evidence,
            evaluatedAt: receipt.evaluatedAt,
          })
        ) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Integrity submission content hash is invalid" })
        }
      }
      for (const id of Object.keys(value.items)) {
        if (value.order.includes(id)) continue
        ctx.addIssue({ code: "custom", path: ["items", id], message: "Integrity receipt is absent from journal order" })
      }
    })
  type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "integrity")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const empty = (): State => ({ schemaVersion: 1, items: {}, order: [] })
  const state = (input: Record<string, unknown>) => State.parse(Object.keys(input).length ? input : empty())

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    const protocol = bound.integrity
    if (!protocol) throw new Error(`No runtime integrity protocol is bound to session ${value.sessionID}`)
    if (bound.sessionID !== value.sessionID || bound.runID !== value.runID) {
      throw new Error(`Integrity receipt does not match the bound harness run`)
    }
    if (value.trace.startedAt < bound.createdAt) throw new Error(`Integrity trace predates the harness contract`)
    if (value.evaluatedAt < value.trace.endedAt) throw new Error(`Integrity validation predates the trace end`)
    if (value.evaluatedAt > Date.now() + 300_000) throw new Error(`Integrity receipt is implausibly future-dated`)
    if (!same(value.protocol, protocol))
      throw new Error(`Integrity protocol does not match the immutable harness contract`)
    if (value.validator.scriptSHA256 !== protocol.validatorSHA256) {
      throw new Error(`Integrity validator does not match the immutable harness contract`)
    }
    const expected = protocol.auditors.toSorted((left, right) => left.kind.localeCompare(right.kind))
    const audits = value.audits
      .map((item) => ({ ...item, evidence: item.evidence.toSorted() }))
      .toSorted((left, right) => left.kind.localeCompare(right.kind))
    const identities = audits.map((item) => ({
      kind: item.kind,
      name: item.name,
      version: item.version,
      promptSHA256: item.promptSHA256,
    }))
    if (!same(expected, identities)) throw new Error(`Integrity auditors do not match the immutable harness contract`)
    if (value.subject.type === "run" && value.subject.id !== bound.runID) {
      throw new Error(`Run integrity receipt subject does not match the contract run`)
    }
    if (value.subject.type === "candidate") {
      const search = await import("./search").then((module) => module.HarnessSearch.read(value.sessionID))
      const candidate = search.candidates[value.subject.id]
      if (!candidate) throw new Error(`Integrity receipt candidate does not exist in the bound search`)
      if (!same(candidate.artifact, value.subject.artifact)) {
        throw new Error(`Integrity receipt artifact does not match the candidate artifact`)
      }
    }
    const evidence = value.evidence.toSorted()
    const submissionID = request({
      runID: value.runID,
      sessionID: value.sessionID,
      protocol,
      subject: value.subject,
      trace: value.trace,
      model: value.model,
      audits,
      activity: value.activity,
      validator: value.validator,
      evidence,
      evaluatedAt: value.evaluatedAt,
    })
    const result = outcome(protocol, value.trace, value.model, audits, value.activity)
    const payload = {
      schemaVersion: 1 as const,
      submissionID,
      runID: value.runID,
      sessionID: value.sessionID,
      contractFingerprint: HarnessContract.fingerprint(bound),
      subject: value.subject,
      evaluator: {
        name: bound.benchmark.evaluator,
        version: bound.benchmark.evaluatorVersion!,
        source: bound.benchmark.evaluatorSource!,
      },
      protocol,
      trace: value.trace,
      traceCoverage: result.traceCoverage,
      model: value.model,
      audits,
      activity: value.activity,
      validator: value.validator,
      checks: result.checks,
      status: result.status,
      failures: result.failures,
      evidence,
      evaluatedAt: value.evaluatedAt,
      recordedAt: Date.now(),
    }
    const receipt = Info.parse({ ...payload, receiptID: digest(payload) })
    const out = { value: receipt }
    await JsonStore.update(file(value.sessionID), (data) => {
      const current = state(data)
      const existing = current.order.map((id) => current.items[id]!).find((item) => item.submissionID === submissionID)
      if (existing) {
        out.value = existing
        return current
      }
      return State.parse({
        ...current,
        items: { ...current.items, [receipt.receiptID]: receipt },
        order: [...current.order, receipt.receiptID],
      })
    })
    return out.value
  }

  export async function read(sessionID: string, receiptID: string) {
    const current = state(await JsonStore.read(file(sessionID)))
    return current.items[Hash.parse(receiptID)] ?? null
  }

  export async function list(sessionID: string) {
    const current = state(await JsonStore.read(file(sessionID)))
    return current.order.map((id) => current.items[id]!)
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    subject: { type: "run" | "candidate"; id: string }
    requirePassed: boolean
    evaluatedAt: number
    recordedAt: number
  }) {
    const receipt = await read(input.contract.sessionID, input.receiptID)
    if (!receipt) throw new Error(`Runtime integrity receipt ${input.receiptID} does not exist`)
    if (receipt.runID !== input.contract.runID)
      throw new Error(`Runtime integrity receipt does not match the harness run`)
    if (receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Runtime integrity receipt does not match the immutable harness contract`)
    }
    if (!same(receipt.protocol, input.contract.integrity)) {
      throw new Error(`Runtime integrity receipt does not match the bound protocol`)
    }
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Runtime integrity receipt does not match the evaluated subject`)
    }
    if (receipt.evaluatedAt > input.evaluatedAt) {
      throw new Error(`Benchmark evaluation predates its referenced runtime integrity receipt`)
    }
    if (receipt.recordedAt > input.recordedAt) {
      throw new Error(`Benchmark evaluation was recorded before its runtime integrity receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A benchmark result requires a passing runtime integrity receipt`)
    }
    return receipt
  }
}
