import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessWorld {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Key = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/)

  export const Kind = z.enum(["hypothesis", "observation", "strategy", "memory", "skill", "subagent"])
  export type Kind = z.infer<typeof Kind>

  export const Authority = z.enum(["self", "tool", "evaluator", "human"])
  export type Authority = z.infer<typeof Authority>

  export const Evidence = z
    .object({
      ref: z.string().min(1).max(1_000),
      authority: Authority,
    })
    .strict()
  export type Evidence = z.infer<typeof Evidence>

  export const Entry = z
    .object({
      id: Hash,
      key: Key,
      kind: Kind,
      content: z.string().min(1).max(4_000),
      confidence: z.number().int().min(1).max(5),
      evidence: z
        .array(Evidence)
        .max(16)
        .refine(
          (items) => new Set(items.map((item) => `${item.authority}:\0${item.ref}`)).size === items.length,
          "World-model evidence references must be unique",
        ),
      updatedAt: z.number().int().positive(),
      revision: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const independent = value.evidence.filter((item) => item.authority !== "self")
      if (value.confidence >= 4 && !independent.length) {
        ctx.addIssue({
          code: "custom",
          path: ["confidence"],
          message: "Confidence 4 or 5 requires evidence beyond self-report",
        })
      }
      if (
        value.confidence === 5 &&
        (independent.length < 2 || !independent.some((item) => ["evaluator", "human"].includes(item.authority)))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["confidence"],
          message: "Confidence 5 requires two non-self references including evaluator or human evidence",
        })
      }
    })
  export type Entry = z.infer<typeof Entry>

  export const EventType = z.enum(["analysis", "tool", "evaluation", "failure", "milestone", "stagnation", "manual"])
  export type EventType = z.infer<typeof EventType>

  export const Event = z
    .object({
      id: Hash,
      type: EventType,
      summary: z.string().min(1).max(1_000),
      evidenceRefs: z.array(z.string().min(1).max(1_000)).max(16),
      changed: z.boolean(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Event = z.infer<typeof Event>

  export const Reason = z.enum(["manual", "failure", "stagnation", "milestone", "periodic"])
  export type Reason = z.infer<typeof Reason>

  export const Patch = z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("upsert"),
        key: Key,
        kind: Kind,
        content: z.string().min(1).max(4_000),
        confidence: z.number().int().min(1).max(5),
        evidence: z.array(Evidence).max(16).default([]),
      })
      .strict(),
    z
      .object({
        op: z.literal("remove"),
        key: Key,
      })
      .strict(),
  ])
  export type Patch = z.infer<typeof Patch>

  export const AgentPatch = z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("upsert"),
        key: Key,
        kind: Kind,
        content: z.string().min(1).max(4_000),
        confidence: z.number().int().min(1).max(3),
        evidenceRefs: z.array(z.string().min(1).max(1_000)).max(16).default([]),
      })
      .strict(),
    z
      .object({
        op: z.literal("remove"),
        key: Key,
      })
      .strict(),
  ])
  export type AgentPatch = z.infer<typeof AgentPatch>

  export const EvaluatorPatch = z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("upsert"),
        key: Key,
        kind: Kind,
        content: z.string().min(1).max(4_000),
        confidence: z.number().int().min(1).max(5),
        evidenceRefs: z.array(z.string().min(1).max(1_000)).max(16).default([]),
      })
      .strict(),
    z
      .object({
        op: z.literal("remove"),
        key: Key,
      })
      .strict(),
  ])

  export const EvaluatorRefine = z
    .object({
      evaluatorToken: z.string().min(32).max(1_024),
      expectedRevision: z.number().int().nonnegative(),
      reason: Reason,
      patches: z.array(EvaluatorPatch).min(1).max(6),
    })
    .strict()
  export type EvaluatorRefine = z.infer<typeof EvaluatorRefine>

  const Snapshot = z
    .object({
      revision: z.number().int().nonnegative(),
      entries: z.record(z.string(), Entry),
      sha256: Hash,
      createdAt: z.number().int().positive(),
    })
    .strict()

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      sessionID: z.string().min(1),
      runID: z.string().min(1),
      basePromptSHA256: Hash,
      entries: z.record(z.string(), Entry),
      events: z.array(Event).max(128),
      snapshots: z.array(Snapshot).max(10),
      revision: z.number().int().nonnegative(),
      contextEpoch: z.number().int().nonnegative(),
      eventsSinceRefine: z.number().int().nonnegative(),
      refinement: z
        .object({
          recommended: z.boolean(),
          trigger: Reason.optional(),
        })
        .strict(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
  export type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "worlds")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
  const canonical = (value: unknown) => JSON.stringify(value)
  const clip = (value: string, max = 1_000) =>
    value
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ")
      .trim()
      .slice(0, max)
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
  const promptHash = (contract: HarnessContract.Info) =>
    digest(
      canonical({
        contract: HarnessContract.fingerprint(contract),
        objective: contract.objective,
        task: contract.benchmark.task,
      }),
    )

  function empty(contract: HarnessContract.Info): State {
    const now = Date.now()
    return {
      schemaVersion: 1,
      sessionID: contract.sessionID,
      runID: contract.runID,
      basePromptSHA256: promptHash(contract),
      entries: {},
      events: [],
      snapshots: [],
      revision: 0,
      contextEpoch: 0,
      eventsSinceRefine: 0,
      refinement: { recommended: false },
      createdAt: now,
      updatedAt: now,
    }
  }

  function verify(state: State, contract: HarnessContract.Info) {
    if (state.runID !== contract.runID || state.basePromptSHA256 !== promptHash(contract)) {
      throw new Error("Continual world model does not match the immutable harness contract")
    }
    return state
  }

  export async function read(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${sessionID}`)
    const data = await JsonStore.read(file(sessionID))
    const parsed = State.safeParse(data)
    if (parsed.success) return verify(parsed.data, contract)
    const state = empty(contract)
    await JsonStore.update(file(sessionID), (current) => (Object.keys(current).length ? State.parse(current) : state))
    return state
  }

  export function summary(state: State) {
    return {
      runID: state.runID,
      basePromptSHA256: state.basePromptSHA256,
      revision: state.revision,
      contextEpoch: state.contextEpoch,
      eventsSinceRefine: state.eventsSinceRefine,
      refinement: state.refinement,
      entries: Object.values(state.entries)
        .toSorted((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
        .map((entry) => ({
          key: entry.key,
          kind: entry.kind,
          content: entry.content,
          confidence: entry.confidence,
          evidence: entry.evidence,
          revision: entry.revision,
        })),
      recentEvents: state.events.slice(-12),
      rollbackRevisions: state.snapshots.map((item) => item.revision).toReversed(),
    }
  }

  export async function event(input: {
    sessionID: string
    type: EventType
    summary: string
    evidenceRefs?: string[]
    changed?: boolean
  }) {
    const current = await read(input.sessionID)
    const changed = input.changed ?? input.type !== "analysis"
    if (input.type === "analysis" && changed) throw new Error("Analysis events cannot advance the context epoch")
    const createdAt = Date.now()
    const item = Event.parse({
      id: digest(
        canonical({
          sessionID: input.sessionID,
          type: input.type,
          summary: input.summary,
          evidenceRefs: input.evidenceRefs ?? [],
          createdAt,
          revision: current.revision,
        }),
      ),
      type: input.type,
      summary: clip(input.summary),
      evidenceRefs: input.evidenceRefs ?? [],
      changed,
      createdAt,
    })
    const urgent = ["failure", "stagnation", "milestone", "manual"].includes(item.type)
    const count = current.eventsSinceRefine + 1
    const periodic = count >= 6
    const trigger =
      current.refinement.trigger ?? (urgent ? Reason.parse(item.type) : periodic ? ("periodic" as const) : undefined)
    const next = State.parse({
      ...current,
      events: [...current.events, item].slice(-128),
      revision: current.revision + 1,
      contextEpoch: current.contextEpoch + (changed ? 1 : 0),
      eventsSinceRefine: count,
      refinement: { recommended: Boolean(trigger), trigger },
      updatedAt: createdAt,
    })
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = State.parse(data)
      if (state.revision !== current.revision) {
        throw new Error("Continual world model changed while recording an event")
      }
      return next
    })
    return next
  }

  export async function refine(input: {
    sessionID: string
    expectedRevision: number
    reason: Reason
    patches: Patch[]
    actor: "agent" | "evaluator"
  }) {
    const patches = z.array(Patch).min(1).max(6).parse(input.patches)
    const content = patches.reduce((total, patch) => total + (patch.op === "upsert" ? patch.content.length : 0), 0)
    if (content > 12_000) throw new Error("A refinement may add at most 12,000 characters")
    if (
      input.actor === "agent" &&
      patches.some((patch) => patch.op === "upsert" && patch.evidence.some((item) => item.authority !== "self"))
    ) {
      throw new Error("Agent refinements may only record self-attributed evidence")
    }
    const current = await read(input.sessionID)
    if (current.revision !== input.expectedRevision) {
      throw new Error(`Expected world-model revision ${input.expectedRevision}, found ${current.revision}`)
    }
    const revision = current.revision + 1
    const updatedAt = Date.now()
    const entries = patches.reduce<Record<string, Entry>>((items, patch) => {
      if (patch.op === "remove") {
        if (!items[patch.key]) throw new Error(`Cannot remove unknown world-model entry ${patch.key}`)
        return Object.fromEntries(Object.entries(items).filter(([key]) => key !== patch.key))
      }
      const entry = Entry.parse({
        id: digest(`${input.sessionID}\0${patch.key}`),
        key: patch.key,
        kind: patch.kind,
        content: clip(patch.content, 4_000),
        confidence: patch.confidence,
        evidence: patch.evidence,
        updatedAt,
        revision,
      })
      return { ...items, [patch.key]: entry }
    }, current.entries)
    if (Object.keys(entries).length > 48) throw new Error("A continual world model may contain at most 48 entries")
    const snapshot = Snapshot.parse({
      revision: current.revision,
      entries: current.entries,
      sha256: digest(canonical(current.entries)),
      createdAt: updatedAt,
    })
    const event = Event.parse({
      id: digest(
        canonical({
          sessionID: input.sessionID,
          reason: input.reason,
          patches,
          updatedAt,
          revision,
        }),
      ),
      type: input.reason === "periodic" ? "manual" : input.reason,
      summary: `Applied ${input.reason} world-model refinement with ${patches.length} patch(es)`,
      evidenceRefs: [
        ...new Set(patches.flatMap((patch) => (patch.op === "upsert" ? patch.evidence.map((item) => item.ref) : []))),
      ].slice(0, 16),
      changed: true,
      createdAt: updatedAt,
    })
    const next = State.parse({
      ...current,
      entries,
      events: [...current.events, event].slice(-128),
      snapshots: [...current.snapshots, snapshot].slice(-10),
      revision,
      contextEpoch: current.contextEpoch + 1,
      eventsSinceRefine: 0,
      refinement: { recommended: false },
      updatedAt,
    })
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = State.parse(data)
      if (state.revision !== current.revision) {
        throw new Error("Continual world model changed while applying a refinement")
      }
      return next
    })
    return next
  }

  export async function agentRefine(input: {
    sessionID: string
    expectedRevision: number
    reason: Reason
    patches: AgentPatch[]
  }) {
    const patches = z
      .array(AgentPatch)
      .min(1)
      .max(6)
      .parse(input.patches)
      .map(
        (patch): Patch =>
          patch.op === "remove"
            ? patch
            : {
                op: "upsert",
                key: patch.key,
                kind: patch.kind,
                content: patch.content,
                confidence: patch.confidence,
                evidence: patch.evidenceRefs.map((ref) => ({ ref, authority: "self" as const })),
              },
      )
    return refine({ ...input, patches, actor: "agent" })
  }

  export async function evaluatorRefine(input: {
    sessionID: string
    expectedRevision: number
    reason: Reason
    patches: z.infer<typeof EvaluatorPatch>[]
  }) {
    const patches = z
      .array(EvaluatorPatch)
      .min(1)
      .max(6)
      .parse(input.patches)
      .map(
        (patch): Patch =>
          patch.op === "remove"
            ? patch
            : {
                op: "upsert",
                key: patch.key,
                kind: patch.kind,
                content: patch.content,
                confidence: patch.confidence,
                evidence: patch.evidenceRefs.map((ref) => ({ ref, authority: "evaluator" as const })),
              },
      )
    return refine({ ...input, patches, actor: "evaluator" })
  }

  export async function rollback(input: { sessionID: string; expectedRevision: number; targetRevision?: number }) {
    const current = await read(input.sessionID)
    if (current.revision !== input.expectedRevision) {
      throw new Error(`Expected world-model revision ${input.expectedRevision}, found ${current.revision}`)
    }
    const target =
      input.targetRevision === undefined
        ? current.snapshots.at(-1)
        : current.snapshots.findLast((item) => item.revision === input.targetRevision)
    if (!target) throw new Error("No matching world-model snapshot is available for rollback")
    if (digest(canonical(target.entries)) !== target.sha256) throw new Error("World-model rollback snapshot is corrupt")
    const updatedAt = Date.now()
    const snapshot = Snapshot.parse({
      revision: current.revision,
      entries: current.entries,
      sha256: digest(canonical(current.entries)),
      createdAt: updatedAt,
    })
    const next = State.parse({
      ...current,
      entries: target.entries,
      snapshots: [...current.snapshots, snapshot].slice(-10),
      revision: current.revision + 1,
      contextEpoch: current.contextEpoch + 1,
      eventsSinceRefine: 0,
      refinement: { recommended: false },
      updatedAt,
    })
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = State.parse(data)
      if (state.revision !== current.revision) {
        throw new Error("Continual world model changed while applying a rollback")
      }
      return next
    })
    return next
  }

  export async function prompt(sessionID: string) {
    const state = await read(sessionID)
    const entries = Object.values(state.entries).toSorted(
      (a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
    )
    if (!entries.length) return ""
    const lines = [
      `<continual-world-model base-prompt="immutable" context-epoch="${state.contextEpoch}" revision="${state.revision}">`,
      "Session-local mutable working state. Confidence is provenance-gated; self-authored entries are tentative and must not override external evidence.",
    ]
    for (const entry of entries) {
      const evidence = entry.evidence
        .slice(0, 4)
        .map((item) => `${item.authority}:${escape(item.ref).slice(0, 180)}`)
        .join(", ")
      const block = [
        `<entry key="${entry.key}" kind="${entry.kind}" confidence="${entry.confidence}">`,
        escape(entry.content).slice(0, 1_000),
        `Evidence: ${evidence || "self-report only"}`,
        "</entry>",
      ]
      if ([...lines, ...block, "</continual-world-model>"].join("\n").length > 4_500) break
      lines.push(...block)
    }
    lines.push("</continual-world-model>")
    return lines.join("\n")
  }
}
