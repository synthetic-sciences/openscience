#!/usr/bin/env bun

import path from "path"

const file = process.argv[2]
if (!file) throw new Error("Usage: bun scripts/preflight.ts <private-manifest.json>")

const Hash = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/
const tools = ["google_search", "paper_search", "web_browse"] as const
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
const target = (value: unknown, label: string) =>
  path.resolve(path.dirname(path.resolve(file)), text(value, label))
const bytes = async (value: unknown, label: string) => {
  const filename = target(value, label)
  const source = Bun.file(filename)
  if (!(await source.exists())) throw new Error(`${label} does not exist: ${filename}`)
  return source.text()
}
const identity = async (value: unknown, label: string) => {
  const input = record(value, label)
  fields(input, label, ["name", "version", "promptPath", "configPath"])
  return {
    name: text(input.name, `${label}.name`),
    version: text(input.version, `${label}.version`),
    promptSHA256: hash(await bytes(input.promptPath, `${label}.promptPath`)),
    configSHA256: hash(await bytes(input.configPath, `${label}.configPath`)),
  }
}

const input = record(await Bun.file(path.resolve(file)).json(), "manifest")
fields(input, "manifest", [
  "query",
  "referenceTextPath",
  "referenceFacts",
  "factSaltPath",
  "cutoff",
  "tools",
  "traceSchemaPath",
  "filterPolicyPath",
  "maxToolEvents",
  "decomposer",
  "judges",
  "minGeneratedFacts",
  "minPrecision",
  "minRecall",
  "minF1",
])
const query = text(input.query, "query")
const reference = await bytes(input.referenceTextPath, "referenceTextPath")
const salt = await bytes(input.factSaltPath, "factSaltPath")
if (new TextEncoder().encode(salt).length < 32) throw new Error("factSaltPath must contain at least 32 bytes")
if (!Array.isArray(input.referenceFacts) || !input.referenceFacts.length || input.referenceFacts.length > 2_048) {
  throw new Error("referenceFacts must contain one to 2048 entries")
}
const facts = input.referenceFacts
  .map((value, index) => {
    const fact = record(value, `referenceFacts[${index}]`)
    fields(fact, `referenceFacts[${index}]`, ["id", "text"])
    const id = text(fact.id, `referenceFacts[${index}].id`)
    if (!ID.test(id)) throw new Error(`referenceFacts[${index}].id must be an opaque safe identifier`)
    const content = text(fact.text, `referenceFacts[${index}].text`)
    return { id, commitment: hash(JSON.stringify({ kind: "reference_fact", id, content, salt })) }
  })
  .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
if (new Set(facts.map((fact) => fact.id)).size !== facts.length) throw new Error("reference fact IDs must be unique")
if (new Set(facts.map((fact) => fact.commitment)).size !== facts.length) {
  throw new Error("reference facts must produce unique commitments")
}
const cutoff = text(input.cutoff, "cutoff")
const date = /^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? new Date(`${cutoff}T00:00:00Z`) : undefined
if (!date || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== cutoff) {
  throw new Error("cutoff must be an ISO calendar date")
}
if (!Array.isArray(input.tools) || !input.tools.length || input.tools.length > tools.length) {
  throw new Error("tools must contain one to three entries")
}
const selected = input.tools.map((value, index) => text(value, `tools[${index}]`))
if (new Set(selected).size !== selected.length || selected.some((value) => !tools.includes(value as (typeof tools)[number]))) {
  throw new Error("tools must be unique supported clean-room tools")
}
const ordered = selected.toSorted((left, right) => tools.indexOf(left as (typeof tools)[number]) - tools.indexOf(right as (typeof tools)[number]))
if (JSON.stringify(selected) !== JSON.stringify(ordered)) throw new Error("tools must use canonical order")
const judges = record(input.judges, "judges")
fields(judges, "judges", ["precision", "recall"])
const decomposer = await identity(input.decomposer, "decomposer")
const precision = await identity(judges.precision, "judges.precision")
const recall = await identity(judges.recall, "judges.recall")
const actors = [decomposer, precision, recall].map((item) => item.promptSHA256)
if (new Set(actors).size !== actors.length) {
  throw new Error("decomposer, precision judge, and recall judge must use distinct prompt commitments")
}
const protocol = {
  protocolVersion: "scientific-synthesis-v1" as const,
  querySHA256: hash(query),
  referenceSHA256: hash(JSON.stringify({ kind: "reference_text", reference, salt })),
  referenceFactsSHA256: hash(JSON.stringify(facts)),
  referenceFactCount: facts.length,
  cutoff,
  tools: selected,
  traceSchemaSHA256: hash(await bytes(input.traceSchemaPath, "traceSchemaPath")),
  filterPolicySHA256: hash(await bytes(input.filterPolicyPath, "filterPolicyPath")),
  maxToolEvents: integer(input.maxToolEvents, "maxToolEvents", 1, 10_000),
  decomposer,
  judges: { precision, recall },
  minGeneratedFacts: integer(input.minGeneratedFacts, "minGeneratedFacts", 1, 512),
  minPrecision: number(input.minPrecision, "minPrecision", 0, 1),
  minRecall: number(input.minRecall, "minRecall", 0, 1),
  minF1: number(input.minF1, "minF1", 0, 1),
  cleanRoomRequired: true as const,
  judgeFailurePolicy: "inconclusive" as const,
}
console.log(JSON.stringify({ protocol, referenceManifest: facts }, null, 2))
