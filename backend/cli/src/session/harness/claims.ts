import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"

export namespace HarnessClaims {
  export const Kind = z.enum(["descriptive", "statistical", "causal", "mechanistic", "theoretical", "performance"])
  export type Kind = z.infer<typeof Kind>

  export const Status = z.enum(["untested", "provisional", "inconclusive", "supported", "refuted"])
  export type Status = z.infer<typeof Status>

  export const Mode = z.enum([
    "heldout_evaluator",
    "clean_replay",
    "independent_implementation",
    "independent_derivation",
    "adversarial_review",
  ])
  export type Mode = z.infer<typeof Mode>

  const Requirement = z
    .object({
      independentSources: z.number().int().min(1).max(5),
      checks: z
        .array(z.string().min(1).max(100))
        .max(24)
        .refine((items) => new Set(items).size === items.length, "Required checks must be unique"),
    })
    .strict()

  export const Claim = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      text: z.string().min(1).max(4_000),
      kind: Kind,
      importance: z.enum(["supporting", "headline"]),
      subject: z
        .object({
          uri: z.string().min(1).max(2_048),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          provenanceID: z.string().min(1).max(200).optional(),
        })
        .strict(),
      requirements: Requirement,
      createdBy: z
        .object({
          actor: z.string().min(1).max(200),
          sessionID: z.string().min(1),
          messageID: z.string().min(1).optional(),
        })
        .strict(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Claim = z.infer<typeof Claim>

  export const Evidence = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      claimID: z.string().regex(/^[a-f0-9]{64}$/),
      origin: z.enum(["observed", "verified"]),
      stance: z.enum(["supports", "refutes", "inconclusive"]),
      kind: z.enum([
        "observation",
        "measurement",
        "statistical_test",
        "citation",
        "artifact",
        "review",
        "replay",
        "derivation",
        "evaluator",
      ]),
      summary: z.string().min(1).max(2_000),
      source: z
        .object({
          uri: z.string().min(1).max(2_048),
          evaluator: z.string().min(1).max(200).optional(),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          actor: z.string().min(1).max(200),
          sessionID: z.string().min(1),
          runID: z.string().min(1),
          mode: Mode.optional(),
          independenceKey: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
      checks: z.array(HarnessEvaluation.Check).max(64),
      evidence: z.array(z.string().min(1).max(1_000)).max(32),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "Claim evidence may contain at most 128 metrics"),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Evidence = z.infer<typeof Evidence>

  const State = z
    .object({
      schemaVersion: z.literal(1),
      claims: z.record(z.string(), Claim),
      evidence: z.record(z.string(), Evidence),
      revision: z.number().int().nonnegative(),
    })
    .strict()
  export type State = z.infer<typeof State>

  const VerificationBase = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      claimID: z.string().regex(/^[a-f0-9]{64}$/),
      mode: Mode,
      producer: z
        .object({
          actor: z.string().min(1).max(200),
          sessionID: z.string().min(1),
        })
        .strict(),
      verifier: z
        .object({
          actor: z.string().min(1).max(200),
          sessionID: z.string().min(1),
          model: z.string().min(1).max(200).optional(),
          environment: z.string().min(1).max(500).optional(),
        })
        .strict(),
      isolation: z
        .object({
          freshProcess: z.boolean(),
          cleanWorkspace: z.boolean(),
          outputWithheld: z.boolean(),
          codeIndependent: z.boolean(),
          hiddenTestsAccessible: z.literal(false),
        })
        .strict(),
      source: z
        .object({
          uri: z.string().min(1).max(2_048),
          evaluator: z.string().min(1).max(200).optional(),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
      status: HarnessEvaluation.Status,
      summary: z.string().min(1).max(2_000),
      checks: z.array(HarnessEvaluation.Check).min(1).max(64),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "Verification may contain at most 128 metrics"),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()

  const rules: Parameters<typeof VerificationBase.superRefine>[0] = (value, ctx) => {
    if (value.producer.actor === value.verifier.actor) {
      ctx.addIssue({ code: "custom", path: ["verifier", "actor"], message: "Verifier must differ from producer" })
    }
    const clean = ["clean_replay", "independent_implementation", "independent_derivation"].includes(value.mode)
    if (clean && value.producer.sessionID === value.verifier.sessionID) {
      ctx.addIssue({
        code: "custom",
        path: ["verifier", "sessionID"],
        message: "Clean-room verification needs a separate session",
      })
    }
    if (clean && (!value.isolation.freshProcess || !value.isolation.cleanWorkspace)) {
      ctx.addIssue({
        code: "custom",
        path: ["isolation"],
        message: "Clean-room verification needs a fresh process and clean workspace",
      })
    }
    if (clean && !value.source.sha256) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "sha256"],
        message: "Clean-room verification must bind the exact source bytes",
      })
    }
    const independent = ["independent_implementation", "independent_derivation"].includes(value.mode)
    if (independent && (!value.isolation.outputWithheld || !value.isolation.codeIndependent)) {
      ctx.addIssue({
        code: "custom",
        path: ["isolation"],
        message: "Independent verification must withhold outputs and use independent code or derivation",
      })
    }
    if (value.mode === "heldout_evaluator" && !value.isolation.outputWithheld) {
      ctx.addIssue({
        code: "custom",
        path: ["isolation", "outputWithheld"],
        message: "Held-out outputs must remain withheld",
      })
    }
    if (value.status !== "passed") return
    const failed = value.checks.find((check) => check.blocking && check.status !== "passed")
    if (!failed) return
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: `A passed verification cannot contain a non-passing blocking check: ${failed.id}`,
    })
  }

  export const VerificationInfo = VerificationBase.superRefine(rules)
  export type VerificationInfo = z.infer<typeof VerificationInfo>

  export const Verification = VerificationBase.extend({ id: z.string().regex(/^[a-f0-9]{64}$/) }).superRefine(rules)
  export type Verification = z.infer<typeof Verification>

  export type View = Claim & {
    status: Status
    evidence: Evidence[]
    independentSources: number
    passedChecks: string[]
    missingChecks: string[]
  }

  const root = path.join(Global.Path.data, "harness", "claims")
  const verifications = path.join(Global.Path.data, "harness", "verifications")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const folder = (sessionID: string) => path.join(verifications, encodeURIComponent(sessionID))
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const empty = (): State => ({ schemaVersion: 1, claims: {}, evidence: {}, revision: 0 })

  const defaults: Record<Kind, z.infer<typeof Requirement>> = {
    descriptive: { independentSources: 1, checks: [] },
    statistical: { independentSources: 1, checks: ["estimand", "assumptions", "multiplicity"] },
    causal: { independentSources: 2, checks: ["identification", "confounding", "sensitivity"] },
    mechanistic: { independentSources: 2, checks: ["alternative-explanation", "intervention"] },
    theoretical: { independentSources: 2, checks: ["assumptions", "limiting-case", "independent-derivation"] },
    performance: { independentSources: 1, checks: ["held-out", "baseline", "budget"] },
  }

  async function read(sessionID: string) {
    const data = await JsonStore.read(file(sessionID))
    const parsed = State.safeParse(data)
    return parsed.success ? parsed.data : empty()
  }

  function derive(claim: Claim, items: Evidence[]) {
    const verified = items.filter((item) => item.origin === "verified")
    if (verified.some((item) => item.stance === "refutes")) return "refuted" as const
    const supports = verified.filter((item) => item.stance === "supports")
    const sources = new Set(
      supports.flatMap((item) => (item.source.independenceKey ? [item.source.independenceKey] : [])),
    )
    const checks = new Set(
      supports.flatMap((item) => item.checks.filter((check) => check.status === "passed").map((check) => check.id)),
    )
    const complete = claim.requirements.checks.every((check) => checks.has(check))
    if (sources.size >= claim.requirements.independentSources && complete) return "supported" as const
    if (verified.length) return "inconclusive" as const
    if (items.length) return "provisional" as const
    return "untested" as const
  }

  export async function declare(input: {
    sessionID: string
    actor: string
    messageID?: string
    text: string
    kind: Kind
    importance: "supporting" | "headline"
    subject: Claim["subject"]
    requirements?: { independentSources?: number; checks?: string[] }
  }) {
    const contract = await HarnessContract.read(input.sessionID)
    if (input.kind === "performance" && input.importance === "headline" && !input.subject.sha256) {
      throw new Error(`A headline performance claim must bind an immutable subject SHA-256`)
    }
    const runID = contract?.runID ?? `session:${input.sessionID}`
    const base = defaults[input.kind]
    const requirements = Requirement.parse({
      independentSources: Math.max(base.independentSources, input.requirements?.independentSources ?? 1),
      checks: [...new Set([...base.checks, ...(input.requirements?.checks ?? [])])],
    })
    const id = digest({ runID, text: input.text, kind: input.kind, subject: input.subject })
    const claim = Claim.parse({
      id,
      runID,
      sessionID: input.sessionID,
      text: input.text,
      kind: input.kind,
      importance: input.importance,
      subject: input.subject,
      requirements,
      createdBy: { actor: input.actor, sessionID: input.sessionID, messageID: input.messageID },
      createdAt: Date.now(),
    })
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = Object.keys(data).length ? State.parse(data) : empty()
      if (state.claims[id]) return state
      return { ...state, claims: { ...state.claims, [id]: claim }, revision: state.revision + 1 }
    })
    return (await read(input.sessionID)).claims[id]!
  }

  export async function observe(input: {
    sessionID: string
    claimID: string
    actor: string
    kind: Evidence["kind"]
    stance: Evidence["stance"]
    summary: string
    source: { uri: string; sha256?: string }
    evidence?: string[]
    metrics?: Record<string, number>
  }) {
    const state = await read(input.sessionID)
    const claim = state.claims[input.claimID]
    if (!claim) throw new Error(`Unknown claim ${input.claimID}`)
    const id = digest({
      claimID: claim.id,
      actor: input.actor,
      kind: input.kind,
      summary: input.summary,
      source: input.source,
    })
    const item = Evidence.parse({
      id,
      claimID: claim.id,
      origin: "observed",
      stance: input.stance,
      kind: input.kind,
      summary: input.summary,
      source: {
        ...input.source,
        actor: input.actor,
        sessionID: input.sessionID,
        runID: claim.runID,
      },
      checks: [],
      evidence: input.evidence ?? [],
      metrics: input.metrics ?? {},
      createdAt: Date.now(),
    })
    await JsonStore.update(file(input.sessionID), (data) => {
      const current = State.parse(data)
      if (current.evidence[id]) return current
      return { ...current, evidence: { ...current.evidence, [id]: item }, revision: current.revision + 1 }
    })
    return item
  }

  function view(state: State, claim: Claim): View {
    const items = Object.values(state.evidence)
      .filter((item) => item.claimID === claim.id)
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const supports = items.filter((item) => item.origin === "verified" && item.stance === "supports")
    const sources = new Set(
      supports.flatMap((item) => (item.source.independenceKey ? [item.source.independenceKey] : [])),
    )
    const passed = new Set(
      supports.flatMap((item) => item.checks.filter((check) => check.status === "passed").map((check) => check.id)),
    )
    return {
      ...claim,
      status: derive(claim, items),
      evidence: items,
      independentSources: sources.size,
      passedChecks: [...passed].toSorted(),
      missingChecks: claim.requirements.checks.filter((check) => !passed.has(check)),
    }
  }

  export async function get(sessionID: string, claimID: string) {
    const state = await read(sessionID)
    const claim = state.claims[claimID]
    return claim ? view(state, claim) : null
  }

  export async function list(sessionID: string) {
    const state = await read(sessionID)
    return Object.values(state.claims)
      .map((claim) => view(state, claim))
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  export async function stage(input: VerificationInfo) {
    const parsed = VerificationInfo.parse(input)
    const state = await read(input.sessionID)
    const claim = state.claims[input.claimID]
    if (!claim) throw new Error(`Unknown claim ${input.claimID}`)
    if (parsed.runID !== claim.runID || parsed.sessionID !== claim.sessionID) {
      throw new Error(`Verification belongs to a different claim run`)
    }
    if (parsed.producer.actor !== claim.createdBy.actor || parsed.producer.sessionID !== claim.createdBy.sessionID) {
      throw new Error(`Verification does not identify the claim producer`)
    }
    if (parsed.mode === "heldout_evaluator") {
      const contract = await HarnessContract.read(input.sessionID)
      if (!contract || parsed.source.evaluator !== contract.benchmark.evaluator) {
        throw new Error(`Held-out verification does not match the bound benchmark evaluator`)
      }
    }
    const id = digest(parsed)
    const verification = Verification.parse({ ...parsed, id })
    await JsonStore.update(path.join(folder(input.sessionID), `${id}.json`), (data) => {
      if (!Object.keys(data).length) return verification
      const current = Verification.parse(data)
      if (current.id === id) return current
      throw new Error(`Verification ${id} is immutable`)
    })
    return verification
  }

  function kind(mode: Mode): Evidence["kind"] {
    if (mode === "heldout_evaluator") return "evaluator"
    if (mode === "clean_replay" || mode === "independent_implementation") return "replay"
    if (mode === "independent_derivation") return "derivation"
    return "review"
  }

  export async function reconcile(sessionID: string) {
    const names = await fs.readdir(folder(sessionID)).catch(() => [])
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          Bun.file(path.join(folder(sessionID), name))
            .json()
            .then((value) => Verification.parse(value)),
        ),
    )
    await JsonStore.update(file(sessionID), (data) => {
      const state = Object.keys(data).length ? State.parse(data) : empty()
      const additions = records.flatMap((record) => {
        const claim = state.claims[record.claimID]
        if (!claim || state.evidence[record.id]) return []
        if (record.runID !== claim.runID || record.sessionID !== claim.sessionID) {
          throw new Error(`Verification ${record.id} belongs to a different claim run`)
        }
        if (
          record.producer.actor !== claim.createdBy.actor ||
          record.producer.sessionID !== claim.createdBy.sessionID
        ) {
          throw new Error(`Verification ${record.id} does not identify the claim producer`)
        }
        const stance =
          record.status === "passed"
            ? ("supports" as const)
            : record.status === "failed"
              ? ("refutes" as const)
              : ("inconclusive" as const)
        return [
          Evidence.parse({
            id: record.id,
            claimID: claim.id,
            origin: "verified",
            stance,
            kind: kind(record.mode),
            summary: record.summary,
            source: {
              uri: record.source.uri,
              evaluator: record.source.evaluator,
              sha256: record.source.sha256,
              actor: record.verifier.actor,
              sessionID: record.verifier.sessionID,
              runID: record.runID,
              mode: record.mode,
              independenceKey: digest({ actor: record.verifier.actor, sessionID: record.verifier.sessionID }),
            },
            checks: record.checks,
            evidence: record.evidence,
            metrics: record.metrics,
            createdAt: record.evaluatedAt,
          }),
        ]
      })
      if (!additions.length) return state
      return {
        ...state,
        evidence: { ...state.evidence, ...Object.fromEntries(additions.map((item) => [item.id, item])) },
        revision: state.revision + additions.length,
      }
    })
    return list(sessionID)
  }

  export async function verify(input: VerificationInfo) {
    const verification = await stage(input)
    await reconcile(input.sessionID)
    return { verification, claim: await get(input.sessionID, input.claimID) }
  }

  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

  export async function prompt(sessionID: string) {
    const claims = (await list(sessionID)).filter((claim) => claim.status !== "supported")
    if (!claims.length) return ""
    const lines = [
      '<claim-ledger trust="derived-status">',
      "Claim status is computed from backend verification. Observations never count as support.",
    ]
    for (const claim of claims.slice(0, 12)) {
      const block = [
        `<claim id="${claim.id}" kind="${claim.kind}" status="${claim.status}" importance="${claim.importance}">`,
        escape(claim.text).slice(0, 800),
        `Independent sources: ${claim.independentSources}/${claim.requirements.independentSources}`,
        `Missing checks: ${escape(claim.missingChecks.join(", ") || "none")}`,
        "</claim>",
      ]
      if ([...lines, ...block, "</claim-ledger>"].join("\n").length > 3_500) break
      lines.push(...block)
    }
    lines.push("</claim-ledger>")
    return lines.join("\n")
  }
}
