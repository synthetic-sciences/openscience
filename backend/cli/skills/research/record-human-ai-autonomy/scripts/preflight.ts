#!/usr/bin/env bun

import path from "path"

const mode = process.argv[2]
const first = process.argv[3]
const second = process.argv[4]
if (!mode || !first || (mode === "submission" && !second)) {
  throw new Error(
    "Usage: bun scripts/preflight.ts protocol <manifest.json> | submission <preflight.json> <private-trace.json>",
  )
}

const levels = ["essentially_autonomous", "human_ai_collaboration", "primarily_human"] as const
const actors = ["benchmark", "human", "agent"] as const
const contributions = ["problem", "auxiliary", "essential", "core", "unclear"] as const
const kinds = [
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
] as const
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
const integer = (value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return value as number
}
const choice = <T extends readonly string[]>(value: unknown, label: string, values: T) => {
  const item = text(value, label)
  if (!values.includes(item as T[number])) throw new Error(`${label} must be one of ${values.join(", ")}`)
  return item as T[number]
}
const target = (root: string, value: unknown, label: string) => path.resolve(root, text(value, label))
const bytes = async (root: string, value: unknown, label: string) => {
  const file = target(root, value, label)
  const source = Bun.file(file)
  if (!(await source.exists())) throw new Error(`${label} does not exist: ${file}`)
  return new Uint8Array(await source.arrayBuffer())
}
const digest = async (root: string, value: unknown, label: string) => hash(await bytes(root, value, label))

async function protocol(file: string) {
  const input = record(await Bun.file(path.resolve(file)).json(), "manifest")
  fields(input, "manifest", [
    "claimedLevel",
    "recorder",
    "traceSchemaPath",
    "classificationPolicyPath",
    "maxEvents",
    "disclosure",
  ])
  const recorder = record(input.recorder, "recorder")
  fields(recorder, "recorder", ["name", "version", "artifactPath"])
  const root = path.dirname(path.resolve(file))
  return {
    protocolVersion: "human-ai-autonomy-v1" as const,
    claimedLevel: choice(input.claimedLevel, "claimedLevel", levels),
    recorder: {
      name: text(recorder.name, "recorder.name"),
      version: text(recorder.version, "recorder.version"),
      artifactSHA256: await digest(root, recorder.artifactPath, "recorder.artifactPath"),
      source: "evaluator_runtime" as const,
    },
    traceSchemaSHA256: await digest(root, input.traceSchemaPath, "traceSchemaPath"),
    classificationPolicySHA256: await digest(root, input.classificationPolicyPath, "classificationPolicyPath"),
    maxEvents: integer(input.maxEvents, "maxEvents", 2, 10_000),
    rawRetention: "required" as const,
    disclosure: choice(input.disclosure, "disclosure", ["evaluator_retained", "public_essential_after_release"]),
    completeTraceRequired: true as const,
    uncertaintyPolicy: "inconclusive" as const,
  }
}

async function submission(preflight: string, file: string) {
  const frozen = record(await Bun.file(path.resolve(preflight)).json(), "preflight")
  fields(frozen, "preflight", ["protocol"])
  const protocol = record(frozen.protocol, "preflight.protocol")
  const input = record(await Bun.file(path.resolve(file)).json(), "trace")
  fields(input, "trace", [
    "sessionID",
    "subject",
    "artifactPath",
    "rawLogPath",
    "startedAt",
    "endedAt",
    "events",
  ])
  const root = path.dirname(path.resolve(file))
  const subject = record(input.subject, "subject")
  fields(subject, "subject", ["type", "id"])
  const type = choice(subject.type, "subject.type", ["run", "candidate"])
  const startedAt = integer(input.startedAt, "startedAt")
  const endedAt = integer(input.endedAt, "endedAt")
  if (endedAt < startedAt) throw new Error("endedAt must not precede startedAt")
  if (!Array.isArray(input.events) || input.events.length < 2) throw new Error("events must contain at least two entries")
  const source = input.events
  const maxEvents = integer(protocol.maxEvents, "preflight.protocol.maxEvents", 2, 10_000)
  if (source.length > maxEvents) throw new Error(`events exceed the frozen maxEvents ${maxEvents}`)
  const events = await Promise.all(
    source.map(async (value, index) => {
      const event = record(value, `events[${index}]`)
      fields(event, `events[${index}]`, [
        "sequence",
        "at",
        "actor",
        "kind",
        "contribution",
        "contentPath",
        "artifactBeforePath",
        "artifactAfterPath",
        "evidence",
      ])
      const sequence = integer(event.sequence, `events[${index}].sequence`)
      if (sequence !== index + 1) throw new Error("event sequence must be contiguous from one")
      const at = integer(event.at, `events[${index}].at`)
      if (at < startedAt || at > endedAt) throw new Error(`events[${index}].at falls outside the trace interval`)
      if (index && at < integer(record(source[index - 1], `events[${index - 1}]`).at, `events[${index - 1}].at`)) {
        throw new Error("event time must be monotonic")
      }
      const actor = choice(event.actor, `events[${index}].actor`, actors)
      const kind = choice(event.kind, `events[${index}].kind`, kinds)
      const contribution = choice(event.contribution, `events[${index}].contribution`, contributions)
      if (kind === "problem_statement" && contribution !== "problem") {
        throw new Error("problem_statement must use the problem contribution")
      }
      if ((!index && kind !== "problem_statement") || (index > 0 && kind === "problem_statement")) {
        throw new Error("trace requires exactly one initial problem_statement")
      }
      if (contribution === "problem" && kind !== "problem_statement") {
        throw new Error("only problem_statement may use the problem contribution")
      }
      if (contribution === "problem" && actor === "agent") throw new Error("agent cannot pose the frozen problem")
      if (kind === "exposition" && !["auxiliary", "unclear"].includes(contribution)) {
        throw new Error("exposition cannot be essential or core")
      }
      if (!Array.isArray(event.evidence) || !event.evidence.length || event.evidence.length > 32) {
        throw new Error(`events[${index}].evidence must contain one to 32 references`)
      }
      const evidence = event.evidence.map((item, offset) => text(item, `events[${index}].evidence[${offset}]`))
      return {
        sequence,
        at,
        actor,
        kind,
        contribution,
        contentSHA256: await digest(root, event.contentPath, `events[${index}].contentPath`),
        ...(event.artifactBeforePath
          ? { artifactBeforeSHA256: await digest(root, event.artifactBeforePath, `events[${index}].artifactBeforePath`) }
          : {}),
        ...(event.artifactAfterPath
          ? { artifactAfterSHA256: await digest(root, event.artifactAfterPath, `events[${index}].artifactAfterPath`) }
          : {}),
        evidence,
      }
    }),
  )
  const artifactSHA256 = await digest(root, input.artifactPath, "artifactPath")
  const transitions = events.filter((event) => event.artifactAfterSHA256)
  if (
    transitions.some(
      (event, index) =>
        Boolean(index) && event.artifactBeforeSHA256 !== transitions[index - 1]!.artifactAfterSHA256,
    )
  ) {
    throw new Error("artifact transitions must form one continuous chain")
  }
  if (transitions.at(-1)?.artifactAfterSHA256 !== artifactSHA256) {
    throw new Error("the last artifact transition must bind artifactPath")
  }
  const human = events.filter(
    (event) => event.actor === "human" && (event.contribution === "essential" || event.contribution === "core"),
  ).length
  const agent = events.filter(
    (event) => event.actor === "agent" && (event.contribution === "essential" || event.contribution === "core"),
  ).length
  const unclear = events.filter((event) => event.contribution === "unclear").length
  const derivedLevel = unclear
    ? undefined
    : human && agent
      ? "human_ai_collaboration"
      : human
        ? "primarily_human"
        : agent
          ? "essentially_autonomous"
          : undefined
  return {
    submission: {
      sessionID: text(input.sessionID, "sessionID"),
      subject: { type, id: text(subject.id, "subject.id") },
      artifactSHA256,
      trace: {
        owner: "evaluator_runtime" as const,
        complete: true as const,
        recorderArtifactSHA256: text(protocol.recorder && record(protocol.recorder, "protocol.recorder").artifactSHA256, "protocol.recorder.artifactSHA256"),
        schemaSHA256: text(protocol.traceSchemaSHA256, "protocol.traceSchemaSHA256"),
        classificationPolicySHA256: text(protocol.classificationPolicySHA256, "protocol.classificationPolicySHA256"),
        rawLogSHA256: await digest(root, input.rawLogPath, "rawLogPath"),
        startedAt,
        endedAt,
        events,
      },
    },
    preview: {
      claimedLevel: text(protocol.claimedLevel, "protocol.claimedLevel"),
      derivedLevel,
      unclearEvents: unclear,
      humanSubstantiveEvents: human,
      agentSubstantiveEvents: agent,
    },
  }
}

if (mode === "protocol") console.log(JSON.stringify({ protocol: await protocol(first) }, null, 2))
else if (mode === "submission") console.log(JSON.stringify(await submission(first, second!), null, 2))
else throw new Error(`Unknown mode ${mode}`)
