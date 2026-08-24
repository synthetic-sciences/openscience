#!/usr/bin/env bun

import path from "path"
import os from "os"
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises"
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

const attempts = [1, 2, 3, 4, 5] as const

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

function failure(result: Result) {
  return (result.stderr || result.stdout).trim().slice(-2_000) || `exit ${result.exitCode}`
}

function retryDelay(options: NpmCommandOptions) {
  const value = Number(options.env?.OPENSCIENCE_NPM_RETRY_MS ?? process.env.OPENSCIENCE_NPM_RETRY_MS ?? 1_000)
  return Number.isFinite(value) && value >= 0 ? value : 1_000
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
  return JSON.parse(stdout) as { name?: string; version?: string }
}

export async function packedIntegrity(file: string) {
  const bytes = await Bun.file(file).arrayBuffer()
  const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64")
  return `sha512-${digest}`
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

async function registryIntegrity(input: PackedPackage, options: NpmCommandOptions) {
  const spec = `${input.name}@${input.version}`
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
  for (const attempt of attempts) {
    try {
      const remote = await registryIntegrity(input, options)
      if (remote) return await assertEquivalent(input, remote, options)
      errors.push(new Error(`${input.name}@${input.version} is not visible on npm`))
    } catch (error) {
      if (error instanceof NpmArtifactConflict) throw error
      errors.push(error)
    }
    if (attempt < attempts.length) await Bun.sleep(retryDelay(options))
  }
  throw errors.at(-1)
}

export async function publishPackage(
  input: PackedPackage & { tag: string },
  options: NpmCommandOptions = {},
): Promise<"published" | "verified"> {
  const errors: unknown[] = []
  for (const attempt of attempts) {
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
      await verifyPublishedPackage(input, options)
      console.log(`  published ${input.name}@${input.version} under ${input.tag}`)
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

    if (attempt < attempts.length) {
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
  const after = await distTags(name, options)
  if (after[tag] === version) return true
  throw new Error(`Could not set ${name}'s ${tag} dist-tag to ${version}: ${failure(result)}`)
}

async function removeDistTag(name: string, tag: string, options: NpmCommandOptions) {
  const result = await run(["dist-tag", "rm", name, tag], options)
  const after = await distTags(name, options)
  if (!(tag in after)) return
  throw new Error(`Could not remove ${name}'s ${tag} dist-tag: ${failure(result)}`)
}

export async function ensureReleaseStagingTags(
  artifacts: PackedPackage[],
  tag: string,
  options: NpmCommandOptions = {},
) {
  for (const artifact of artifacts) {
    const tags = await distTags(artifact.name, options)
    if (tags[tag] && tags[tag] !== artifact.version) {
      throw new Error(`${artifact.name}'s ${tag} dist-tag already points to ${tags[tag]}, not ${artifact.version}`)
    }
    await addDistTag(artifact.name, artifact.version, tag, options)
  }
}

export async function promoteRelease(artifacts: PackedPackage[], options: NpmCommandOptions = {}) {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  const ordered = releasePromotionNames().map((name) => {
    const artifact = byName.get(name)
    if (!artifact) throw new Error(`Missing release artifact for promotion: ${name}`)
    return artifact
  })
  const previous = new Map<string, string | undefined>()
  for (const artifact of ordered) previous.set(artifact.name, (await distTags(artifact.name, options)).latest)
  try {
    for (const artifact of ordered) {
      if (previous.get(artifact.name) === artifact.version) continue
      await addDistTag(artifact.name, artifact.version, "latest", options)
      console.log(`  promoted ${artifact.name}@${artifact.version} to latest`)
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const artifact of [...ordered].reverse()) {
      try {
        const prior = previous.get(artifact.name)
        if (prior) await addDistTag(artifact.name, prior, "latest", options)
        else await removeDistTag(artifact.name, "latest", options)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "npm latest promotion failed and rollback was incomplete")
    }
    throw error
  }
}

if (import.meta.main) {
  if (process.argv[2] !== "preflight") throw new Error("Usage: npm-release.ts preflight")
  await preflightRelease()
}
