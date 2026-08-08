#!/usr/bin/env bun

import path from "path"
import { HarnessContract } from "../../../../src/session/harness/contract"
import { HarnessMeta } from "../../../../src/session/harness/meta"

const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
const args = Bun.argv.slice(2)
const options = Object.fromEntries(
  args.flatMap((value, index) => (value.startsWith("--") && args[index + 1] ? [[value.slice(2), args[index + 1]!]] : [])),
)
const required = (name: string) => {
  const value = options[name]
  if (!value) throw new Error(`Missing --${name}`)
  return value
}
const read = async (name: string) => JSON.parse(await Bun.file(path.resolve(required(name))).text()) as unknown
const hash = (name: string) => {
  const value = required(name)
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`--${name} must be a lowercase SHA-256`)
  return value
}

const protocol = HarnessContract.MetaHarness.parse(await read("protocol"))
const selection = HarnessMeta.Selection.parse(await read("selection"))
const source = (await read("archive")) as { uri?: unknown; entries?: unknown }
if (typeof source.uri !== "string" || !Array.isArray(source.entries)) {
  throw new Error(`--archive must contain a URI and entries array`)
}
const entries = source.entries.toSorted((left, right) => {
  const a = (left as { candidateID?: string }).candidateID ?? ""
  const b = (right as { candidateID?: string }).candidateID ?? ""
  return a.localeCompare(b)
})
const archiveBase = {
  uri: source.uri,
  schemaSHA256: protocol.archiveSchemaSHA256,
  indexSHA256: digest(entries),
  contents: protocol.archive.contents,
  query: protocol.archive.query,
  complete: true as const,
  hiddenContent: protocol.archive.hiddenContent,
  evaluatorContent: protocol.archive.evaluatorContent,
  entries,
}
const archive = { ...archiveBase, sha256: digest(archiveBase) }
const input = HarnessMeta.Submit.parse({
  schemaVersion: 1,
  sessionID: selection.sourceSessionID,
  metaToken: "token-injected-only-at-request-time-000000000000000000",
  selectionID: selection.selectionID,
  candidateArtifactSHA256: selection.candidateArtifact.sha256,
  candidateManifestSHA256: hash("candidate-manifest"),
  protectedManifestSHA256: protocol.protected.manifestSHA256,
  validatorSHA256: protocol.validatorSHA256,
  archive,
  refinements: await read("refinements"),
  cells: await read("cells"),
  evaluatedAt: Math.max(Date.now(), selection.selectedAt),
})
const output = structuredClone(input) as Record<string, unknown>
delete output.metaToken
await Bun.write(path.resolve(required("output")), JSON.stringify(output, null, 2) + "\n")
process.stdout.write(`${JSON.stringify({ output: path.resolve(required("output")), archiveSHA256: archive.sha256 })}\n`)
