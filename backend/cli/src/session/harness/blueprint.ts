import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessBlueprint {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  export const GoalSpec = z
    .object({
      statementSHA256: Hash,
      declaration: z.string().min(1).max(500),
      module: z.string().min(1).max(500),
    })
    .strict()
  export type GoalSpec = z.infer<typeof GoalSpec>

  const Goal = GoalSpec.extend({
    id: Hash,
    createdAt: z.number().int().positive(),
  }).strict()
  export type Goal = z.infer<typeof Goal>

  export const LeaseRequest = Access.extend({ count: z.number().int().min(1).max(32) }).strict()

  export const Lease = z
    .object({
      id: Hash,
      goalID: Hash,
      revision: z.number().int().nonnegative(),
      ordinal: z.number().int().nonnegative(),
      status: z.enum(["open", "consumed", "expired"]),
      issuedAt: z.number().int().positive(),
      expiresAt: z.number().int().positive(),
      consumedAt: z.number().int().positive().optional(),
    })
    .strict()
  export type Lease = z.infer<typeof Lease>

  const Verification = z
    .object({
      compilerArtifactSHA256: Hash,
      statementMatched: z.boolean(),
      exitCode: z.number().int(),
      warnings: z.number().int().nonnegative(),
      transcriptSHA256: Hash,
      feedbackSHA256: Hash,
      startedAt: z.number().int().positive(),
      endedAt: z.number().int().positive(),
    })
    .strict()

  export const DirectSubmit = Access.extend({
    kind: z.literal("direct"),
    leaseID: Hash,
    artifactSHA256: Hash,
    claim: z.enum(["proof", "refutation", "failure"]),
    verification: Verification,
  }).strict()
  export type DirectSubmit = z.infer<typeof DirectSubmit>

  const Sketch = Verification.extend({
    validatorArtifactSHA256: Hash,
    placeholderDeclarations: z.array(z.string().min(1).max(500)).min(1).max(16),
    validatorTranscriptSHA256: Hash,
  }).strict()

  const Review = z
    .object({
      reviewerArtifactSHA256: Hash,
      promptSHA256: Hash,
      relevant: z.boolean(),
      easier: z.boolean(),
      plausible: z.boolean(),
      transcriptSHA256: Hash,
    })
    .strict()

  export const DecompositionSubmit = Access.extend({
    kind: z.literal("decomposition"),
    leaseID: Hash,
    informalPlanSHA256: Hash,
    artifactSHA256: Hash,
    children: z.array(GoalSpec).min(1).max(16),
    verification: Sketch,
    review: Review,
  }).strict()
  export type DecompositionSubmit = z.infer<typeof DecompositionSubmit>

  export const Submit = z.discriminatedUnion("kind", [DirectSubmit, DecompositionSubmit])
  export type Submit = z.infer<typeof Submit>

  export const Attempt = z
    .object({
      id: Hash,
      ordinal: z.number().int().nonnegative(),
      goalID: Hash,
      leaseID: Hash,
      kind: z.enum(["direct", "decomposition"]),
      artifactSHA256: Hash,
      result: z.enum(["proved", "refuted", "failed", "accepted", "rejected"]),
      claim: z.enum(["proof", "refutation", "failure"]).optional(),
      decompositionID: Hash.optional(),
      transcriptSHA256: Hash,
      feedbackSHA256: Hash,
      failures: z.array(z.string().min(1).max(500)).max(16),
      startedAt: z.number().int().positive(),
      endedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const direct = value.kind === "direct"
      const result = direct
        ? (["proved", "refuted", "failed"] as const).includes(value.result as "proved")
        : (["accepted", "rejected"] as const).includes(value.result as "accepted")
      if (!result) {
        ctx.addIssue({ code: "custom", path: ["result"], message: "Attempt result does not match its operation" })
      }
      if (direct !== Boolean(value.claim)) {
        ctx.addIssue({ code: "custom", path: ["claim"], message: "Only direct attempts carry a proof claim" })
      }
      if (Boolean(value.decompositionID) !== (value.kind === "decomposition" && value.result === "accepted")) {
        ctx.addIssue({
          code: "custom",
          path: ["decompositionID"],
          message: "Only accepted decomposition attempts bind a graph node",
        })
      }
      const successful = value.result === "proved" || value.result === "refuted" || value.result === "accepted"
      if (successful === !value.failures.length) return
      ctx.addIssue({
        code: "custom",
        path: ["failures"],
        message: "Successful attempts cannot contain failures and rejected attempts must explain one",
      })
    })
  export type Attempt = z.infer<typeof Attempt>

  export const Decomposition = z
    .object({
      id: Hash,
      parentID: Hash,
      childIDs: z.array(Hash).min(1).max(16),
      informalPlanSHA256: Hash,
      sketchArtifactSHA256: Hash,
      sketchTranscriptSHA256: Hash,
      reviewerTranscriptSHA256: Hash,
      attemptID: Hash,
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Decomposition = z.infer<typeof Decomposition>

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("proof-blueprint-state-v1"),
      blueprintID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      protocolSHA256: Hash,
      rootGoalID: Hash,
      goals: z.record(z.string(), Goal),
      decompositions: z.record(z.string(), Decomposition),
      attempts: z.record(z.string(), Attempt),
      leases: z.record(z.string(), Lease),
      revision: z.number().int().nonnegative(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
  export type State = z.infer<typeof State>

  export const GoalStatus = z.enum(["open", "proved", "refuted", "exhausted"])
  export type GoalStatus = z.infer<typeof GoalStatus>
  export const DecompositionStatus = z.enum(["open", "closed", "blocked"])
  export type DecompositionStatus = z.infer<typeof DecompositionStatus>

  export const Summary = z
    .object({
      blueprintID: Hash,
      status: GoalStatus,
      goals: z.number().int().nonnegative(),
      proved: z.number().int().nonnegative(),
      refuted: z.number().int().nonnegative(),
      exhausted: z.number().int().nonnegative(),
      decompositions: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      refinements: z.number().int().nonnegative(),
      openLeases: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
    })
    .strict()
  export type Summary = z.infer<typeof Summary>

  export const View = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("proof-blueprint-view-v1"),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      rootGoalID: Hash,
      summary: Summary,
      goals: z.array(Goal.extend({ status: GoalStatus, ready: z.boolean() }).strict()),
      decompositions: z.array(Decomposition.extend({ status: DecompositionStatus }).strict()),
      attempts: z.array(Attempt),
      leases: z.array(Lease),
    })
    .strict()
  export type View = z.infer<typeof View>

  const root = path.join(Global.Path.data, "harness", "blueprints")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const goalID = (spec: GoalSpec) =>
    digest({
      protocol: "proof-blueprint-goal-v1",
      statementSHA256: spec.statementSHA256,
      declaration: spec.declaration,
      module: spec.module,
    })
  const blueprintID = (contract: HarnessContract.Info, protocol: HarnessContract.ProofBlueprint) =>
    digest({
      protocol: "proof-blueprint-state-v1",
      runID: contract.runID,
      sessionID: contract.sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
    })

  const leaseID = (state: State, input: Pick<Lease, "goalID" | "revision" | "ordinal" | "issuedAt" | "expiresAt">) =>
    digest({
      blueprintID: state.blueprintID,
      goalID: input.goalID,
      revision: input.revision,
      ordinal: input.ordinal,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    })

  const attemptID = (state: State, input: Attempt) =>
    digest({
      blueprintID: state.blueprintID,
      ordinal: input.ordinal,
      goalID: input.goalID,
      leaseID: input.leaseID,
      kind: input.kind,
      artifactSHA256: input.artifactSHA256,
      result: input.result,
      claim: input.claim,
      transcriptSHA256: input.transcriptSHA256,
      feedbackSHA256: input.feedbackSHA256,
      failures: input.failures,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      recordedAt: input.recordedAt,
    })

  const decompositionID = (state: State, input: Decomposition) =>
    digest({
      blueprintID: state.blueprintID,
      parentID: input.parentID,
      childIDs: input.childIDs,
      informalPlanSHA256: input.informalPlanSHA256,
      sketchArtifactSHA256: input.sketchArtifactSHA256,
      sketchTranscriptSHA256: input.sketchTranscriptSHA256,
      reviewerTranscriptSHA256: input.reviewerTranscriptSHA256,
      createdAt: input.createdAt,
    })

  const items = <T>(record: Record<string, T>) => Object.values(record)
  const direct = (state: State, id: string) =>
    items(state.attempts).filter((item) => item.goalID === id && item.kind === "direct")
  const sketches = (state: State, id: string) =>
    items(state.attempts).filter((item) => item.goalID === id && item.kind === "decomposition")
  const branches = (state: State, id: string) => items(state.decompositions).filter((item) => item.parentID === id)

  function statuses(state: State, protocol: HarnessContract.ProofBlueprint) {
    const goal = new Map<string, GoalStatus>()
    const branch = new Map<string, DecompositionStatus>()
    const visit = (id: string): GoalStatus => {
      const cached = goal.get(id)
      if (cached) return cached
      const attempts = direct(state, id)
      const proved = attempts.some((item) => item.result === "proved")
      const refuted = attempts.some((item) => item.result === "refuted")
      if (proved && refuted) throw new Error(`Proof blueprint goal cannot be both proved and refuted`)
      if (proved) {
        goal.set(id, "proved")
        return "proved"
      }
      if (refuted) {
        goal.set(id, "refuted")
        return "refuted"
      }
      const paths = branches(state, id)
      for (const item of paths) {
        const children = item.childIDs.map(visit)
        const status = children.every((value) => value === "proved")
          ? "closed"
          : children.some((value) => value === "refuted" || value === "exhausted")
            ? "blocked"
            : "open"
        branch.set(item.id, status)
      }
      if (paths.some((item) => branch.get(item.id) === "closed")) {
        goal.set(id, "proved")
        return "proved"
      }
      const attemptsFull = attempts.length >= protocol.maxAttemptsPerGoal
      const pathsFull = sketches(state, id).length >= protocol.maxRefinementsPerGoal + 1
      const allBlocked = paths.length > 0 && paths.every((item) => branch.get(item.id) === "blocked")
      const status = attemptsFull && pathsFull && (!paths.length || allBlocked) ? "exhausted" : "open"
      goal.set(id, status)
      return status
    }
    visit(state.rootGoalID)
    for (const id of Object.keys(state.goals)) visit(id)
    return { goal, branch }
  }

  function depths(state: State) {
    const values = new Map<string, number>([[state.rootGoalID, 0]])
    const queue = [state.rootGoalID]
    while (queue.length) {
      const id = queue.shift()!
      const depth = values.get(id)!
      for (const child of branches(state, id).flatMap((item) => item.childIDs)) {
        const next = Math.max(values.get(child) ?? 0, depth + 1)
        if (next === values.get(child)) continue
        values.set(child, next)
        queue.push(child)
      }
    }
    return values
  }

  function graphIssue(state: State, parentID: string, childIDs: string[], protocol: HarnessContract.ProofBlueprint) {
    const ids = [...new Set([...Object.keys(state.goals), ...childIDs])]
    if (ids.length > protocol.maxNodes) return "decomposition exceeds the frozen graph node budget"
    const adjacency = Object.fromEntries(ids.map((id) => [id, new Set<string>()]))
    for (const item of items(state.decompositions)) {
      for (const child of item.childIDs) adjacency[item.parentID]!.add(child)
    }
    for (const child of childIDs) adjacency[parentID]!.add(child)
    const indegree = Object.fromEntries(ids.map((id) => [id, 0]))
    for (const children of Object.values(adjacency)) {
      for (const child of children) indegree[child] = indegree[child]! + 1
    }
    const queue = ids.filter((id) => indegree[id] === 0)
    const order: string[] = []
    while (queue.length) {
      const id = queue.shift()!
      order.push(id)
      for (const child of adjacency[id]!) {
        indegree[child] = indegree[child]! - 1
        if (indegree[child] === 0) queue.push(child)
      }
    }
    if (order.length !== ids.length) return "decomposition would make the proof blueprint cyclic"
    const depth = new Map<string, number>([[state.rootGoalID, 0]])
    for (const id of order) {
      for (const child of adjacency[id]!) {
        depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1))
      }
    }
    if (Math.max(...depth.values()) > protocol.maxDepth) {
      return "decomposition exceeds the frozen graph depth budget"
    }
    return undefined
  }

  function ready(state: State, protocol: HarnessContract.ProofBlueprint, now = Date.now()) {
    const status = statuses(state, protocol)
    const held = new Set(
      items(state.leases)
        .filter((item) => item.status === "open" && item.expiresAt > now)
        .map((item) => item.goalID),
    )
    const depth = depths(state)
    return items(state.goals)
      .filter((item) => {
        if (status.goal.get(item.id) !== "open" || held.has(item.id)) return false
        if (branches(state, item.id).some((path) => status.branch.get(path.id) === "open")) return false
        const attempts = direct(state, item.id).length
        const paths = sketches(state, item.id).length
        return attempts < protocol.maxAttemptsPerGoal || (attempts > 0 && paths < protocol.maxRefinementsPerGoal + 1)
      })
      .toSorted(
        (a, b) =>
          (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) ||
          direct(state, a.id).length - direct(state, b.id).length ||
          a.id.localeCompare(b.id),
      )
  }

  function integrity(state: State, contract: HarnessContract.Info, protocol: HarnessContract.ProofBlueprint) {
    if (
      state.blueprintID !== blueprintID(contract, protocol) ||
      state.runID !== contract.runID ||
      state.sessionID !== contract.sessionID ||
      state.contractFingerprint !== HarnessContract.fingerprint(contract) ||
      state.protocolSHA256 !== digest(protocol)
    ) {
      throw new Error(`Proof blueprint belongs to a different harness contract`)
    }
    const formal = contract.formalProof!
    const root = state.goals[state.rootGoalID]
    if (
      !root ||
      root.statementSHA256 !== formal.statementSHA256 ||
      root.declaration !== formal.declaration ||
      root.module !== formal.module
    ) {
      throw new Error(`Proof blueprint root does not match the frozen formal statement`)
    }
    if (items(state.goals).length > protocol.maxNodes) throw new Error(`Proof blueprint exceeds its node budget`)
    for (const [id, goal] of Object.entries(state.goals)) {
      if (id !== goal.id || goal.id !== goalID(goal)) throw new Error(`Proof blueprint goal identity is invalid`)
    }
    const adjacency = Object.fromEntries(Object.keys(state.goals).map((id) => [id, new Set<string>()]))
    for (const item of items(state.decompositions)) {
      for (const child of item.childIDs) adjacency[item.parentID]?.add(child)
    }
    const seen = new Set<string>([state.rootGoalID])
    const visit = [state.rootGoalID]
    while (visit.length) {
      const id = visit.shift()!
      for (const child of adjacency[id] ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        visit.push(child)
      }
    }
    if (seen.size !== items(state.goals).length) throw new Error(`Proof blueprint contains unreachable goals`)
    const indegree = Object.fromEntries(Object.keys(state.goals).map((id) => [id, 0]))
    for (const children of Object.values(adjacency)) {
      for (const child of children) indegree[child] = (indegree[child] ?? 0) + 1
    }
    const queue = Object.keys(indegree).filter((id) => indegree[id] === 0)
    const order: string[] = []
    while (queue.length) {
      const id = queue.shift()!
      order.push(id)
      for (const child of adjacency[id] ?? []) {
        indegree[child] = indegree[child]! - 1
        if (indegree[child] === 0) queue.push(child)
      }
    }
    if (order.length !== items(state.goals).length) throw new Error(`Proof blueprint graph must be acyclic`)
    const depth = new Map<string, number>([[state.rootGoalID, 0]])
    for (const id of order) {
      for (const child of adjacency[id] ?? []) {
        depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1))
      }
    }
    if (Math.max(...depth.values()) > protocol.maxDepth) throw new Error(`Proof blueprint exceeds its depth budget`)
    for (const [id, item] of Object.entries(state.decompositions)) {
      if (id !== item.id || item.id !== decompositionID(state, item)) {
        throw new Error(`Proof blueprint decomposition identity is invalid`)
      }
      if (!state.goals[item.parentID] || item.childIDs.some((child) => !state.goals[child])) {
        throw new Error(`Proof blueprint decomposition references an unknown goal`)
      }
      if (
        new Set(item.childIDs).size !== item.childIDs.length ||
        item.childIDs.some((child) => child === item.parentID) ||
        item.childIDs.some((child, index) => Boolean(index) && item.childIDs[index - 1]!.localeCompare(child) >= 0)
      ) {
        throw new Error(`Proof blueprint decomposition children must be unique, canonical, and non-recursive`)
      }
      const attempt = state.attempts[item.attemptID]
      if (!attempt || attempt.result !== "accepted" || attempt.decompositionID !== item.id) {
        throw new Error(`Proof blueprint decomposition lacks its accepted verifier attempt`)
      }
    }
    for (const [id, item] of Object.entries(state.leases)) {
      if (id !== item.id || item.id !== leaseID(state, item))
        throw new Error(`Proof blueprint lease identity is invalid`)
      if (!state.goals[item.goalID] || item.expiresAt <= item.issuedAt) {
        throw new Error(`Proof blueprint lease references an invalid goal or interval`)
      }
      if ((item.status === "consumed") !== Boolean(item.consumedAt)) {
        throw new Error(`Proof blueprint consumed lease provenance is incomplete`)
      }
      if (item.consumedAt && (item.consumedAt < item.issuedAt || item.consumedAt > item.expiresAt)) {
        throw new Error(`Proof blueprint lease consumption falls outside its interval`)
      }
    }
    const leases = items(state.leases).toSorted((a, b) => a.ordinal - b.ordinal)
    if (leases.some((item, index) => item.ordinal !== index)) {
      throw new Error(`Proof blueprint lease history must be complete and contiguous`)
    }
    const open = leases.filter((item) => item.status === "open")
    if (open.length > protocol.maxParallel || new Set(open.map((item) => item.goalID)).size !== open.length) {
      throw new Error(`Proof blueprint open leases violate frozen parallelism or goal exclusivity`)
    }
    const attempts = items(state.attempts).toSorted((a, b) => a.ordinal - b.ordinal)
    if (attempts.some((item, index) => item.ordinal !== index)) {
      throw new Error(`Proof blueprint attempt history must be complete and contiguous`)
    }
    for (const [id, item] of Object.entries(state.attempts)) {
      if (id !== item.id || item.id !== attemptID(state, item)) {
        throw new Error(`Proof blueprint attempt identity is invalid`)
      }
      const lease = state.leases[item.leaseID]
      if (!lease || lease.status !== "consumed" || lease.goalID !== item.goalID) {
        throw new Error(`Proof blueprint attempt lacks its consumed goal lease`)
      }
      if (
        item.startedAt < lease.issuedAt ||
        item.endedAt < item.startedAt ||
        item.endedAt > lease.expiresAt ||
        item.recordedAt < item.endedAt ||
        item.recordedAt !== lease.consumedAt
      ) {
        throw new Error(`Proof blueprint attempt timing does not match its consumed lease`)
      }
    }
    const consumed = leases.filter((item) => item.status === "consumed")
    if (
      consumed.some(
        (lease) =>
          attempts.filter((attempt) => attempt.leaseID === lease.id && attempt.goalID === lease.goalID).length !== 1,
      )
    ) {
      throw new Error(`Every consumed proof blueprint lease must bind exactly one retained attempt`)
    }
    for (const goal of items(state.goals)) {
      if (direct(state, goal.id).length > protocol.maxAttemptsPerGoal) {
        throw new Error(`Proof blueprint goal exceeds its direct-attempt budget`)
      }
      if (sketches(state, goal.id).length > protocol.maxRefinementsPerGoal + 1) {
        throw new Error(`Proof blueprint goal exceeds its refinement budget`)
      }
    }
    statuses(state, protocol)
    return state
  }

  function parse(data: Record<string, unknown>, contract: HarnessContract.Info) {
    const protocol = contract.formalProof?.blueprint
    if (!protocol) throw new Error(`Harness contract does not enable a proof blueprint`)
    return integrity(State.parse(data), contract, protocol)
  }

  function expire(state: State, now: number): State {
    const leases = Object.fromEntries(
      items(state.leases).map((item) => [
        item.id,
        item.status === "open" && item.expiresAt <= now ? { ...item, status: "expired" as const } : item,
      ]),
    )
    if (JSON.stringify(leases) === JSON.stringify(state.leases)) return state
    return { ...state, leases, revision: state.revision + 1, updatedAt: now }
  }

  export function summarize(state: State, protocol: HarnessContract.ProofBlueprint): Summary {
    const parsed = State.parse(state)
    const status = statuses(parsed, protocol).goal
    const goals = items(parsed.goals)
    const attempts = items(parsed.attempts)
    const decomposed = new Set(attempts.filter((item) => item.kind === "decomposition").map((item) => item.goalID)).size
    const refinements = attempts.filter((item) => item.kind === "decomposition").length - decomposed
    return Summary.parse({
      blueprintID: parsed.blueprintID,
      status: status.get(parsed.rootGoalID),
      goals: goals.length,
      proved: goals.filter((item) => status.get(item.id) === "proved").length,
      refuted: goals.filter((item) => status.get(item.id) === "refuted").length,
      exhausted: goals.filter((item) => status.get(item.id) === "exhausted").length,
      decompositions: items(parsed.decompositions).length,
      attempts: attempts.length,
      rejected: attempts.filter((item) => item.result === "rejected" || item.result === "failed").length,
      refinements: Math.max(0, refinements),
      openLeases: items(parsed.leases).filter((item) => item.status === "open" && item.expiresAt > Date.now()).length,
      revision: parsed.revision,
    })
  }

  export function bind(contract: HarnessContract.Info, summary: Summary) {
    const protocol = contract.formalProof?.blueprint
    if (!protocol) throw new Error(`A proof blueprint summary requires a bound blueprint protocol`)
    const parsed = Summary.parse(summary)
    if (parsed.blueprintID !== blueprintID(contract, protocol)) {
      throw new Error(`Proof blueprint summary belongs to a different harness contract`)
    }
    return parsed
  }

  function render(state: State, protocol: HarnessContract.ProofBlueprint): View {
    const status = statuses(state, protocol)
    const available = new Set(ready(state, protocol).map((item) => item.id))
    return View.parse({
      schemaVersion: 1,
      protocolVersion: "proof-blueprint-view-v1",
      runID: state.runID,
      sessionID: state.sessionID,
      rootGoalID: state.rootGoalID,
      summary: summarize(state, protocol),
      goals: items(state.goals)
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map((item) => ({ ...item, status: status.goal.get(item.id), ready: available.has(item.id) })),
      decompositions: items(state.decompositions)
        .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((item) => ({ ...item, status: status.branch.get(item.id) })),
      attempts: items(state.attempts).toSorted((a, b) => a.ordinal - b.ordinal),
      leases: items(state.leases).toSorted((a, b) => a.ordinal - b.ordinal),
    })
  }

  export async function initialize(contract: HarnessContract.Info) {
    const parsed = HarnessContract.Info.parse(contract)
    const protocol = parsed.formalProof?.blueprint
    if (!protocol || !parsed.formalProof) throw new Error(`Harness contract does not enable a proof blueprint`)
    const now = Date.now()
    const spec = GoalSpec.parse({
      statementSHA256: parsed.formalProof.statementSHA256,
      declaration: parsed.formalProof.declaration,
      module: parsed.formalProof.module,
    })
    const id = goalID(spec)
    const expected = State.parse({
      schemaVersion: 1,
      protocolVersion: "proof-blueprint-state-v1",
      blueprintID: blueprintID(parsed, protocol),
      runID: parsed.runID,
      sessionID: parsed.sessionID,
      contractFingerprint: HarnessContract.fingerprint(parsed),
      protocolSHA256: digest(protocol),
      rootGoalID: id,
      goals: { [id]: { id, ...spec, createdAt: now } },
      decompositions: {},
      attempts: {},
      leases: {},
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    await JsonStore.update(file(parsed.sessionID), (data) => {
      if (!Object.keys(data).length) return expected
      return parse(data, parsed)
    })
    return read(parsed.sessionID)
  }

  export async function read(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    const protocol = contract.formalProof?.blueprint
    if (!protocol) throw new Error(`Harness contract does not enable a proof blueprint`)
    return render(parse(await JsonStore.read(file(sessionID)), contract), protocol)
  }

  export async function state(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    return parse(await JsonStore.read(file(sessionID)), contract)
  }

  export async function lease(contract: HarnessContract.Info, count: number) {
    const protocol = contract.formalProof?.blueprint
    if (!protocol) throw new Error(`Harness contract does not enable a proof blueprint`)
    const size = z.number().int().min(1).max(protocol.maxParallel).parse(count)
    const issued: Lease[] = []
    await JsonStore.update(file(contract.sessionID), (data) => {
      const current = expire(parse(data, contract), Date.now())
      const now = Date.now()
      const active = items(current.leases).filter((item) => item.status === "open" && item.expiresAt > now).length
      const choices = ready(current, protocol, now).slice(0, Math.min(size, protocol.maxParallel - active))
      if (!choices.length) return current
      const start = items(current.leases).length
      const additions = choices.map((goal, index) => {
        const draft = {
          goalID: goal.id,
          revision: current.revision,
          ordinal: start + index,
          status: "open" as const,
          issuedAt: now,
          expiresAt: now + protocol.leaseDurationMs,
        }
        return Lease.parse({ id: leaseID(current, draft), ...draft })
      })
      issued.push(...additions)
      return {
        ...current,
        leases: { ...current.leases, ...Object.fromEntries(additions.map((item) => [item.id, item])) },
        revision: current.revision + 1,
        updatedAt: now,
      }
    })
    return { leases: issued, state: await read(contract.sessionID) }
  }

  function timing(value: Submit, lease: Lease, now: number) {
    if (
      value.verification.startedAt < lease.issuedAt ||
      value.verification.endedAt < value.verification.startedAt ||
      value.verification.endedAt > now ||
      value.verification.endedAt > lease.expiresAt
    ) {
      throw new Error(`Proof blueprint verification falls outside its active lease interval`)
    }
  }

  export async function record(value: Submit, contract: HarnessContract.Info) {
    const input = Submit.parse(value)
    if (input.sessionID !== contract.sessionID) throw new Error(`Proof blueprint submission belongs to another session`)
    const protocol = contract.formalProof?.blueprint
    if (!protocol) throw new Error(`Harness contract does not enable a proof blueprint`)
    const out: { attemptID?: string; decompositionID?: string } = {}
    await JsonStore.update(file(contract.sessionID), (data) => {
      const state = parse(data, contract)
      const now = Date.now()
      const lease = state.leases[input.leaseID]
      if (!lease || lease.status !== "open") throw new Error(`Unknown, stale, or consumed proof blueprint lease`)
      if (lease.expiresAt <= now) throw new Error(`Proof blueprint lease has expired`)
      if (input.verification.compilerArtifactSHA256 !== protocol.compilerArtifactSHA256) {
        throw new Error(`Proof blueprint attempt changed its frozen Lean compiler`)
      }
      timing(input, lease, now)
      const status = statuses(state, protocol).goal.get(lease.goalID)
      if (status !== "open") throw new Error(`Proof blueprint goal is no longer open`)
      const history = direct(state, lease.goalID)
      const paths = sketches(state, lease.goalID)
      if (input.kind === "direct" && history.length >= protocol.maxAttemptsPerGoal) {
        throw new Error(`Proof blueprint goal exhausted its direct-attempt budget`)
      }
      if (input.kind === "decomposition" && !history.length) {
        throw new Error(`Proof blueprint requires a direct proof attempt before decomposition`)
      }
      if (input.kind === "decomposition" && paths.length >= protocol.maxRefinementsPerGoal + 1) {
        throw new Error(`Proof blueprint goal exhausted its refinement budget`)
      }
      const accepted =
        input.verification.statementMatched && input.verification.exitCode === 0 && input.verification.warnings === 0
      const failures = [
        ...(!input.verification.statementMatched ? ["compiler did not check the exact leased statement"] : []),
        ...(input.verification.exitCode !== 0 ? ["Lean compiler rejected the artifact"] : []),
        ...(input.verification.warnings ? ["Lean compiler emitted warnings"] : []),
      ]
      const ordinal = items(state.attempts).length
      if (input.kind === "direct") {
        const result =
          !accepted || input.claim === "failure" ? "failed" : input.claim === "proof" ? "proved" : "refuted"
        const draft = Attempt.parse({
          id: "0".repeat(64),
          ordinal,
          goalID: lease.goalID,
          leaseID: lease.id,
          kind: input.kind,
          artifactSHA256: input.artifactSHA256,
          result,
          claim: input.claim,
          transcriptSHA256: input.verification.transcriptSHA256,
          feedbackSHA256: input.verification.feedbackSHA256,
          failures: [...failures, ...(input.claim === "failure" ? ["attempt declared failure"] : [])],
          startedAt: input.verification.startedAt,
          endedAt: input.verification.endedAt,
          recordedAt: now,
        })
        const attempt = Attempt.parse({ ...draft, id: attemptID(state, draft) })
        out.attemptID = attempt.id
        return integrity(
          {
            ...state,
            attempts: { ...state.attempts, [attempt.id]: attempt },
            leases: {
              ...state.leases,
              [lease.id]: { ...lease, status: "consumed", consumedAt: now },
            },
            revision: state.revision + 1,
            updatedAt: now,
          },
          contract,
          protocol,
        )
      }
      if (input.verification.validatorArtifactSHA256 !== protocol.sketchValidatorArtifactSHA256) {
        throw new Error(`Proof blueprint sketch changed its frozen validator`)
      }
      if (
        input.review.reviewerArtifactSHA256 !== protocol.reviewerArtifactSHA256 ||
        input.review.promptSHA256 !== protocol.reviewerPromptSHA256
      ) {
        throw new Error(`Proof blueprint sketch changed its frozen reviewer or rubric`)
      }
      const children = input.children.map((item) => GoalSpec.parse(item))
      const childIDs = children.map(goalID).toSorted()
      if (new Set(childIDs).size !== childIDs.length) throw new Error(`Proof blueprint children must be unique`)
      const placeholders = input.verification.placeholderDeclarations
      const expected = children.map((item) => item.declaration).toSorted((a, b) => a.localeCompare(b))
      if (
        new Set(placeholders).size !== placeholders.length ||
        JSON.stringify(placeholders) !== JSON.stringify(expected)
      ) {
        throw new Error(`Verified sketch placeholders must exactly equal its introduced child declarations`)
      }
      const reviewed = input.review.relevant && input.review.easier && input.review.plausible
      const graph = accepted && reviewed ? graphIssue(state, lease.goalID, childIDs, protocol) : undefined
      const approved = accepted && reviewed && !graph
      const reviewFailures = [
        ...(!input.review.relevant ? ["reviewer rejected decomposition relevance"] : []),
        ...(!input.review.easier ? ["reviewer rejected decomposition difficulty reduction"] : []),
        ...(!input.review.plausible ? ["reviewer rejected decomposition plausibility"] : []),
        ...(graph ? [graph] : []),
      ]
      const attemptBase = {
        ordinal,
        goalID: lease.goalID,
        leaseID: lease.id,
        kind: input.kind,
        artifactSHA256: input.artifactSHA256,
        result: approved ? ("accepted" as const) : ("rejected" as const),
        transcriptSHA256: input.verification.validatorTranscriptSHA256,
        feedbackSHA256: input.verification.feedbackSHA256,
        failures: [...failures, ...reviewFailures],
        startedAt: input.verification.startedAt,
        endedAt: input.verification.endedAt,
        recordedAt: now,
      }
      const branchBase = Decomposition.parse({
        id: "0".repeat(64),
        parentID: lease.goalID,
        childIDs,
        informalPlanSHA256: input.informalPlanSHA256,
        sketchArtifactSHA256: input.artifactSHA256,
        sketchTranscriptSHA256: input.verification.validatorTranscriptSHA256,
        reviewerTranscriptSHA256: input.review.transcriptSHA256,
        attemptID: "0".repeat(64),
        createdAt: now,
      })
      const branchID = approved ? decompositionID(state, branchBase) : undefined
      const draft = Attempt.parse({
        id: "0".repeat(64),
        ...attemptBase,
        ...(branchID ? { decompositionID: branchID } : {}),
      })
      const boundAttempt = Attempt.parse({ ...draft, id: attemptID(state, draft) })
      const complete = branchID
        ? Decomposition.parse({ ...branchBase, id: branchID, attemptID: boundAttempt.id })
        : undefined
      const additions = approved
        ? Object.fromEntries(
            children.map((child) => {
              const id = goalID(child)
              return [id, state.goals[id] ?? Goal.parse({ id, ...child, createdAt: now })]
            }),
          )
        : {}
      out.attemptID = boundAttempt.id
      out.decompositionID = complete?.id
      return integrity(
        {
          ...state,
          goals: { ...state.goals, ...additions },
          decompositions: complete ? { ...state.decompositions, [complete.id]: complete } : state.decompositions,
          attempts: { ...state.attempts, [boundAttempt.id]: boundAttempt },
          leases: { ...state.leases, [lease.id]: { ...lease, status: "consumed", consumedAt: now } },
          revision: state.revision + 1,
          updatedAt: now,
        },
        contract,
        protocol,
      )
    })
    return { ...out, state: await read(contract.sessionID) }
  }

  export function prompt(contract: HarnessContract.Info) {
    if (!contract.formalProof?.blueprint) return ""
    return [
      '<proof-blueprint-policy authority="evaluator" protocol="proof-blueprint-v1">',
      "Use the evaluator-leased AND/OR blueprint for search: try a direct proof first, then propose compiler-checked decompositions whose only placeholders are the introduced child lemmas.",
      "A decomposition is an AND node and closes only when every child is proved; a goal is an OR node and may close through any accepted branch. Shared statement hashes reuse one goal.",
      "Failed attempts and rejected decompositions are durable. Refinement adds alternatives without mutating proved goals or erasing failures.",
      "Reviewer relevance, difficulty, and plausibility are planning heuristics only. Blueprint closure is provisional and never replaces the canonical formal-proof-v1 receipt.",
      "Do not claim compiler, reviewer, lease, or receipt authority in agent output.",
      "</proof-blueprint-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    const protocol = contract?.formalProof?.blueprint
    if (!contract || !protocol) return ""
    const current = await state(sessionID).catch(() => undefined)
    if (!current) return `${prompt(contract)}\nThe evaluator must initialize the blueprint before leasing proof work.`
    const snapshot = render(current, protocol)
    const goals = snapshot.goals.filter((item) => item.ready).slice(0, 8)
    return [
      prompt(contract),
      `Blueprint ${snapshot.summary.status}: ${snapshot.summary.proved}/${snapshot.summary.goals} goals proved, ${snapshot.summary.attempts} attempts, ${snapshot.summary.refinements} refinements.`,
      ...goals.map((item) => `Ready goal ${item.id}: ${item.declaration} in ${item.module}.`),
    ].join("\n")
  }
}
