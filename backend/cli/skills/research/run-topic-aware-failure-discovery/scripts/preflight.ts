#!/usr/bin/env bun

import path from "path"

const file = process.argv[2]
if (!file) throw new Error("Usage: bun scripts/preflight.ts <private-manifest.json>")

const Hash = /^[a-f0-9]{64}$/
const Topic = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const kinds = ["correctness", "topic", "novelty"] as const
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
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
const integer = (value: unknown, label: string, min: number, max: number) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return value as number
}
const number = (value: unknown, label: string, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number from ${min} to ${max}`)
  }
  return value
}
const bytes = async (value: unknown, label: string) => {
  const target = path.resolve(path.dirname(path.resolve(file)), text(value, label))
  const source = Bun.file(target)
  if (!(await source.exists())) throw new Error(`${label} does not exist: ${target}`)
  return source.text()
}
const identity = async (value: unknown, label: string, extras: string[] = []) => {
  const input = record(value, label)
  fields(input, label, ["name", "version", "promptPath", "configPath", ...extras])
  return {
    name: text(input.name, `${label}.name`),
    version: text(input.version, `${label}.version`),
    promptSHA256: hash(await bytes(input.promptPath, `${label}.promptPath`)),
    configSHA256: hash(await bytes(input.configPath, `${label}.configPath`)),
  }
}

const input = record(await Bun.file(path.resolve(file)).json(), "manifest")
fields(input, "manifest", [
  "sourcePoolSHA256",
  "topicSaltPath",
  "topics",
  "topicModel",
  "generator",
  "validators",
  "embedding",
  "budget",
  "anchorsPerAttempt",
  "exploration",
  "failureThreshold",
  "targetFailures",
])
const sourcePoolSHA256 = text(input.sourcePoolSHA256, "sourcePoolSHA256")
if (!Hash.test(sourcePoolSHA256)) throw new Error("sourcePoolSHA256 must be a lowercase SHA-256 digest")
const salt = await bytes(input.topicSaltPath, "topicSaltPath")
if (new TextEncoder().encode(salt).length < 32) throw new Error("topicSaltPath must contain at least 32 bytes")
if (!Array.isArray(input.topics) || input.topics.length < 2 || input.topics.length > 64) {
  throw new Error("topics must contain two to 64 entries")
}
const topics = input.topics
  .map((value, index) => {
    const topic = record(value, `topics[${index}]`)
    fields(topic, `topics[${index}]`, ["id", "definition"])
    const id = text(topic.id, `topics[${index}].id`)
    if (!Topic.test(id)) throw new Error(`topics[${index}].id must be an opaque safe identifier`)
    const definition = text(topic.definition, `topics[${index}].definition`)
    return { id, commitment: hash(JSON.stringify({ id, definition, salt })) }
  })
  .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
if (new Set(topics.map((topic) => topic.id)).size !== topics.length) throw new Error("topic IDs must be unique")
if (new Set(topics.map((topic) => topic.commitment)).size !== topics.length) {
  throw new Error("topic definitions must produce unique commitments")
}

const validators = record(input.validators, "validators")
fields(validators, "validators", [...kinds])
const generator = await identity(input.generator, "generator")
const panel = await Promise.all(
  kinds.map(async (kind) => ({ kind, identity: await identity(validators[kind], `validators.${kind}`) })),
)
const actors = [generator, ...panel.map((item) => item.identity)]
const actorIDs = actors.map((item) => `${item.promptSHA256}:${item.configSHA256}`)
if (new Set(actorIDs).size !== actorIDs.length) {
  throw new Error("generator and validators must use distinct prompt/config commitments")
}

const topicModel = record(input.topicModel, "topicModel")
const embedding = record(input.embedding, "embedding")
const budget = integer(input.budget, "budget", 2, 512)
if (budget < topics.length) throw new Error("budget must initialize every topic arm")
const targetFailures =
  input.targetFailures === undefined ? undefined : integer(input.targetFailures, "targetFailures", 1, budget)
const protocol = {
  protocolVersion: "topic-aware-failure-v1" as const,
  sourcePoolSHA256,
  topicModel: {
    kind: text(topicModel.kind, "topicModel.kind"),
    identity: await identity(topicModel, "topicModel", ["kind"]),
  },
  topics,
  generator,
  validators: panel,
  embedding: {
    identity: await identity(embedding, "embedding", ["dimensions", "regularization"]),
    dimensions: integer(embedding.dimensions, "embedding.dimensions", 2, 64),
    regularization:
      embedding.regularization === undefined
        ? 1e-6
        : number(embedding.regularization, "embedding.regularization", Number.MIN_VALUE, 0.01),
  },
  budget,
  anchorsPerAttempt: integer(input.anchorsPerAttempt, "anchorsPerAttempt", 1, 8),
  exploration:
    input.exploration === undefined ? Math.SQRT2 : number(input.exploration, "exploration", Number.MIN_VALUE, 4),
  failureThreshold: number(input.failureThreshold, "failureThreshold", 0, 1),
  ...(targetFailures === undefined ? {} : { targetFailures }),
}
if (protocol.topicModel.kind !== "predefined" && protocol.topicModel.kind !== "bertopic") {
  throw new Error("topicModel.kind must be predefined or bertopic")
}

console.log(
  JSON.stringify(
    {
      protocol,
      commitments: {
        topicManifestSHA256: hash(JSON.stringify(topics)),
        sourcePoolSHA256,
      },
    },
    null,
    2,
  ),
)
