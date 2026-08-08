import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessAutonomy {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Subject = z
    .object({
      type: z.enum(["run", "candidate"]),
      id: z.string().min(1).max(240),
    })
    .strict()
  export type Subject = z.infer<typeof Subject>

  export const Actor = z.enum(["benchmark", "human", "agent"])
  export type Actor = z.infer<typeof Actor>

  export const Contribution = z.enum(["problem", "auxiliary", "essential", "core", "unclear"])
  export type Contribution = z.infer<typeof Contribution>

  export const Kind = z.enum([
    "problem_statement",
    "clarification",
    "resource_provision",
    "strategy",
    "technical_correction",
    "artifact_edit",
    "candidate_selection",
    "evaluation_feedback",
    "exposition",
    "other",
  ])
  export type Kind = z.infer<typeof Kind>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  const EventInput = z
    .object({
      sequence: z.number().int().positive(),
      at: z.number().int().positive(),
      actor: Actor,
      kind: Kind,
      contribution: Contribution,
      contentSHA256: Hash,
      artifactBeforeSHA256: Hash.optional(),
      artifactAfterSHA256: Hash.optional(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  export const Event = EventInput.extend({
    priorEventID: Hash.nullable(),
    eventID: Hash,
  }).strict()
  export type Event = z.infer<typeof Event>

  export const Submit = Access.extend({
    subject: Subject,
    artifactSHA256: Hash,
    trace: z
      .object({
        owner: z.literal("evaluator_runtime"),
        complete: z.literal(true),
        recorderArtifactSHA256: Hash,
        schemaSHA256: Hash,
        classificationPolicySHA256: Hash,
        rawLogSHA256: Hash,
        startedAt: z.number().int().positive(),
        endedAt: z.number().int().positive(),
        events: z.array(EventInput).min(2).max(10_000),
      })
      .strict(),
  }).strict()
  export type Submit = z.infer<typeof Submit>

  const Counts = z.record(Actor, z.record(Contribution, z.number().int().nonnegative()))

  export const Metrics = z
    .object({
      events: z.number().int().positive(),
      counts: Counts,
      problemEvents: z.number().int().nonnegative(),
      humanSubstantiveEvents: z.number().int().nonnegative(),
      agentSubstantiveEvents: z.number().int().nonnegative(),
      unclearEvents: z.number().int().nonnegative(),
      linkedArtifactEvents: z.number().int().nonnegative(),
      artifactTransitions: z.number().int().nonnegative(),
      finalArtifactLinked: z.boolean(),
    })
    .strict()
  export type Metrics = z.infer<typeof Metrics>

  export const Receipt = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("human-ai-autonomy-receipt-v1"),
      receiptID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      protocolSHA256: Hash,
      subject: Subject,
      artifactSHA256: Hash,
      traceSHA256: Hash,
      recorderArtifactSHA256: Hash,
      rawLogSHA256: Hash,
      startedAt: z.number().int().positive(),
      endedAt: z.number().int().positive(),
      events: z.array(Event).min(2).max(10_000),
      claimedLevel: HarnessContract.AutonomyLevel,
      derivedLevel: HarnessContract.AutonomyLevel.optional(),
      metrics: Metrics,
      status: z.enum(["passed", "failed", "inconclusive"]),
      failures: z.array(z.string().min(1).max(500)).max(32),
      recordedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const stable = structuredClone(value) as Record<string, unknown>
      delete stable.receiptID
      delete stable.recordedAt
      if (digest(stable) === value.receiptID) return
      ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Human-AI autonomy receipt hash is invalid" })
    })
  export type Receipt = z.infer<typeof Receipt>

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.autonomy
    if (!protocol) return ""
    return [
      '<human-ai-autonomy-policy trace-owner="evaluator">',
      `This run predeclares the ${protocol.claimedLevel} human-AI contribution level under human-ai-autonomy-v1.`,
      "Every benchmark, human, and agent interaction is captured by the evaluator runtime; do not ask for unrecorded side-channel help.",
      "Problem statements are distinct from auxiliary exposition, while strategy, technical corrections, artifact edits, selection, and feedback may be classified as essential or core.",
      "The backend derives the final level from the complete trace. Unclear contribution labels are inconclusive, and an essential human contribution prevents an essentially-autonomous pass.",
      "Raw interaction content is retained outside the candidate context; receipts contain hashes and evidence references, not hidden prompts or evaluator capabilities.",
      "</human-ai-autonomy-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }

  const root = path.join(Global.Path.data, "harness", "autonomy")
  const receiptFile = (receiptID: string) => path.join(root, "receipts", `${receiptID}.json`)
  const subjectFile = (sessionID: string, subject: Subject) =>
    path.join(
      root,
      "subjects",
      encodeURIComponent(sessionID),
      `${encodeURIComponent(`${subject.type}:${subject.id}`)}.json`,
    )

  async function target(contract: HarnessContract.Info, subject: Subject) {
    if (subject.type === "run") {
      if (subject.id !== contract.runID) throw new Error(`Human-AI autonomy run subject does not match its contract`)
      return { createdAt: contract.createdAt }
    }
    const state = await import("./search")
      .then((module) => module.HarnessSearch.read(contract.sessionID))
      .catch(() => null)
    const candidate = state?.runID === contract.runID ? state.candidates[subject.id] : undefined
    if (!candidate) throw new Error(`Human-AI autonomy candidate does not exist in the bound search`)
    return { createdAt: candidate.createdAt, artifactSHA256: candidate.artifact.sha256 }
  }

  function replay(input: z.infer<typeof EventInput>[], startedAt: number, endedAt: number) {
    const state = input.reduce<{ events: Event[]; artifact?: string }>(
      (state, item, index) => {
        if (item.sequence !== index + 1) throw new Error(`Human-AI interaction trace must be contiguous from one`)
        if (item.at < startedAt || item.at > endedAt) {
          throw new Error(`Human-AI interaction event ${item.sequence} falls outside the trace interval`)
        }
        if (state.events.length && item.at < state.events.at(-1)!.at) {
          throw new Error(`Human-AI interaction trace time must be monotonic`)
        }
        if (state.artifact && item.artifactAfterSHA256 && item.artifactBeforeSHA256 !== state.artifact) {
          throw new Error(`Human-AI interaction artifact transitions must form one continuous chain`)
        }
        if (item.kind === "problem_statement" && item.contribution !== "problem") {
          throw new Error(`A problem statement must use the problem contribution class`)
        }
        if ((!index && item.kind !== "problem_statement") || (index > 0 && item.kind === "problem_statement")) {
          throw new Error(`Human-AI interaction trace requires exactly one initial problem statement`)
        }
        if (item.contribution === "problem" && item.kind !== "problem_statement") {
          throw new Error(`Only a problem statement may use the problem contribution class`)
        }
        if (item.contribution === "problem" && item.actor === "agent") {
          throw new Error(`An agent-authored event cannot pose the frozen benchmark problem`)
        }
        if (item.kind === "exposition" && !["auxiliary", "unclear"].includes(item.contribution)) {
          throw new Error(`Exposition cannot be classified as essential or core scientific content`)
        }
        const priorEventID = state.events.at(-1)?.eventID ?? null
        const stable = { ...item, priorEventID }
        state.events.push(Event.parse({ ...stable, eventID: digest(stable) }))
        return { events: state.events, artifact: item.artifactAfterSHA256 ?? state.artifact }
      },
      { events: [] },
    )
    return state.events
  }

  function assess(input: { protocol: HarnessContract.HumanAIAutonomy; events: Event[]; artifactSHA256: string }) {
    const counts = Counts.parse(
      Object.fromEntries(
        Actor.options.map((actor) => [
          actor,
          Object.fromEntries(
            Contribution.options.map((contribution) => [
              contribution,
              input.events.filter((item) => item.actor === actor && item.contribution === contribution).length,
            ]),
          ),
        ]),
      ),
    )
    const humanSubstantiveEvents = counts.human.essential + counts.human.core
    const agentSubstantiveEvents = counts.agent.essential + counts.agent.core
    const unclearEvents = counts.benchmark.unclear + counts.human.unclear + counts.agent.unclear
    const problemEvents = input.events.filter((item) => item.kind === "problem_statement").length
    const linkedArtifactEvents = input.events.filter((item) => item.artifactAfterSHA256 === input.artifactSHA256).length
    const transitions = input.events.filter((item) => item.artifactAfterSHA256)
    const artifactTransitions = transitions.length
    const finalArtifactLinked = transitions.at(-1)?.artifactAfterSHA256 === input.artifactSHA256
    const derivedLevel = unclearEvents
      ? undefined
      : humanSubstantiveEvents && agentSubstantiveEvents
        ? ("human_ai_collaboration" as const)
        : humanSubstantiveEvents
          ? ("primarily_human" as const)
          : agentSubstantiveEvents
            ? ("essentially_autonomous" as const)
            : undefined
    const metrics = Metrics.parse({
      events: input.events.length,
      counts,
      problemEvents,
      humanSubstantiveEvents,
      agentSubstantiveEvents,
      unclearEvents,
      linkedArtifactEvents,
      artifactTransitions,
      finalArtifactLinked,
    })
    const structural = [
      ...(!problemEvents ? ["interaction trace has no frozen problem statement"] : []),
      ...(!input.events.some((item) => item.actor === "agent") ? ["interaction trace has no agent event"] : []),
      ...(!finalArtifactLinked ? ["last interaction artifact transition does not bind the final artifact"] : []),
      ...(!derivedLevel && !unclearEvents
        ? ["interaction trace has no essential or core scientific contribution"]
        : []),
    ]
    const uncertain = unclearEvents ? [`${unclearEvents} interaction contribution classifications are unclear`] : []
    const mismatch =
      derivedLevel && derivedLevel !== input.protocol.claimedLevel
        ? [`derived autonomy level ${derivedLevel} does not match claimed level ${input.protocol.claimedLevel}`]
        : []
    const failures = [...structural, ...uncertain, ...mismatch]
    const status = uncertain.length
      ? ("inconclusive" as const)
      : failures.length
        ? ("failed" as const)
        : ("passed" as const)
    return { metrics, derivedLevel, status, failures }
  }

  function verify(receipt: Receipt, protocol: HarnessContract.HumanAIAutonomy) {
    if (
      receipt.recorderArtifactSHA256 !== protocol.recorder.artifactSHA256 ||
      receipt.claimedLevel !== protocol.claimedLevel
    ) {
      throw new Error(`Human-AI autonomy receipt changed its frozen protocol identity`)
    }
    if (receipt.events.length > protocol.maxEvents) {
      throw new Error(`Human-AI autonomy receipt exceeds its frozen event budget`)
    }
    const events = replay(
      receipt.events.map((item) =>
        EventInput.parse(
          Object.fromEntries(Object.entries(item).filter(([key]) => key !== "eventID" && key !== "priorEventID")),
        ),
      ),
      receipt.startedAt,
      receipt.endedAt,
    )
    const trace = {
      recorderArtifactSHA256: receipt.recorderArtifactSHA256,
      rawLogSHA256: receipt.rawLogSHA256,
      startedAt: receipt.startedAt,
      endedAt: receipt.endedAt,
      events,
    }
    if (!same(events, receipt.events) || digest(trace) !== receipt.traceSHA256) {
      throw new Error(`Human-AI autonomy receipt does not match its backend-replayed interaction trace`)
    }
    const result = assess({ protocol, events, artifactSHA256: receipt.artifactSHA256 })
    if (
      !same(result.metrics, receipt.metrics) ||
      result.derivedLevel !== receipt.derivedLevel ||
      result.status !== receipt.status ||
      !same(result.failures, receipt.failures)
    ) {
      throw new Error(`Human-AI autonomy receipt does not match its backend-derived classification`)
    }
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    if (value.sessionID !== contract.sessionID) {
      throw new Error(`Human-AI autonomy session does not match its bound harness contract`)
    }
    const protocol = contract.autonomy
    if (!protocol) throw new Error(`Harness contract does not require human-AI autonomy tracing`)
    if (value.trace.recorderArtifactSHA256 !== protocol.recorder.artifactSHA256) {
      throw new Error(`Human-AI interaction recorder does not match the bound protocol`)
    }
    if (value.trace.schemaSHA256 !== protocol.traceSchemaSHA256) {
      throw new Error(`Human-AI interaction trace schema does not match the bound protocol`)
    }
    if (value.trace.classificationPolicySHA256 !== protocol.classificationPolicySHA256) {
      throw new Error(`Human-AI contribution policy does not match the bound protocol`)
    }
    if (value.trace.events.length > protocol.maxEvents) {
      throw new Error(`Human-AI interaction trace exceeds its frozen event budget`)
    }
    if (value.trace.endedAt < value.trace.startedAt) {
      throw new Error(`Human-AI interaction trace ends before it starts`)
    }
    const recordedAt = Date.now()
    const subject = await target(contract, value.subject)
    if (value.trace.startedAt !== contract.createdAt || value.trace.endedAt > recordedAt) {
      throw new Error(`Human-AI interaction trace falls outside its bound run interval`)
    }
    if (
      value.subject.type === "candidate" &&
      (value.trace.startedAt > subject.createdAt || value.trace.endedAt < subject.createdAt)
    ) {
      throw new Error(`Human-AI interaction trace does not enclose candidate creation`)
    }
    if (subject.artifactSHA256 && subject.artifactSHA256 !== value.artifactSHA256) {
      throw new Error(`Human-AI autonomy receipt changed the candidate artifact`)
    }
    const events = replay(value.trace.events, value.trace.startedAt, value.trace.endedAt)
    const result = assess({ protocol, events, artifactSHA256: value.artifactSHA256 })
    const trace = {
      recorderArtifactSHA256: value.trace.recorderArtifactSHA256,
      rawLogSHA256: value.trace.rawLogSHA256,
      startedAt: value.trace.startedAt,
      endedAt: value.trace.endedAt,
      events,
    }
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "human-ai-autonomy-receipt-v1" as const,
      runID: contract.runID,
      sessionID: contract.sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      subject: value.subject,
      artifactSHA256: value.artifactSHA256,
      traceSHA256: digest(trace),
      recorderArtifactSHA256: value.trace.recorderArtifactSHA256,
      rawLogSHA256: value.trace.rawLogSHA256,
      startedAt: value.trace.startedAt,
      endedAt: value.trace.endedAt,
      events,
      claimedLevel: protocol.claimedLevel,
      derivedLevel: result.derivedLevel,
      metrics: result.metrics,
      status: result.status,
      failures: result.failures,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable), recordedAt })
    const claimed = await JsonStore.read(subjectFile(receipt.sessionID, receipt.subject))
    if (Object.keys(claimed).length) {
      const current = Receipt.parse(claimed)
      if (current.receiptID !== receipt.receiptID) {
        throw new Error(`Human-AI autonomy subject already has a canonical receipt`)
      }
    }
    await JsonStore.update(receiptFile(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Human-AI autonomy receipt is immutable once recorded`)
    })
    await JsonStore.update(subjectFile(receipt.sessionID, receipt.subject), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Human-AI autonomy subject already has a canonical receipt`)
    })
    const saved = await readReceipt(receipt.receiptID)
    if (!saved) throw new Error(`Human-AI autonomy receipt was not durable after recording`)
    return saved
  }

  export async function readReceipt(receiptID: string) {
    const id = Hash.parse(receiptID)
    const parsed = Receipt.safeParse(await JsonStore.read(receiptFile(id)))
    if (!parsed.success || parsed.data.receiptID !== id) return null
    const canonical = Receipt.safeParse(await JsonStore.read(subjectFile(parsed.data.sessionID, parsed.data.subject)))
    if (!canonical.success || canonical.data.receiptID !== id || !same(canonical.data, parsed.data)) return null
    return parsed.data
  }

  export async function read(receiptID: string, contract: HarnessContract.Info) {
    const receipt = await readReceipt(receiptID)
    if (!receipt || receipt.sessionID !== contract.sessionID) {
      throw new Error(`Unknown human-AI autonomy receipt ${receiptID}`)
    }
    const protocol = contract.autonomy
    if (!protocol || receipt.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Human-AI autonomy receipt belongs to a different harness run`)
    }
    verify(receipt, protocol)
    const subject = await target(contract, receipt.subject)
    if (
      receipt.startedAt !== contract.createdAt ||
      receipt.endedAt > receipt.recordedAt ||
      (receipt.subject.type === "candidate" &&
        (receipt.startedAt > subject.createdAt || receipt.endedAt < subject.createdAt)) ||
      (subject.artifactSHA256 && subject.artifactSHA256 !== receipt.artifactSHA256)
    ) {
      throw new Error(`Human-AI autonomy receipt changed its bound run, candidate, or artifact interval`)
    }
    return receipt
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    subject: Subject
    evaluatedAt: number
    recordedAt: number
    requirePassed: boolean
  }) {
    const receipt = await readReceipt(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt human-AI autonomy receipt ${input.receiptID}`)
    const protocol = input.contract.autonomy
    if (!protocol) throw new Error(`Evaluation cites an autonomy receipt without a bound protocol`)
    if (
      receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract) ||
      receipt.protocolSHA256 !== digest(protocol) ||
      receipt.sessionID !== input.contract.sessionID ||
      receipt.runID !== input.contract.runID
    ) {
      throw new Error(`Human-AI autonomy receipt belongs to a different harness run`)
    }
    verify(receipt, protocol)
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Human-AI autonomy receipt belongs to a different evaluation subject`)
    }
    const subject = await target(input.contract, input.subject)
    if (
      receipt.startedAt !== input.contract.createdAt ||
      receipt.endedAt > receipt.recordedAt ||
      (input.subject.type === "candidate" &&
        (receipt.startedAt > subject.createdAt || receipt.endedAt < subject.createdAt)) ||
      (subject.artifactSHA256 && subject.artifactSHA256 !== receipt.artifactSHA256)
    ) {
      throw new Error(`Human-AI autonomy receipt belongs to a different candidate artifact or interval`)
    }
    if (
      receipt.endedAt > input.evaluatedAt ||
      receipt.recordedAt > input.evaluatedAt ||
      receipt.recordedAt > input.recordedAt
    ) {
      throw new Error(`Evaluation predates its human-AI autonomy receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing final evaluation requires a passing human-AI autonomy receipt`)
    }
    return receipt
  }
}
