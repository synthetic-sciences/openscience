#!/usr/bin/env bun

import { loadReleaseArtifacts, verifyPackedModuleExports } from "./npm-release"

const directory = process.env.OPENSCIENCE_NPM_ARTIFACT_DIR
const source = process.env.OPENSCIENCE_ARTIFACT_SOURCE
const version = process.env.OPENSCIENCE_VERSION
if (!directory) throw new Error("OPENSCIENCE_NPM_ARTIFACT_DIR is required")
if (!source) throw new Error("OPENSCIENCE_ARTIFACT_SOURCE is required")
if (!version) throw new Error("OPENSCIENCE_VERSION is required")

const artifacts = await loadReleaseArtifacts({ directory, source, version })
const specifiers = await verifyPackedModuleExports(artifacts)
console.log(`Verified ${specifiers.length} packed SDK/plugin exports in Node`)
