import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { runtimeRegexPass, classifierInjectionRegexPass, suspiciousRegexPass } from "@/skill/install/review"
import { JsonStore } from "@/util/jsonstore"
import { HarnessAdapter } from "./adapter"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"

export namespace HarnessSkill {
  const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  const SHA = z.string().regex(/^[a-f0-9]{64}$/)

  export const ProposalInput = z
    .object({
      name: Name,
      description: z.string().min(1).max(500),
      content: z.string().min(1).max(64_000),
      origin: z.enum(["conversation", "rsi"]),
      sessionID: z.string().min(1).optional(),
      runID: z.string().min(1).optional(),
      createdAt: z.number().int().positive().optional(),
    })
    .strict()
  export type ProposalInput = z.input<typeof ProposalInput>
  type Proposal = z.output<typeof ProposalInput>

  export const Trigger = z
    .object({
      datasetSHA256: SHA,
      split: z.literal("held_out"),
      examples: z.number().int().min(20),
      truePositive: z.number().int().nonnegative(),
      falsePositive: z.number().int().nonnegative(),
      trueNegative: z.number().int().nonnegative(),
      falseNegative: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const total = value.truePositive + value.falsePositive + value.trueNegative + value.falseNegative
      if (total !== value.examples) {
        ctx.addIssue({ code: "custom", path: ["examples"], message: "Trigger confusion counts must sum to examples" })
      }
      if (!value.truePositive && !value.falseNegative) {
        ctx.addIssue({ code: "custom", path: ["truePositive"], message: "Trigger evaluation needs positive examples" })
      }
      if (!value.trueNegative && !value.falsePositive) {
        ctx.addIssue({ code: "custom", path: ["trueNegative"], message: "Trigger evaluation needs negative examples" })
      }
    })
  export type Trigger = z.infer<typeof Trigger>

  export const Evidence = z
    .object({
      id: SHA,
      proposalSHA256: SHA,
      benchmark: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          taskID: z.string().min(1),
          split: z.enum(["held_out", "release"]),
          metric: z.string().optional(),
          direction: z.enum(["maximize", "minimize", "pass"]),
        })
        .strict(),
      candidate: z
        .object({
          sessionID: z.string().min(1),
          runID: z.string().min(1),
          status: HarnessEvaluation.Status,
          score: z.number().finite().optional(),
          evaluationSHA256: SHA,
        })
        .strict(),
      control: z
        .object({
          sessionID: z.string().min(1),
          runID: z.string().min(1),
          status: HarnessEvaluation.Status,
          score: z.number().finite().optional(),
          evaluationSHA256: SHA,
        })
        .strict(),
      nonregressing: z.boolean(),
      improved: z.boolean(),
      trigger: Trigger.safeExtend({
        precision: z.number().min(0).max(1),
        recall: z.number().min(0).max(1),
      }),
      evaluator: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Evidence = z.infer<typeof Evidence>

  export const Manifest = z
    .object({
      schemaVersion: z.literal(1),
      name: Name,
      description: z.string().min(1).max(500),
      contentSHA256: SHA,
      origin: z.enum(["conversation", "rsi"]),
      source: z.object({ sessionID: z.string().min(1).optional(), runID: z.string().min(1).optional() }).strict(),
      status: z.enum(["pending", "qualified", "promoted", "rejected"]),
      evidence: z.array(Evidence).max(100),
      criteria: z
        .object({
          tasks: z.literal(3),
          improvements: z.literal(2),
          triggerPrecision: z.literal(0.8),
          triggerRecall: z.literal(0.8),
        })
        .strict(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
      promotedAt: z.number().int().positive().optional(),
    })
    .strict()
  export type Manifest = z.infer<typeof Manifest>

  export const Attestation = z
    .object({
      name: Name,
      candidate: z.object({ sessionID: z.string().min(1), evaluatorToken: z.string().min(32).max(1_024) }).strict(),
      control: z.object({ sessionID: z.string().min(1), evaluatorToken: z.string().min(32).max(1_024) }).strict(),
      trigger: Trigger,
      recordedAt: z.number().int().positive().optional(),
    })
    .strict()
  export type Attestation = z.input<typeof Attestation>

  const proposals = path.join(Global.Path.data, "learned-skill-proposals")
  const active = path.join(Global.Path.data, "learned-skills")
  const dir = (name: string) => path.join(proposals, name)
  const manifest = (name: string) => path.join(dir(name), "manifest.json")
  const skill = (name: string) => path.join(dir(name), "SKILL.md")
  const digest = (input: string) => new Bun.CryptoHasher("sha256").update(input).digest("hex")

  function frontmatter(input: Proposal) {
    const header = input.content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!header) throw new Error(`Learned skill proposals require YAML frontmatter`)
    const name = header[1]!
      .match(/^name:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "")
    const description = header[1]!
      .match(/^description:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "")
    if (name !== input.name) throw new Error(`Skill frontmatter name must match ${input.name}`)
    if (description !== input.description) throw new Error(`Skill frontmatter description must match the proposal`)
  }

  function review(input: Proposal) {
    const entry = {
      namespace: "learned",
      name: input.name,
      description: input.description,
      content: input.content,
      scripts: [],
      references: [],
    }
    const rejected = [...runtimeRegexPass([entry]).rejected, ...classifierInjectionRegexPass([entry]).rejected]
    if (rejected.length) throw new Error(`Learned skill rejected: ${rejected.map((item) => item.reason).join(", ")}`)
    const warnings = suspiciousRegexPass([entry]).warnings
    if (warnings.length) throw new Error(`Learned skill requires manual review: ${warnings[0]!.pattern}`)
  }

  export async function propose(input: ProposalInput) {
    const value = ProposalInput.parse(input)
    frontmatter(value)
    review(value)
    const sha = digest(value.content)
    const now = Date.now()
    const proposal = Manifest.parse({
      schemaVersion: 1,
      name: value.name,
      description: value.description,
      contentSHA256: sha,
      origin: value.origin,
      source: { sessionID: value.sessionID, runID: value.runID },
      status: "pending",
      evidence: [],
      criteria: { tasks: 3, improvements: 2, triggerPrecision: 0.8, triggerRecall: 0.8 },
      createdAt: value.createdAt ?? now,
      updatedAt: now,
    })
    await fs.mkdir(dir(value.name), { recursive: true })
    await JsonStore.update(manifest(value.name), (data) => {
      if (!Object.keys(data).length) return proposal
      const current = Manifest.parse(data)
      if (current.contentSHA256 === sha) return current
      throw new Error(`Skill proposal ${value.name} is immutable; use a new versioned name`)
    })
    const exists = await Bun.file(skill(value.name)).exists()
    if (exists && digest(await Bun.file(skill(value.name)).text()) !== sha) {
      throw new Error(`Skill proposal content does not match its immutable manifest`)
    }
    if (!exists) await Bun.write(skill(value.name), value.content, { mode: 0o600 })
    return read(value.name)
  }

  export async function read(name: string) {
    const data = await JsonStore.read(manifest(Name.parse(name)))
    const parsed = Manifest.safeParse(data)
    return parsed.success ? parsed.data : null
  }

  export async function list() {
    const names = await fs.readdir(proposals).catch(() => [])
    const items = await Promise.all(names.map((name) => read(name).catch(() => null)))
    return items.filter((item): item is Manifest => item !== null).toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  export function assess(input: Evidence[]) {
    const evidence = input.map((item) => Evidence.parse(item))
    const task = (item: Evidence) => `${item.benchmark.name}\0${item.benchmark.version}\0${item.benchmark.taskID}`
    const tasks = new Set(evidence.map(task)).size
    const improvements = new Set(evidence.filter((item) => item.improved).map(task)).size
    const regressions = evidence.filter((item) => !item.nonregressing).length
    const failures = evidence.filter((item) => item.candidate.status !== "passed").length
    const triggerFailures = evidence.filter((item) => item.trigger.precision < 0.8 || item.trigger.recall < 0.8).length
    const triggers = new Set(
      evidence
        .filter((item) => item.trigger.precision >= 0.8 && item.trigger.recall >= 0.8)
        .map((item) => item.trigger.datasetSHA256),
    ).size
    return {
      qualified: tasks >= 3 && improvements >= 2 && !regressions && !failures && !triggerFailures && triggers >= 1,
      tasks,
      improvements,
      regressions,
      failures,
      triggerFailures,
      triggerDatasets: triggers,
    }
  }

  function comparable(input: { proposal: Manifest; candidate: HarnessContract.Info; control: HarnessContract.Info }) {
    const match = input.candidate.skills.filter(
      (item) => item.name === input.proposal.name && item.sha256 === input.proposal.contentSHA256,
    )
    if (match.length !== 1) throw new Error(`Candidate contract must pin the exact proposed skill SHA`)
    if (input.control.skills.some((item) => item.name === input.proposal.name)) {
      throw new Error(`Control contract must not contain the proposed skill`)
    }
    const strip = (contract: HarnessContract.Info) => ({
      objective: contract.objective,
      benchmark: contract.benchmark,
      profile: contract.profile,
      orchestration: contract.orchestration,
      search: contract.search,
      audit: contract.audit,
      launch: contract.launch,
      recipe: contract.recipe,
      integrity: contract.integrity,
      evolution: contract.evolution,
      interventions: contract.interventions,
      simulation: contract.simulation,
      evaluatorAudit: contract.evaluatorAudit,
      semanticAudit: contract.semanticAudit,
      packs: contract.packs ?? [],
      model: contract.model,
      tools: contract.tools.toSorted(),
      skills: contract.skills
        .filter((item) => item.name !== input.proposal.name)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
      budget: contract.budget,
      seed: contract.seed,
      intervention: contract.intervention,
      contamination: contract.contamination,
    })
    if (JSON.stringify(strip(input.candidate)) !== JSON.stringify(strip(input.control))) {
      throw new Error(`Skill candidate and control contracts differ outside the proposed skill`)
    }
    if (input.candidate.sessionID === input.control.sessionID || input.candidate.runID === input.control.runID) {
      throw new Error(`Skill candidate and control must be separate runs`)
    }
  }

  export async function attest(input: Attestation) {
    const value = Attestation.parse(input)
    const proposal = await read(value.name)
    if (!proposal) throw new Error(`Unknown learned skill proposal ${value.name}`)
    if (proposal.status === "rejected") throw new Error(`Rejected skill proposals cannot receive evidence`)
    if (proposal.status === "promoted") throw new Error(`Promoted skills require a new versioned proposal`)
    const [candidate, control] = await Promise.all([
      HarnessAdapter.authorize(value.candidate.sessionID, value.candidate.evaluatorToken),
      HarnessAdapter.authorize(value.control.sessionID, value.control.evaluatorToken),
    ])
    comparable({ proposal, candidate, control })
    if (!(["held_out", "release"] as string[]).includes(candidate.benchmark.split)) {
      throw new Error(`Skill qualification requires a held-out or release benchmark split`)
    }
    const [candidateEvaluation, controlEvaluation] = await Promise.all(
      [candidate.sessionID, control.sessionID].map(async (sessionID) =>
        (await HarnessEvaluation.list(sessionID)).findLast(HarnessEvaluation.final),
      ),
    )
    if (!candidateEvaluation || !controlEvaluation) throw new Error(`Both skill runs require external evaluations`)
    const direction = candidate.benchmark.direction ?? "pass"
    const delta = (() => {
      if (candidateEvaluation.score === undefined || controlEvaluation.score === undefined) return undefined
      if (direction === "maximize") return candidateEvaluation.score - controlEvaluation.score
      if (direction === "minimize") return controlEvaluation.score - candidateEvaluation.score
      return 0
    })()
    const nonregressing =
      candidateEvaluation.status === "passed" &&
      controlEvaluation.status === "passed" &&
      (direction === "pass" || (delta !== undefined && delta >= 0))
    const improved = nonregressing && direction !== "pass" && delta !== undefined && delta > 0
    const trigger = Trigger.parse(value.trigger)
    const precision = trigger.truePositive / (trigger.truePositive + trigger.falsePositive)
    const recall = trigger.truePositive / (trigger.truePositive + trigger.falseNegative)
    const evidence = Evidence.parse({
      id: digest(`${proposal.contentSHA256}\0${candidate.runID}\0${control.runID}`),
      proposalSHA256: proposal.contentSHA256,
      benchmark: {
        name: candidate.benchmark.name,
        version: candidate.benchmark.version,
        taskID: candidate.benchmark.taskID,
        split: candidate.benchmark.split,
        metric: candidate.benchmark.metric,
        direction,
      },
      candidate: {
        sessionID: candidate.sessionID,
        runID: candidate.runID,
        status: candidateEvaluation.status,
        score: candidateEvaluation.score,
        evaluationSHA256: HarnessEvaluation.fingerprint(candidateEvaluation),
      },
      control: {
        sessionID: control.sessionID,
        runID: control.runID,
        status: controlEvaluation.status,
        score: controlEvaluation.score,
        evaluationSHA256: HarnessEvaluation.fingerprint(controlEvaluation),
      },
      nonregressing,
      improved,
      trigger: { ...trigger, precision, recall },
      evaluator: { name: candidateEvaluation.evaluator.name, version: candidateEvaluation.evaluator.version },
      recordedAt: value.recordedAt ?? Date.now(),
    })
    await JsonStore.update(manifest(value.name), (data) => {
      const current = Manifest.parse(data)
      if (current.contentSHA256 !== evidence.proposalSHA256) throw new Error(`Skill proposal SHA changed`)
      const existing = current.evidence.find((item) => item.id === evidence.id)
      if (
        existing &&
        JSON.stringify({ ...existing, recordedAt: 0 }) !== JSON.stringify({ ...evidence, recordedAt: 0 })
      ) {
        throw new Error(`Skill evidence for this candidate/control pair is immutable`)
      }
      const items = existing ? current.evidence : [...current.evidence, evidence]
      const status = assess(items).qualified ? "qualified" : "pending"
      return Manifest.parse({ ...current, evidence: items, status, updatedAt: Date.now() })
    })
    const updated = await read(value.name)
    if (!updated) throw new Error(`Skill proposal ${value.name} disappeared after attestation`)
    return { manifest: updated, assessment: assess(updated.evidence) }
  }

  export async function promote(name: string) {
    const value = Name.parse(name)
    const proposal = await read(value)
    if (!proposal) throw new Error(`Unknown learned skill proposal ${value}`)
    if (proposal.status !== "qualified" && proposal.status !== "promoted") {
      throw new Error(`Skill proposal ${value} has not met held-out qualification criteria`)
    }
    const content = await Bun.file(skill(value)).text()
    if (digest(content) !== proposal.contentSHA256) throw new Error(`Skill proposal content hash changed`)
    const destination = path.join(active, value, "SKILL.md")
    const existing = await Bun.file(destination)
      .text()
      .catch(() => null)
    if (existing !== null && digest(existing) !== proposal.contentSHA256) {
      throw new Error(`An active skill named ${value} already exists with different content`)
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    if (existing === null) await Bun.write(destination, content, { mode: 0o600 })
    await JsonStore.update(manifest(value), (data) =>
      Manifest.parse({ ...Manifest.parse(data), status: "promoted", promotedAt: Date.now(), updatedAt: Date.now() }),
    )
    return { manifest: await read(value), path: destination }
  }
}
