#!/usr/bin/env bun

import {
  assertReleaseVersionUnoccupied,
  loadReleaseArtifacts,
  preflightRelease,
  promoteReleaseToTag,
  releaseCandidateTag,
  stageCandidateRelease,
  verifyPublishedPackageIntegrities,
  verifyReleaseOptionalDependencies,
  verifyReleaseTags,
} from "./npm-release"
import { assertReleaseSource } from "./release-workspace"

const command = process.argv[2]
if (!command || !["assert-empty", "stage", "promote-test"].includes(command)) {
  throw new Error("Usage: npm-test-release.ts <assert-empty|stage|promote-test>")
}

const version = process.env.OPENSCIENCE_VERSION
const source = process.env.OPENSCIENCE_ARTIFACT_SOURCE
if (!version) throw new Error("OPENSCIENCE_VERSION is required")
if (!source || !/^[0-9a-f]{40}$/i.test(source)) {
  throw new Error("OPENSCIENCE_ARTIFACT_SOURCE must be an immutable commit SHA")
}
await assertReleaseSource(source)

if (command === "assert-empty") {
  await assertReleaseVersionUnoccupied(version)
  console.log(`Confirmed that all npm package slots for ${version} are empty`)
  process.exit(0)
}

const directory = process.env.OPENSCIENCE_NPM_ARTIFACT_DIR
if (!directory) throw new Error("OPENSCIENCE_NPM_ARTIFACT_DIR is required")
const artifacts = await loadReleaseArtifacts({ directory, source, version })
await preflightRelease()

if (command === "stage") {
  const candidate = await stageCandidateRelease(artifacts)
  console.log(`Staged and verified all ${artifacts.length} immutable packages under ${candidate.tag}`)
  process.exit(0)
}

await verifyPublishedPackageIntegrities(artifacts)
await verifyReleaseOptionalDependencies(artifacts)
await verifyReleaseTags(artifacts, releaseCandidateTag(version))
await promoteReleaseToTag(artifacts, "test")
await verifyReleaseTags(artifacts, "test")
console.log(`Promoted the verified ${artifacts.length}-package snapshot to npm test`)
