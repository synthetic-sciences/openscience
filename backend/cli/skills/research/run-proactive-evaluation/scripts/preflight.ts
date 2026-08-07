#!/usr/bin/env bun

const hash = /^[a-f0-9]{64}$/
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
const require = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

function flag(name: string) {
  const index = Bun.argv.indexOf(name)
  require(index >= 0 && Boolean(Bun.argv[index + 1]), `Missing ${name}`)
  return Bun.argv[index + 1]!
}

function record(value: unknown, name: string) {
  require(Boolean(value) && typeof value === "object" && !Array.isArray(value), `${name} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, name: string, allowed: string[], required: string[]) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  const missing = required.filter((key) => !(key in value))
  require(!extra.length, `${name} has unknown fields: ${extra.join(", ")}`)
  require(!missing.length, `${name} is missing fields: ${missing.join(", ")}`)
}

function number(value: unknown, name: string, minimum: number, maximum: number) {
  require(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, `${name} is invalid`)
  return value as number
}

const input = flag("--input")
const protocolFile = flag("--protocol")
const out = flag("--out")
const protocol = record(JSON.parse(await Bun.file(protocolFile).text()), "protocol")
const fields = [
  "sourceModels",
  "selectionSHA256",
  "selectionMethod",
  "calibrationSamples",
  "maxCalibrationMAE",
]
exact(protocol, "protocol", fields, fields)
require(Array.isArray(protocol.sourceModels), "sourceModels must be an array")
const models = protocol.sourceModels as unknown[]
require(models.length >= 3 && models.length <= 64, "sourceModels must contain 3 to 64 entries")
require(models.every((item) => typeof item === "string" && item.length > 0 && item.length <= 240), "sourceModels are invalid")
require(new Set(models).size === models.length, "sourceModels must be unique")
require(hash.test(String(protocol.selectionSHA256)), "selectionSHA256 is invalid")
require(
  protocol.selectionMethod === "pca-gmm-profile-v1" || protocol.selectionMethod === "holdout-embedding-gmm-v1",
  "selectionMethod is invalid",
)
const calibration = number(protocol.calibrationSamples, "calibrationSamples", 2, 64)
require(Number.isInteger(calibration), "calibrationSamples must be an integer")
const threshold = number(protocol.maxCalibrationMAE, "maxCalibrationMAE", Number.MIN_VALUE, 1)
const lines = (await Bun.file(input).text())
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
const privateRows = lines.map((line, index) => record(JSON.parse(line), `probe ${index + 1}`))
require(privateRows.length >= 2 && privateRows.length <= 2_000, "probe pool must contain 2 to 2,000 records")
const probes = privateRows
  .map((row, index) => {
    exact(row, `probe ${index + 1}`, ["id", "hidden", "sourceLosses", "stratum", "weight"], [
      "id",
      "hidden",
      "sourceLosses",
      "stratum",
    ])
    require(typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240, `probe ${index + 1} id is invalid`)
    require(typeof row.stratum === "string" && row.stratum.length > 0 && row.stratum.length <= 120, `probe ${index + 1} stratum is invalid`)
    require(Array.isArray(row.sourceLosses) && row.sourceLosses.length === models.length, `probe ${index + 1} source dimension drifted`)
    const losses = (row.sourceLosses as unknown[]).map((loss, offset) =>
      number(loss, `probe ${index + 1} sourceLosses[${offset}]`, 0, 1),
    )
    const weight = row.weight === undefined ? 1 : number(row.weight, `probe ${index + 1} weight`, Number.MIN_VALUE, 1_000)
    return {
      id: row.id as string,
      commitment: digest(row.hidden),
      sourceLosses: losses,
      stratum: row.stratum as string,
      weight,
    }
  })
  .toSorted((left, right) => left.id.localeCompare(right.id))
require(new Set(probes.map((probe) => probe.id)).size === probes.length, "probe ids must be unique")
require(new Set(probes.map((probe) => probe.commitment)).size === probes.length, "hidden probe commitments must be unique")
require(calibration <= probes.length, "calibrationSamples exceed the probe pool")
const transfer = {
  protocolVersion: "score-history-prior-v1",
  poolSHA256: digest(probes),
  sourceManifestSHA256: digest({
    sourceModels: models,
    scores: probes.map((probe) => ({ id: probe.id, sourceLosses: probe.sourceLosses })),
  }),
  selectionSHA256: protocol.selectionSHA256,
  selectionMethod: protocol.selectionMethod,
  sourceModels: models,
  calibrationSamples: calibration,
  maxCalibrationMAE: threshold,
}
await Bun.write(out, `${JSON.stringify({ schemaVersion: 1, transfer, probes }, null, 2)}\n`)
console.log(JSON.stringify({ valid: true, tokenFree: true, probes: probes.length, poolSHA256: transfer.poolSHA256, out }))
