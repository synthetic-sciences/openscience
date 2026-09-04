#!/usr/bin/env bun

import path from "path"
import os from "os"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import cli from "../../backend/cli/package.json"
import { NativeTargets, nativePackageName } from "../../backend/cli/script/native-targets"
import sdk from "../sdk/js/package.json"
import plugin from "../plugin/package.json"
import launcher from "../launcher/package.json"

type Result = {
  exitCode: number
  stdout: string
  stderr: string
}

export type NpmCommandOptions = {
  command?: string | string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export type PackedPackage = {
  file: string
  integrity: string
  name: string
  version: string
}

type SavedArtifact = Omit<PackedPackage, "file"> & {
  file: string
}

type ArtifactManifest = {
  schema: 1
  source: string
  version: string
  artifacts: SavedArtifact[]
}

export class NpmArtifactConflict extends Error {}
export class NpmPermissionError extends Error {}

const publishAttempts = [1, 2, 3, 4, 5] as const
const defaultVisibilityAttempts = 180
/** Registry writes run this many at a time, matching tooling/repo/publish.ts. */
const batchSize = 5

async function run(args: string[], options: NpmCommandOptions = {}): Promise<Result> {
  const configured = options.command ?? process.env.OPENSCIENCE_NPM_COMMAND ?? "npm"
  const command = Array.isArray(configured) ? configured : [configured]
  const proc = Bun.spawn([...command, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** npm normally redacts credentials, but release failures are copied into CI
 * annotations and exceptions. Redact the common token shapes, authenticated
 * URLs, npmrc assignments, and the exact configured secrets before retaining
 * the bounded diagnostic tail. */
export function sanitizeNpmDiagnostic(value: string, env: Record<string, string | undefined> = process.env) {
  let output = value
    .replace(/\b(?:npm|gh[opurs]|github_pat)_[A-Za-z0-9_=-]{16,}\b/g, "[redacted-token]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/((?:_authToken|npm-token|authorization)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]")
  for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_CONFIG_TOKEN"]) {
    const secret = env[key]
    if (secret && secret.length >= 8) output = output.replaceAll(secret, "[redacted-token]")
  }
  return output
}

function diagnostic(result: Result) {
  return sanitizeNpmDiagnostic([result.stdout, result.stderr].filter(Boolean).join("\n")).trim().slice(-2_000)
}

function failure(result: Result) {
  return diagnostic(result) || `exit ${result.exitCode}`
}

function retryDelay(options: NpmCommandOptions) {
  const value = Number(options.env?.OPENSCIENCE_NPM_RETRY_MS ?? process.env.OPENSCIENCE_NPM_RETRY_MS ?? 1_000)
  return Number.isFinite(value) && value >= 0 ? value : 1_000
}

function visibilityAttempts(options: NpmCommandOptions) {
  const value = Number(
    options.env?.OPENSCIENCE_NPM_VISIBILITY_ATTEMPTS ??
      process.env.OPENSCIENCE_NPM_VISIBILITY_ATTEMPTS ??
      defaultVisibilityAttempts,
  )
  return Number.isInteger(value) && value > 0 ? value : defaultVisibilityAttempts
}

function visibilityRetryDelay(options: NpmCommandOptions) {
  const value = Number(
    options.env?.OPENSCIENCE_NPM_VISIBILITY_RETRY_MS ?? process.env.OPENSCIENCE_NPM_VISIBILITY_RETRY_MS ?? 2_000,
  )
  return Number.isFinite(value) && value >= 0 ? value : 2_000
}

/** Run registry calls, reads and writes alike, in bounded batches so the
 * release runner never fans out wider than batchSize npm processes. Every
 * batch settles before the first rejection is rethrown, so no in-flight write
 * can race a caller's rollback or land after its diagnostics. Results keep
 * the input order. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>) {
  const batches = Array.from({ length: Math.ceil(items.length / batchSize) }, (_, index) =>
    items.slice(index * batchSize, index * batchSize + batchSize),
  )
  const results: R[] = []
  for (const batch of batches) {
    const settled = await Promise.allSettled(batch.map(work))
    const failure = settled.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
    results.push(...settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])))
  }
  return results
}

function isAlreadyPublished(detail: string) {
  return /cannot publish over|previously published|cannot modify pre-existing version/i.test(detail)
}

function isPermissionFailure(detail: string) {
  return /\bE403\b|do not have permission|not authorized|forbidden/i.test(detail)
}

export function nativeReleasePackageNames() {
  return NativeTargets.map((target) => nativePackageName(cli.name, target))
}

export function releasePackageNames() {
  return [...nativeReleasePackageNames(), cli.name, sdk.name, plugin.name, launcher.name].filter(
    (name, index, all) => all.indexOf(name) === index,
  )
}

export function releasePromotionNames() {
  return [...nativeReleasePackageNames(), sdk.name, plugin.name, cli.name, launcher.name]
}

export function releaseStagingTag(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Release staging tags require stable semver, received ${version}`)
  return `release-${version.replaceAll(".", "-")}`
}

export function releaseCandidateTag(version: string) {
  if (!/^\d+\.\d+\.\d+-test\.[0-9A-Za-z.-]+$/.test(version)) {
    throw new Error(`Test candidate tags require a test prerelease, received ${version}`)
  }
  const slug = version
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, "-")
    .slice(0, 80)
  const digest = createHash("sha256").update(version).digest("hex").slice(0, 12)
  return `candidate-${slug}-${digest}`
}

export async function preflightRelease(options: NpmCommandOptions = {}) {
  const auth = await run(["whoami"], options)
  if (auth.exitCode !== 0) {
    throw new Error(`npm authentication preflight failed: ${failure(auth)}`)
  }
  const identity = auth.stdout.trim().split(/\s+/)[0]
  if (!identity) throw new Error("npm authentication preflight returned an empty identity")

  const checks = await Promise.all(
    releasePackageNames().map(async (name) => {
      const result = await run(["owner", "ls", name], options)
      if (result.exitCode !== 0) return { name, error: failure(result), owners: [] as string[] }
      const owners = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean)
      return { name, error: undefined, owners }
    }),
  )
  const missing = checks.filter(
    (check) => check.error || !check.owners.some((owner) => owner.toLowerCase() === identity.toLowerCase()),
  )
  if (missing.length > 0) {
    const packages = missing.map((check) => `${check.name}${check.error ? ` (${check.error})` : ""}`).join(", ")
    throw new Error(`npm identity '${identity}' is not an owner of every release package: ${packages}`)
  }
  console.log(`npm publisher '${identity}' owns all ${checks.length} release packages`)
  return { identity, packages: checks.map((check) => check.name) }
}

async function packedManifest(file: string) {
  const proc = Bun.spawn(["tar", "-xOzf", file, "package/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`Could not inspect npm tarball ${file}: ${stderr.trim()}`)
  return JSON.parse(stdout) as { exports?: unknown; name?: string; version?: string }
}

export async function packedIntegrity(file: string) {
  const bytes = await Bun.file(file).arrayBuffer()
  const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64")
  return `sha512-${digest}`
}

export function createCompiledPackageManifest(
  source: string,
  version: string,
  options: { preserveSourceDirectory?: boolean } = {},
) {
  const parsed = JSON.parse(source) as Record<string, unknown>
  if (
    typeof parsed.name !== "string" ||
    !parsed.exports ||
    typeof parsed.exports !== "object" ||
    Array.isArray(parsed.exports)
  ) {
    throw new Error("Compiled npm packages require a name and exports object")
  }
  const exports = Object.fromEntries(
    Object.entries(parsed.exports).map(([key, value]) => {
      if (typeof value !== "string") throw new Error(`Compiled npm export ${key} must be a source path`)
      if (!value.startsWith("./src/") || !value.endsWith(".ts")) {
        throw new Error(`Compiled npm export ${key} must point to a TypeScript file under ./src`)
      }
      const output = options.preserveSourceDirectory ? "./dist/src/" : "./dist/"
      const file = value.replace("./src/", output).replace(/\.ts$/, "")
      return [key, { import: `${file}.js`, types: `${file}.d.ts` }]
    }),
  )
  return { ...parsed, exports, name: parsed.name, version }
}

async function assertPackedIdentity(input: { file: string; name: string; version: string }) {
  const pkg = await packedManifest(input.file)
  if (pkg.name !== input.name || pkg.version !== input.version) {
    throw new Error(
      `Packed manifest mismatch: expected ${input.name}@${input.version}, received ${pkg.name ?? "unknown"}@${pkg.version ?? "unknown"}`,
    )
  }
}

export async function packPackage(input: { cwd: string; name: string; version: string }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openscience-npm-"))
  const proc = Bun.spawn([process.execPath, "pm", "pack", "--destination", dir, "--ignore-scripts", "--quiet"], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`Could not pack ${input.name}@${input.version}: ${(stderr || stdout).trim()}`)
  const archives = (await readdir(dir)).filter((file) => file.endsWith(".tgz"))
  if (archives.length !== 1) {
    throw new Error(`Expected one npm tarball for ${input.name}@${input.version}, found ${archives.length}`)
  }
  const file = path.join(dir, archives[0])
  await assertPackedIdentity({ ...input, file })
  return {
    file,
    integrity: await packedIntegrity(file),
    name: input.name,
    version: input.version,
  } satisfies PackedPackage
}

function artifactFilename(name: string) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}.tgz`
}

export async function saveReleaseArtifacts(input: {
  artifacts: PackedPackage[]
  directory: string
  source: string
  version: string
}) {
  if (!/^[0-9a-f]{40}$/i.test(input.source))
    throw new Error(`Release artifact source must be a commit SHA: ${input.source}`)
  const expected = releasePackageNames()
  const actual = input.artifacts.map((artifact) => artifact.name)
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((name) => !actual.includes(name))
  ) {
    throw new Error(`Release artifacts must contain exactly: ${expected.join(", ")}`)
  }
  await mkdir(input.directory, { recursive: true })
  const artifacts: SavedArtifact[] = []
  for (const artifact of input.artifacts) {
    if (artifact.version !== input.version) {
      throw new Error(`Release artifact ${artifact.name} has version ${artifact.version}, expected ${input.version}`)
    }
    const file = artifactFilename(artifact.name)
    const destination = path.join(input.directory, file)
    await copyFile(artifact.file, destination)
    const integrity = await packedIntegrity(destination)
    if (integrity !== artifact.integrity) throw new Error(`Artifact copy changed bytes for ${artifact.name}`)
    artifacts.push({ file, integrity, name: artifact.name, version: artifact.version })
  }
  const manifest = { schema: 1, source: input.source, version: input.version, artifacts } satisfies ArtifactManifest
  await Bun.write(path.join(input.directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function loadReleaseArtifacts(input: { directory: string; source: string; version: string }) {
  const manifest = (await Bun.file(path.join(input.directory, "manifest.json")).json()) as ArtifactManifest
  if (manifest.schema !== 1) throw new Error(`Unsupported npm artifact manifest schema: ${manifest.schema}`)
  if (manifest.source !== input.source) {
    throw new Error(`Npm artifacts were built from ${manifest.source}, but this release is pinned to ${input.source}`)
  }
  if (manifest.version !== input.version) {
    throw new Error(`Npm artifacts are for ${manifest.version}, but this release is ${input.version}`)
  }
  const expected = releasePackageNames()
  const names = manifest.artifacts.map((artifact) => artifact.name)
  const files = manifest.artifacts.map((artifact) => artifact.file)
  if (
    names.length !== expected.length ||
    new Set(names).size !== names.length ||
    new Set(files).size !== files.length ||
    expected.some((name) => !names.includes(name))
  ) {
    throw new Error(`Npm artifact manifest does not contain the exact ${expected.length}-package release set`)
  }

  const directory = path.resolve(input.directory)
  const artifacts: PackedPackage[] = []
  for (const artifact of manifest.artifacts) {
    if (artifact.version !== input.version) {
      throw new Error(`Cached npm artifact ${artifact.name} is ${artifact.version}, expected ${input.version}`)
    }
    if (artifact.file !== artifactFilename(artifact.name)) {
      throw new Error(`Cached npm artifact filename mismatch for ${artifact.name}: ${artifact.file}`)
    }
    const file = path.resolve(directory, artifact.file)
    if (path.dirname(file) !== directory) throw new Error(`Unsafe npm artifact path: ${artifact.file}`)
    await assertPackedIdentity({ file, name: artifact.name, version: artifact.version })
    const integrity = await packedIntegrity(file)
    if (integrity !== artifact.integrity) throw new Error(`Cached npm artifact integrity mismatch for ${artifact.name}`)
    artifacts.push({ file, integrity, name: artifact.name, version: artifact.version })
  }
  return artifacts
}

function publicImportSpecifiers(manifest: Awaited<ReturnType<typeof packedManifest>>) {
  if (
    typeof manifest.name !== "string" ||
    !manifest.exports ||
    typeof manifest.exports !== "object" ||
    Array.isArray(manifest.exports)
  ) {
    throw new Error("Packed module requires a package name and exports object")
  }
  return Object.keys(manifest.exports).map((key) => {
    if (key === ".") return manifest.name!
    if (!key.startsWith("./")) throw new Error(`Unsupported packed module export: ${key}`)
    return `${manifest.name}/${key.slice(2)}`
  })
}

/** Install the exact packed SDK and plugin together, then import every public
 * export with Node. This runs before caching or publishing, so broken ESM
 * specifiers and missing packed files cannot become immutable npm releases. */
export async function verifyPackedModuleExports(
  artifacts: PackedPackage[],
  options: { nodeCommand?: string | string[]; npmCommand?: string | string[] } = {},
) {
  const targets = [sdk.name, plugin.name].map((name) => {
    const artifact = artifacts.find((value) => value.name === name)
    if (!artifact) throw new Error(`Missing packed module for import verification: ${name}`)
    return artifact
  })
  const specifiers = (
    await Promise.all(targets.map(async (artifact) => publicImportSpecifiers(await packedManifest(artifact.file))))
  ).flat()
  const directory = await mkdtemp(path.join(os.tmpdir(), "openscience-packed-modules-"))
  try {
    const install = await run(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--prefix",
        directory,
        ...targets.map((artifact) => artifact.file),
      ],
      { command: options.npmCommand ?? "npm", cwd: directory },
    )
    if (install.exitCode !== 0) throw new Error(`Could not install packed SDK/plugin: ${failure(install)}`)
    const probe = path.join(directory, "verify-exports.mjs")
    await Bun.write(probe, `${specifiers.map((value) => `await import(${JSON.stringify(value)})`).join("\n")}\n`)
    const configured = options.nodeCommand ?? "node"
    const command = Array.isArray(configured) ? configured : [configured]
    const proc = Bun.spawn([...command, probe], {
      cwd: directory,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`Packed SDK/plugin exports do not load in Node: ${(stderr || stdout).trim().slice(-2_000)}`)
    }
    return specifiers
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function registryVersionIntegrity(name: string, version: string, options: NpmCommandOptions) {
  const spec = `${name}@${version}`
  const result = await run(["view", spec, "dist.integrity", "--json"], options)
  if (result.exitCode !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`
    if (/\bE404\b|No match found for version/i.test(detail)) return
    throw new Error(`Could not inspect ${spec} on npm: ${failure(result)}`)
  }
  const value = JSON.parse(result.stdout) as unknown
  if (typeof value !== "string" || !value.startsWith("sha512-")) {
    throw new Error(`npm returned no usable dist.integrity for ${spec}`)
  }
  return value
}

async function registryIntegrity(input: PackedPackage, options: NpmCommandOptions) {
  return await registryVersionIntegrity(input.name, input.version, options)
}

async function assertEquivalent(input: PackedPackage, remote: string, options: NpmCommandOptions) {
  if (remote === input.integrity) return "bytes" as const
  const spec = `${input.name}@${input.version}`
  const diff = await run(["diff", `--diff=${input.file}`, `--diff=${spec}`, "--diff-name-only"], options)
  if (diff.exitCode !== 0)
    throw new Error(`Could not compare local and registry contents for ${spec}: ${failure(diff)}`)
  const changed = diff.stdout.trim()
  if (!changed) return "contents" as const
  throw new NpmArtifactConflict(
    `${spec} already exists with different contents (local ${input.integrity}, registry ${remote}; changed: ${changed
      .split(/\r?\n/)
      .slice(0, 20)
      .join(", ")})`,
  )
}

export async function verifyPublishedPackage(input: PackedPackage, options: NpmCommandOptions = {}) {
  const errors: unknown[] = []
  const attempts = visibilityAttempts(options)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const remote = await registryIntegrity(input, options)
      if (remote) return await assertEquivalent(input, remote, options)
      errors.push(new Error(`${input.name}@${input.version} is not visible on npm`))
    } catch (error) {
      if (error instanceof NpmArtifactConflict) throw error
      errors.push(error)
    }
    if (attempt < attempts) await Bun.sleep(visibilityRetryDelay(options))
  }
  throw errors.at(-1)
}

export async function verifyPublishedPackages(inputs: PackedPackage[], options: NpmCommandOptions = {}) {
  const results = await Promise.allSettled(inputs.map((input) => verifyPublishedPackage(input, options)))
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return []
    const input = inputs[index]
    return [new Error(`Could not verify ${input.name}@${input.version}`, { cause: result.reason })]
  })
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length}/${inputs.length} packages were not verifiable on npm`)
  }
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
}

async function inspectPublishedPackage(input: PackedPackage, options: NpmCommandOptions) {
  const remote = await registryIntegrity(input, options)
  if (!remote) return false
  if (remote !== input.integrity) {
    throw new NpmArtifactConflict(
      `${input.name}@${input.version} registry integrity ${remote} does not match the immutable manifest ${input.integrity}`,
    )
  }
  return true
}

async function waitForPublishedSet(inputs: PackedPackage[], options: NpmCommandOptions) {
  const attempts = visibilityAttempts(options)
  let missing = inputs
  let errors: unknown[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const results = await Promise.allSettled(inputs.map((input) => inspectPublishedPackage(input, options)))
    missing = []
    errors = []
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (!result.value) missing.push(inputs[index])
        continue
      }
      if (result.reason instanceof NpmArtifactConflict) throw result.reason
      errors.push(
        new Error(`Could not inspect ${inputs[index].name}@${inputs[index].version}`, { cause: result.reason }),
      )
    }
    if (missing.length === 0 && errors.length === 0) return []
    if (attempt === 1 || attempt === attempts || attempt % 15 === 0) {
      console.log(
        `  npm visibility ${attempt}/${attempts}: ${missing.length} absent, ${errors.length} read errors` +
          `${missing.length ? ` (${missing.map((item) => item.name).join(", ")})` : ""}`,
      )
    }
    if (attempt < attempts) await Bun.sleep(visibilityRetryDelay(options))
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `npm registry inspection failed for ${errors.length}/${inputs.length} packages`)
  }
  return missing
}

export async function verifyPublishedPackageIntegrities(inputs: PackedPackage[], options: NpmCommandOptions = {}) {
  const missing = await waitForPublishedSet(inputs, options)
  if (missing.length > 0) {
    throw new Error(`npm packages are not visible: ${missing.map((item) => `${item.name}@${item.version}`).join(", ")}`)
  }
}

async function submitPackageOnce(
  input: PackedPackage,
  tag: string,
  options: NpmCommandOptions,
  phase: "initial" | "repair",
) {
  const result = await run(["publish", input.file, "--access", "public", "--tag", tag], options)
  if (result.exitCode === 0) {
    console.log(`  ${phase} submission accepted for ${input.name}@${input.version}`)
    const response = diagnostic(result)
    if (response) console.log(`  sanitized npm response for ${input.name}:\n${response}`)
    return true
  }
  const detail = `${result.stdout}\n${result.stderr}`
  if (isPermissionFailure(detail) && !isAlreadyPublished(detail)) {
    throw new NpmPermissionError(`npm refused ${input.name}@${input.version}: ${failure(result)}`)
  }
  // A failed request can still have committed at the registry. Do not infer
  // absence from the npm process exit code; the visibility pass below is the
  // authoritative result and the only input to the single repair round.
  console.warn(`  ${phase} submission uncertain for ${input.name}@${input.version}: ${failure(result)}`)
  return false
}

async function repairSubmittedRelease(
  artifacts: PackedPackage[],
  tag: string,
  label: "npm candidate" | "npm release",
  options: NpmCommandOptions,
) {
  const repair = await waitForPublishedSet(artifacts, options)
  await inBatches(repair, (artifact) => submitPackageOnce(artifact, tag, options, "repair"))
  const unresolved = repair.length > 0 ? await waitForPublishedSet(artifacts, options) : []
  if (unresolved.length > 0) {
    throw new Error(
      `${label} remains incomplete after one repair round: ${unresolved.map((item) => item.name).join(", ")}`,
    )
  }
  return repair
}

function exactReleaseArtifacts(inputs: PackedPackage[]) {
  const expected = releasePackageNames()
  const names = inputs.map((input) => input.name)
  const versions = new Set(inputs.map((input) => input.version))
  if (
    inputs.length !== expected.length ||
    new Set(names).size !== names.length ||
    expected.some((name) => !names.includes(name))
  ) {
    throw new Error(`Expected the exact ${expected.length}-package npm release set`)
  }
  if (versions.size !== 1) throw new Error("Every npm release artifact must have the same version")
  const byName = new Map(inputs.map((input) => [input.name, input]))
  return releasePromotionNames().map((name) => byName.get(name)!)
}

/** Fail closed before building a replacement artifact set. Once even one
 * package for a version exists, only the cached source/version/integrity
 * manifest can prove that a resume is byte-identical. */
export async function assertReleaseVersionUnoccupied(version: string, options: NpmCommandOptions = {}) {
  const names = releasePackageNames()
  const results = await Promise.allSettled(names.map((name) => registryVersionIntegrity(name, version, options)))
  const present: string[] = []
  const failures: unknown[] = []
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failures.push(new Error(`Could not inspect ${names[index]}@${version}`, { cause: result.reason }))
    } else if (result.value) {
      present.push(names[index])
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Cannot prove that the npm test version is unoccupied")
  }
  if (present.length > 0) {
    throw new Error(
      `Immutable npm artifact cache is missing, but ${present.length}/${names.length} packages already exist for ${version}: ${present.join(", ")}`,
    )
  }
}

export async function verifyReleaseOptionalDependencies(artifacts: PackedPackage[], options: NpmCommandOptions = {}) {
  const ordered = exactReleaseArtifacts(artifacts)
  const version = ordered[0].version
  const result = await run(["view", `${cli.name}@${version}`, "optionalDependencies", "--json"], options)
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect ${cli.name}@${version} optional dependencies: ${failure(result)}`)
  }
  const value = JSON.parse(result.stdout || "{}") as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`npm returned invalid optional dependencies for ${cli.name}@${version}`)
  }
  const actual = value as Record<string, unknown>
  const expected = nativeReleasePackageNames()
  const unexpectedNative = Object.keys(actual).filter(
    (name) => name.startsWith(`${cli.name}-`) && !expected.includes(name),
  )
  const invalid = expected.filter((name) => actual[name] !== version)
  if (invalid.length > 0 || unexpectedNative.length > 0 || "@synsci/atlas" in actual) {
    throw new Error(
      `${cli.name}@${version} optional dependency matrix is invalid` +
        `${invalid.length ? `; wrong or missing: ${invalid.join(", ")}` : ""}` +
        `${unexpectedNative.length ? `; unexpected: ${unexpectedNative.join(", ")}` : ""}`,
    )
  }
  return expected
}

/** Publish under an isolated per-version candidate tag. Every missing package
 * gets one initial submission and, after a full visibility window, at most one
 * repair submission from the same cached tgz. */
export async function stageCandidateRelease(artifacts: PackedPackage[], options: NpmCommandOptions = {}) {
  const ordered = exactReleaseArtifacts(artifacts)
  const version = ordered[0].version
  const tag = releaseCandidateTag(version)
  const inspected = await Promise.all(ordered.map((artifact) => inspectPublishedPackage(artifact, options)))
  const absent = ordered.filter((_, index) => !inspected[index])

  await inBatches(absent, (artifact) => submitPackageOnce(artifact, tag, options, "initial"))
  await repairSubmittedRelease(ordered, tag, "npm candidate", options)

  await verifyPublishedPackageIntegrities(ordered, options)
  await verifyReleaseOptionalDependencies(ordered, options)
  await ensureReleaseStagingTags(ordered, tag, options)
  return { tag, version }
}

/** Stable staging may receive a successful npm response without the version
 * becoming visible. After one complete registry visibility window, resubmit
 * only genuinely absent packages from their already-validated cached tgz,
 * once, under the isolated per-version tag. */
export async function repairStagedRelease(artifacts: PackedPackage[], options: NpmCommandOptions = {}) {
  const ordered = exactReleaseArtifacts(artifacts)
  const version = ordered[0].version
  const tag = releaseStagingTag(version)
  const repaired = await repairSubmittedRelease(ordered, tag, "npm release", options)
  return { repaired: repaired.map((artifact) => artifact.name), tag, version }
}

export async function publishPackage(
  input: PackedPackage & { deferVerification?: boolean; tag: string },
  options: NpmCommandOptions = {},
): Promise<"published" | "verified"> {
  const errors: unknown[] = []
  for (const attempt of publishAttempts) {
    try {
      const remote = await registryIntegrity(input, options)
      if (remote) {
        const match = await assertEquivalent(input, remote, options)
        console.log(`  verified ${input.name}@${input.version}; identical ${match} already exist on npm`)
        return "verified"
      }
    } catch (error) {
      if (error instanceof NpmArtifactConflict) throw error
      errors.push(error)
    }

    const result = await run(["publish", input.file, "--access", "public", "--tag", input.tag], options)
    if (result.exitCode === 0) {
      if (!input.deferVerification) await verifyPublishedPackage(input, options)
      const status = input.deferVerification ? "submitted" : "published"
      console.log(`  ${status} ${input.name}@${input.version} under ${input.tag}`)
      return "published"
    }

    const detail = `${result.stdout}\n${result.stderr}`
    errors.push(new Error(failure(result)))
    if (isAlreadyPublished(detail)) {
      try {
        await verifyPublishedPackage(input, options)
        console.log(`  verified ${input.name}@${input.version} after npm reported an existing version`)
        return "verified"
      } catch (error) {
        if (error instanceof NpmArtifactConflict) throw error
        errors.push(error)
      }
    } else if (isPermissionFailure(detail)) {
      throw new NpmPermissionError(`npm refused ${input.name}@${input.version}: ${failure(result)}`)
    }

    if (attempt < publishAttempts.length) {
      console.warn(`  retry ${input.name} (attempt ${attempt})`)
      await Bun.sleep(retryDelay(options))
    }
  }
  throw errors.at(-1)
}

async function distTags(name: string, options: NpmCommandOptions) {
  const result = await run(["view", name, "dist-tags", "--json"], options)
  if (result.exitCode !== 0) throw new Error(`Could not inspect npm dist-tags for ${name}: ${failure(result)}`)
  const value = JSON.parse(result.stdout) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`npm returned invalid dist-tags for ${name}`)
  }
  return value as Record<string, string>
}

async function addDistTag(name: string, version: string, tag: string, options: NpmCommandOptions) {
  const before = await distTags(name, options)
  if (before[tag] === version) return false
  const result = await run(["dist-tag", "add", `${name}@${version}`, tag], options)
  for (let attempt = 1; attempt <= visibilityAttempts(options); attempt++) {
    const after = await distTags(name, options)
    if (after[tag] === version) return true
    if (attempt < visibilityAttempts(options)) await Bun.sleep(visibilityRetryDelay(options))
  }
  throw new Error(`Could not set ${name}'s ${tag} dist-tag to ${version}: ${failure(result)}`)
}

async function removeDistTag(name: string, tag: string, options: NpmCommandOptions) {
  const result = await run(["dist-tag", "rm", name, tag], options)
  for (let attempt = 1; attempt <= visibilityAttempts(options); attempt++) {
    const after = await distTags(name, options)
    if (!(tag in after)) return
    if (attempt < visibilityAttempts(options)) await Bun.sleep(visibilityRetryDelay(options))
  }
  throw new Error(`Could not remove ${name}'s ${tag} dist-tag: ${failure(result)}`)
}

/** Read every package's dist-tags and reject any conflict before a single
 * tag is written; reads and writes both run in bounded batches. */
export async function ensureReleaseStagingTags(
  artifacts: PackedPackage[],
  tag: string,
  options: NpmCommandOptions = {},
) {
  const current = await inBatches(artifacts, (artifact) => distTags(artifact.name, options))
  for (const [index, artifact] of artifacts.entries()) {
    const existing = current[index][tag]
    if (existing && existing !== artifact.version) {
      throw new Error(`${artifact.name}'s ${tag} dist-tag already points to ${existing}, not ${artifact.version}`)
    }
  }
  await inBatches(artifacts, (artifact) => addDistTag(artifact.name, artifact.version, tag, options))
}

export async function verifyReleaseTags(artifacts: PackedPackage[], tag: string, options: NpmCommandOptions = {}) {
  const ordered = exactReleaseArtifacts(artifacts)
  const current = await inBatches(ordered, (artifact) => distTags(artifact.name, options))
  const failures = ordered.flatMap((artifact, index) =>
    current[index][tag] === artifact.version ? [] : [`${artifact.name}=${current[index][tag] ?? "unset"}`],
  )
  if (failures.length > 0) {
    throw new Error(`npm ${tag} snapshot does not match the candidate: ${failures.join(", ")}`)
  }
}

export async function promoteReleaseToTag(artifacts: PackedPackage[], tag: string, options: NpmCommandOptions = {}) {
  if (!/^[a-z][a-z0-9._-]*$/i.test(tag)) throw new Error(`Invalid npm promotion tag: ${tag}`)
  const ordered = exactReleaseArtifacts(artifacts)
  const snapshot = await inBatches(
    ordered,
    async (artifact) => [artifact.name, (await distTags(artifact.name, options))[tag]] as const,
  )
  const previous = new Map(snapshot)
  const native = new Set(nativeReleasePackageNames())
  const parallel = ordered.filter((artifact) => native.has(artifact.name))
  const serial = ordered.filter((artifact) => !native.has(artifact.name))
  const promote = async (artifact: PackedPackage) => {
    if (previous.get(artifact.name) === artifact.version) return
    await addDistTag(artifact.name, artifact.version, tag, options)
    console.log(`  promoted ${artifact.name}@${artifact.version} to ${tag}`)
  }
  try {
    // Native platform packages have no dependents; they move in bounded
    // batches for every tag. inBatches drains each batch before rethrowing so
    // no late tag write can undo the rollback below.
    await inBatches(parallel, promote)
    // SDK, plugin, CLI, then launcher retain their dependency/public-entry order.
    for (const artifact of serial) await promote(artifact)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const artifact of [...ordered].reverse()) {
      try {
        const prior = previous.get(artifact.name)
        if (prior) await addDistTag(artifact.name, prior, tag, options)
        else await removeDistTag(artifact.name, tag, options)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `npm ${tag} promotion failed and rollback was incomplete`)
    }
    throw error
  }
}

export async function promoteRelease(artifacts: PackedPackage[], options: NpmCommandOptions = {}) {
  await promoteReleaseToTag(artifacts, "latest", options)
}

if (import.meta.main) {
  if (process.argv[2] !== "preflight") throw new Error("Usage: npm-release.ts preflight")
  await preflightRelease()
}
