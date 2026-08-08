#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"

const mode = process.argv[2]
const first = process.argv[3]
const second = process.argv[4]
const third = process.argv[5]
if (!mode || !first || (mode === "attempt" && (!second || !third))) {
  throw new Error(
    "Usage: bun scripts/preflight.ts protocol <manifest.json> | attempt <preflight.json> <lease.json> <evidence.json>",
  )
}

const hash = (value: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const record = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const fields = (value: Record<string, unknown>, label: string, allowed: string[]) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`)
}
const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}
const integer = (value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return value as number
}
const boolean = (value: unknown, label: string) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`)
  return value
}
const target = (root: string, value: unknown, label: string) => {
  const input = text(value, label)
  if (path.isAbsolute(input)) throw new Error(`${label} must be relative to its evidence directory`)
  const file = path.resolve(root, input)
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes its evidence directory`)
  return file
}
const bytes = async (root: string, value: unknown, label: string) => {
  const file = target(root, value, label)
  const boundary = await fs.realpath(root)
  const real = await fs.realpath(file)
  if (real !== boundary && !real.startsWith(`${boundary}${path.sep}`)) {
    throw new Error(`${label} resolves outside its evidence directory`)
  }
  return new Uint8Array(await Bun.file(real).arrayBuffer())
}
const digest = async (root: string, value: unknown, label: string) => hash(await bytes(root, value, label))

async function protocol(file: string) {
  const input = record(await Bun.file(path.resolve(file)).json(), "manifest")
  fields(input, "manifest", [
    "graphSchemaPath",
    "compilerPath",
    "sketchValidatorPath",
    "reviewerPath",
    "reviewerPromptPath",
    "maxNodes",
    "maxDepth",
    "maxParallel",
    "maxAttemptsPerGoal",
    "maxRefinementsPerGoal",
    "leaseDurationMs",
  ])
  const root = path.dirname(path.resolve(file))
  const blueprint = {
    protocolVersion: "proof-blueprint-v1" as const,
    graphSchemaSHA256: await digest(root, input.graphSchemaPath, "graphSchemaPath"),
    compilerArtifactSHA256: await digest(root, input.compilerPath, "compilerPath"),
    sketchValidatorArtifactSHA256: await digest(root, input.sketchValidatorPath, "sketchValidatorPath"),
    reviewerArtifactSHA256: await digest(root, input.reviewerPath, "reviewerPath"),
    reviewerPromptSHA256: await digest(root, input.reviewerPromptPath, "reviewerPromptPath"),
    nodePolicy: "and-or-monotone-v1" as const,
    failurePolicy: "preserve-and-refine" as const,
    memoization: "goal-sha256" as const,
    finalAuthority: "formal-proof-v1" as const,
    directAttemptFirst: true as const,
    verifiedSketchRequired: true as const,
    completeFailureHistoryRequired: true as const,
    maxNodes: integer(input.maxNodes, "maxNodes", 2, 512),
    maxDepth: integer(input.maxDepth, "maxDepth", 1, 32),
    maxParallel: integer(input.maxParallel, "maxParallel", 1, 32),
    maxAttemptsPerGoal: integer(input.maxAttemptsPerGoal, "maxAttemptsPerGoal", 1, 16),
    maxRefinementsPerGoal: integer(input.maxRefinementsPerGoal, "maxRefinementsPerGoal", 0, 16),
    leaseDurationMs: integer(input.leaseDurationMs, "leaseDurationMs", 1_000, 3_600_000),
  }
  if (blueprint.maxParallel > blueprint.maxNodes) throw new Error("maxParallel cannot exceed maxNodes")
  const artifacts = [
    blueprint.graphSchemaSHA256,
    blueprint.compilerArtifactSHA256,
    blueprint.sketchValidatorArtifactSHA256,
    blueprint.reviewerArtifactSHA256,
    blueprint.reviewerPromptSHA256,
  ]
  if (new Set(artifacts).size !== artifacts.length) {
    throw new Error("schema, compiler, validator, reviewer, and reviewer prompt must be distinct artifacts")
  }
  return { blueprint }
}

async function attempt(preflight: string, leaseFile: string, evidenceFile: string) {
  const frozen = record(await Bun.file(path.resolve(preflight)).json(), "preflight")
  fields(frozen, "preflight", ["blueprint"])
  const blueprint = record(frozen.blueprint, "preflight.blueprint")
  const lease = record(await Bun.file(path.resolve(leaseFile)).json(), "lease")
  fields(lease, "lease", ["id", "goalID", "revision", "ordinal", "status", "issuedAt", "expiresAt"])
  if (lease.status !== "open") throw new Error("lease must be open")
  const input = record(await Bun.file(path.resolve(evidenceFile)).json(), "evidence")
  fields(input, "evidence", [
    "sessionID",
    "kind",
    "artifactPath",
    "claim",
    "informalPlanPath",
    "children",
    "compiler",
    "validator",
    "review",
  ])
  const root = path.dirname(path.resolve(evidenceFile))
  const compiler = record(input.compiler, "compiler")
  fields(compiler, "compiler", [
    "artifactPath",
    "statementMatched",
    "exitCode",
    "warnings",
    "transcriptPath",
    "feedbackPath",
    "startedAt",
    "endedAt",
  ])
  const verification = {
    compilerArtifactSHA256: await digest(root, compiler.artifactPath, "compiler.artifactPath"),
    statementMatched: boolean(compiler.statementMatched, "compiler.statementMatched"),
    exitCode: integer(compiler.exitCode, "compiler.exitCode", -2147483648, 2147483647),
    warnings: integer(compiler.warnings, "compiler.warnings", 0),
    transcriptSHA256: await digest(root, compiler.transcriptPath, "compiler.transcriptPath"),
    feedbackSHA256: await digest(root, compiler.feedbackPath, "compiler.feedbackPath"),
    startedAt: integer(compiler.startedAt, "compiler.startedAt", Number(lease.issuedAt), Number(lease.expiresAt)),
    endedAt: integer(compiler.endedAt, "compiler.endedAt", Number(lease.issuedAt), Number(lease.expiresAt)),
  }
  if (verification.startedAt > verification.endedAt) throw new Error("compiler interval is reversed")
  if (verification.compilerArtifactSHA256 !== text(blueprint.compilerArtifactSHA256, "blueprint.compilerArtifactSHA256")) {
    throw new Error("compiler artifact does not match the frozen blueprint")
  }
  const base = {
    sessionID: text(input.sessionID, "sessionID"),
    leaseID: text(lease.id, "lease.id"),
    artifactSHA256: await digest(root, input.artifactPath, "artifactPath"),
  }
  if (input.kind === "direct") {
    if (!(["proof", "refutation", "failure"] as unknown[]).includes(input.claim)) {
      throw new Error("claim must be proof, refutation, or failure")
    }
    return { submission: { ...base, kind: "direct" as const, claim: input.claim, verification } }
  }
  if (input.kind !== "decomposition") throw new Error("kind must be direct or decomposition")
  if (!Array.isArray(input.children) || !input.children.length || input.children.length > 16) {
    throw new Error("children must contain 1 to 16 goal specifications")
  }
  const children = await Promise.all(
    input.children.map(async (value, index) => {
      const item = record(value, `children[${index}]`)
      fields(item, `children[${index}]`, ["statementPath", "declaration", "module"])
      return {
        statementSHA256: await digest(root, item.statementPath, `children[${index}].statementPath`),
        declaration: text(item.declaration, `children[${index}].declaration`),
        module: text(item.module, `children[${index}].module`),
      }
    }),
  )
  const validator = record(input.validator, "validator")
  fields(validator, "validator", ["artifactPath", "transcriptPath"])
  const review = record(input.review, "review")
  fields(review, "review", ["artifactPath", "promptPath", "relevant", "easier", "plausible", "transcriptPath"])
  const validatorArtifactSHA256 = await digest(root, validator.artifactPath, "validator.artifactPath")
  const reviewerArtifactSHA256 = await digest(root, review.artifactPath, "review.artifactPath")
  const promptSHA256 = await digest(root, review.promptPath, "review.promptPath")
  if (
    validatorArtifactSHA256 !==
      text(blueprint.sketchValidatorArtifactSHA256, "blueprint.sketchValidatorArtifactSHA256") ||
    reviewerArtifactSHA256 !== text(blueprint.reviewerArtifactSHA256, "blueprint.reviewerArtifactSHA256") ||
    promptSHA256 !== text(blueprint.reviewerPromptSHA256, "blueprint.reviewerPromptSHA256")
  ) {
    throw new Error("validator, reviewer, or reviewer prompt does not match the frozen blueprint")
  }
  return {
    submission: {
      ...base,
      kind: "decomposition" as const,
      informalPlanSHA256: await digest(root, input.informalPlanPath, "informalPlanPath"),
      children,
      verification: {
        ...verification,
        validatorArtifactSHA256,
        placeholderDeclarations: children.map((item) => item.declaration).toSorted((a, b) => a.localeCompare(b)),
        validatorTranscriptSHA256: await digest(root, validator.transcriptPath, "validator.transcriptPath"),
      },
      review: {
        reviewerArtifactSHA256,
        promptSHA256,
        relevant: boolean(review.relevant, "review.relevant"),
        easier: boolean(review.easier, "review.easier"),
        plausible: boolean(review.plausible, "review.plausible"),
        transcriptSHA256: await digest(root, review.transcriptPath, "review.transcriptPath"),
      },
    },
    frozen: {
      compilerArtifactSHA256: text(blueprint.compilerArtifactSHA256, "blueprint.compilerArtifactSHA256"),
      sketchValidatorArtifactSHA256: text(
        blueprint.sketchValidatorArtifactSHA256,
        "blueprint.sketchValidatorArtifactSHA256",
      ),
      reviewerArtifactSHA256: text(blueprint.reviewerArtifactSHA256, "blueprint.reviewerArtifactSHA256"),
      reviewerPromptSHA256: text(blueprint.reviewerPromptSHA256, "blueprint.reviewerPromptSHA256"),
    },
  }
}

const result = mode === "protocol" ? await protocol(first) : await attempt(first, second!, third!)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
