import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import os from "os"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import {
  NpmArtifactConflict,
  NpmPermissionError,
  assertReleaseVersionUnoccupied,
  createCompiledPackageManifest,
  loadReleaseArtifacts,
  packPackage,
  preflightRelease,
  promoteRelease,
  promoteReleaseToTag,
  publishPackage,
  releasePackageNames,
  releaseCandidateTag,
  releasePromotionNames,
  releaseStagingTag,
  saveReleaseArtifacts,
  sanitizeNpmDiagnostic,
  stageCandidateRelease,
  ensureReleaseStagingTags,
  verifyPackedModuleExports,
  verifyPublishedPackageIntegrities,
  verifyPublishedPackages,
  verifyReleaseOptionalDependencies,
  verifyReleaseTags,
  type NpmCommandOptions,
  type PackedPackage,
} from "../../../../tooling/repo/npm-release"
import { releaseRoot } from "../../../../tooling/repo/release-workspace"

type FakeState = {
  diff?: string
  failTagReadAfterAdd?: string
  identity: string
  optionalDependencies?: Record<string, Record<string, string>>
  owners: string[]
  packages: Record<string, { integrity: string; visibilityReads?: number }>
  publishCalls: number
  publishFailures?: Record<string, number>
  publishGhosts?: Record<string, number>
  publishIntegrities?: string[]
  publishMaxInflight?: number
  publishMode?: "already" | "ghost" | "permission" | "success"
  publishSpecs?: string[]
  publishVisibilityReads?: number
  tagAdds?: string[]
  tags: Record<string, Record<string, string>>
}

const fake = path.join(import.meta.dir, "fixtures/fake-npm.ts")
const roots: string[] = []
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openscience-npm-release-test-"))
  roots.push(root)
})

afterEach(async () => {
  const target = roots.pop()
  if (target) await rm(target, { recursive: true, force: true })
})

async function fixturePackage(name = "@synsci/release-fixture", version = "2.0.32") {
  const directory = path.join(root, name.replaceAll("/", "-").replace("@", ""))
  await mkdir(directory, { recursive: true })
  await Bun.write(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, version, files: ["index.js"] }, null, 2)}\n`,
  )
  await Bun.write(path.join(directory, "index.js"), "export const release = true\n")
  return await packPackage({ cwd: directory, name, version })
}

async function stateFile(input: Partial<FakeState> = {}) {
  const file = path.join(root, "npm-state.json")
  const state: FakeState = {
    identity: "publisher",
    owners: ["publisher"],
    packages: {},
    publishCalls: 0,
    tags: {},
    ...input,
  }
  await Bun.write(file, `${JSON.stringify(state, null, 2)}\n`)
  return file
}

function options(file: string, spec?: string): NpmCommandOptions {
  return {
    command: [process.execPath, fake],
    env: {
      FAKE_NPM_SPEC: spec,
      FAKE_NPM_STATE: file,
      OPENSCIENCE_NPM_RETRY_MS: "0",
      OPENSCIENCE_NPM_VISIBILITY_RETRY_MS: "0",
    },
  }
}

function fastOptions(file: string): NpmCommandOptions {
  return {
    ...options(file),
    env: {
      ...options(file).env,
      OPENSCIENCE_NPM_VISIBILITY_ATTEMPTS: "1",
    },
  }
}

async function readState(file: string) {
  return (await Bun.file(file).json()) as FakeState
}

// A single local registry observes how many dist-tag writes and reads
// overlap. The shared-file fixture serializes its own mutations behind a lock
// but cannot see overlap, so concurrency assertions use this server instead.
async function tagRegistry(file: string) {
  const state = await readState(file)
  const failure = state.failTagReadAfterAdd
  const failed = new Set<string>()
  const activity = { current: 0, maximum: 0, rollbackWhileActive: false, reads: { current: 0, maximum: 0 } }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const args = (await request.json()) as string[]
      if (args[0] === "view" && args[2] === "dist-tags") {
        if (failed.delete(args[1])) return Response.json({ exitCode: 1, stderr: "transient dist-tag read failure" })
        activity.reads.current++
        activity.reads.maximum = Math.max(activity.reads.maximum, activity.reads.current)
        // Hold the read long enough for sibling processes to overlap it.
        await Bun.sleep(40)
        activity.reads.current--
        return Response.json({ exitCode: 0, stdout: JSON.stringify(state.tags[args[1]] ?? {}) })
      }
      if (args[0] === "dist-tag" && args[1] === "add") {
        const split = args[2].lastIndexOf("@")
        const name = args[2].slice(0, split)
        const version = args[2].slice(split + 1)
        if (version === "2.0.32") {
          activity.current++
          activity.maximum = Math.max(activity.maximum, activity.current)
          // Make a failed verification beat a sibling's pending write, proving
          // rollback waits for the entire batch rather than just its rejection.
          await Bun.sleep(failure ? (name === failure ? 10 : 120) : 60)
          activity.current--
          if (name === failure) failed.add(name)
        } else if (activity.current) activity.rollbackWhileActive = true
        state.tags[name] ??= {}
        state.tags[name][args[3]] = version
        state.tagAdds ??= []
        state.tagAdds.push(`${name}@${version}:${args[3]}`)
        return Response.json({ exitCode: 0 })
      }
      if (args[0] === "dist-tag" && args[1] === "rm") {
        if (activity.current) activity.rollbackWhileActive = true
        delete state.tags[args[2]]?.[args[3]]
        return Response.json({ exitCode: 0 })
      }
      return Response.json({ exitCode: 1, stderr: "unsupported registry command" })
    },
  })
  const command = path.join(root, "npm-tags.ts")
  await Bun.write(
    command,
    `const response = await fetch(process.env.FAKE_NPM_REGISTRY!, {
      method: "POST", body: JSON.stringify(process.argv.slice(2))
    });
    const result = await response.json();
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.exitCode);`,
  )
  return {
    state,
    activity,
    options: {
      ...fastOptions(file),
      command: [process.execPath, command],
      env: { ...fastOptions(file).env, FAKE_NPM_REGISTRY: server.url.toString() },
    },
    async [Symbol.asyncDispose]() {
      server.stop(true)
    },
  }
}

test("packPackage uses Bun's supported destination-only form and inspects the real tarball", async () => {
  const artifact = await fixturePackage()

  expect(await Bun.file(artifact.file).exists()).toBe(true)
  expect(artifact.name).toBe("@synsci/release-fixture")
  expect(artifact.version).toBe("2.0.32")
  expect(artifact.integrity).toMatch(/^sha512-/)
})

test("compiled SDK manifests match the emitted dist/src layout and restore the exact source", async () => {
  const directory = path.join(root, "compiled-sdk")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, "package.json")
  const original = `${JSON.stringify(
    {
      name: "@synsci/compiled-fixture",
      version: "2.0.31",
      files: ["dist"],
      exports: { ".": "./src/index.ts" },
    },
    null,
    2,
  )}\n`
  await Bun.write(file, original)
  await mkdir(path.join(directory, "dist/src"), { recursive: true })
  await Bun.write(path.join(directory, "dist/src/index.js"), "export const version = true\n")
  await Bun.write(path.join(directory, "dist/src/index.d.ts"), "export declare const version: boolean\n")

  const pkg = createCompiledPackageManifest(original, "2.0.32-test.98.1", { preserveSourceDirectory: true })
  await Bun.write(file, `${JSON.stringify(pkg, null, 2)}\n`)
  try {
    const artifact = await packPackage({ cwd: directory, name: pkg.name, version: pkg.version })
    expect(artifact.name).toBe("@synsci/compiled-fixture")
    expect(artifact.version).toBe("2.0.32-test.98.1")
    expect(pkg.exports).toEqual({ ".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" } })
    const entries = await Bun.$`tar -tzf ${artifact.file}`.text()
    expect(entries).toContain("package/dist/src/index.js")
  } finally {
    await Bun.write(file, original)
  }
  expect(await Bun.file(file).text()).toBe(original)
})

test("compiled plugin manifests match the flat dist layout", async () => {
  const directory = path.join(root, "compiled-plugin")
  await mkdir(path.join(directory, "dist"), { recursive: true })
  const file = path.join(directory, "package.json")
  const original = `${JSON.stringify(
    {
      name: "@synsci/plugin-fixture",
      version: "2.0.31",
      files: ["dist"],
      exports: { ".": "./src/index.ts" },
    },
    null,
    2,
  )}\n`
  await Bun.write(file, original)
  await Bun.write(path.join(directory, "dist/index.js"), "export const version = true\n")
  await Bun.write(path.join(directory, "dist/index.d.ts"), "export declare const version: boolean\n")

  const pkg = createCompiledPackageManifest(original, "2.0.32-test.98.1")
  await Bun.write(file, `${JSON.stringify(pkg, null, 2)}\n`)
  try {
    const artifact = await packPackage({ cwd: directory, name: pkg.name, version: pkg.version })
    expect(pkg.exports).toEqual({ ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } })
    const entries = await Bun.$`tar -tzf ${artifact.file}`.text()
    expect(entries).toContain("package/dist/index.js")
  } finally {
    await Bun.write(file, original)
  }
  expect(await Bun.file(file).text()).toBe(original)
})

test("packed SDK and plugin exports must load in Node before publication", async () => {
  const version = "2.0.32-test.98.1"
  const sdkDirectory = path.join(root, "node-sdk")
  await mkdir(path.join(sdkDirectory, "dist/src"), { recursive: true })
  await Bun.write(
    path.join(sdkDirectory, "package.json"),
    `${JSON.stringify({
      name: "@synsci/sdk",
      version,
      type: "module",
      files: ["dist"],
      exports: { ".": { import: "./dist/src/index.js" } },
    })}\n`,
  )
  await Bun.write(path.join(sdkDirectory, "dist/src/index.js"), "export const sdk = true\n")

  const pluginDirectory = path.join(root, "node-plugin")
  await mkdir(path.join(pluginDirectory, "dist"), { recursive: true })
  await Bun.write(
    path.join(pluginDirectory, "package.json"),
    `${JSON.stringify({
      name: "@synsci/plugin",
      version,
      type: "module",
      files: ["dist"],
      exports: {
        ".": { import: "./dist/index.js" },
        "./tool": { import: "./dist/tool.js" },
      },
    })}\n`,
  )
  await Bun.write(path.join(pluginDirectory, "dist/tool.js"), "export const tool = true\n")
  const sdkArtifact = await packPackage({ cwd: sdkDirectory, name: "@synsci/sdk", version })

  await Bun.write(path.join(pluginDirectory, "dist/index.js"), 'export * from "./tool"\n')
  const broken = await packPackage({ cwd: pluginDirectory, name: "@synsci/plugin", version })
  await expect(verifyPackedModuleExports([sdkArtifact, broken])).rejects.toThrow("do not load in Node")

  await Bun.write(path.join(pluginDirectory, "dist/index.js"), 'export * from "./tool.js"\n')
  const pluginArtifact = await packPackage({ cwd: pluginDirectory, name: "@synsci/plugin", version })
  expect(await verifyPackedModuleExports([sdkArtifact, pluginArtifact])).toEqual([
    "@synsci/sdk",
    "@synsci/plugin",
    "@synsci/plugin/tool",
  ])
})

test("preflight authenticates and proves ownership of all 15 packages before mutation", async () => {
  const file = await stateFile()
  const result = await preflightRelease(options(file))

  expect(result.identity).toBe("publisher")
  expect(result.packages).toEqual(releasePackageNames())
  expect(result.packages).toHaveLength(15)

  await Bun.write(file, `${JSON.stringify({ ...(await readState(file)), owners: ["somebody-else"] }, null, 2)}\n`)
  await expect(preflightRelease(options(file))).rejects.toThrow("not an owner of every release package")
  expect((await readState(file)).publishCalls).toBe(0)
})

test("release artifacts persist exact packed bytes and reject a different source", async () => {
  const artifacts: PackedPackage[] = []
  for (const name of releasePackageNames()) artifacts.push(await fixturePackage(name))
  const directory = path.join(root, "artifacts")
  const source = "a".repeat(40)

  await saveReleaseArtifacts({ artifacts, directory, source, version: "2.0.32" })
  const loaded = await loadReleaseArtifacts({ directory, source, version: "2.0.32" })

  expect(loaded.map((artifact) => artifact.name).sort()).toEqual(releasePackageNames().sort())
  expect(loaded.map((artifact) => artifact.integrity).sort()).toEqual(
    artifacts.map((artifact) => artifact.integrity).sort(),
  )
  await expect(loadReleaseArtifacts({ directory, source: "b".repeat(40), version: "2.0.32" })).rejects.toThrow("pinned")

  const manifestFile = path.join(directory, "manifest.json")
  const manifest = await Bun.file(manifestFile).json()
  manifest.artifacts[0].version = "9.9.9"
  await Bun.write(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  await expect(loadReleaseArtifacts({ directory, source, version: "2.0.32" })).rejects.toThrow("expected 2.0.32")
})

test("stage-only repairs one accepted-but-absent package once without promoting latest", async () => {
  const artifacts: PackedPackage[] = []
  for (const name of releasePackageNames()) artifacts.push(await fixturePackage(name))
  const source = (await Bun.$`git rev-parse HEAD`.cwd(releaseRoot).text()).trim()
  const directory = path.join(root, "artifacts")
  await saveReleaseArtifacts({ artifacts, directory, source, version: "2.0.32" })
  const file = await stateFile({
    packages: Object.fromEntries(
      artifacts.slice(1).map((artifact) => [`${artifact.name}@${artifact.version}`, { integrity: artifact.integrity }]),
    ),
    publishGhosts: { [`${artifacts[0].name}@2.0.32`]: 1 },
    tags: Object.fromEntries(artifacts.map((artifact) => [artifact.name, { latest: "2.0.31" }])),
  })
  const command = path.join(root, "npm-fixture")
  await Bun.write(command, `#!${process.execPath}\nawait import(${JSON.stringify(fake)})\n`)
  await chmod(command, 0o755)
  const run = async () => {
    const proc = Bun.spawn([process.execPath, path.join(releaseRoot, "tooling/repo/publish.ts"), "--stage-only"], {
      cwd: releaseRoot,
      env: {
        ...Bun.env,
        ...fastOptions(file).env,
        OPENSCIENCE_CHANNEL: "latest",
        OPENSCIENCE_VERSION: "2.0.32",
        // Never authorize Git/GitHub writes, even if the stage-only exit regresses.
        OPENSCIENCE_RELEASE: "",
        OPENSCIENCE_RELEASE_SOURCE: source,
        OPENSCIENCE_ARTIFACT_SOURCE: source,
        OPENSCIENCE_NPM_ARTIFACT_DIR: directory,
        OPENSCIENCE_NPM_COMMAND: command,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("staging complete; latest tags and the GitHub draft are unchanged")
    expect(stdout).not.toContain("promoting npm latest")
  }
  await run()
  const state = await readState(file)
  expect(state.publishCalls).toBe(2)
  expect(state.publishSpecs).toEqual([`${artifacts[0].name}@2.0.32`, `${artifacts[0].name}@2.0.32`])
  expect(state.publishIntegrities).toEqual([artifacts[0].integrity, artifacts[0].integrity])
  for (const artifact of artifacts) {
    expect(state.packages[`${artifact.name}@2.0.32`].integrity).toBe(artifact.integrity)
    expect(state.tags[artifact.name]).toEqual({ latest: "2.0.31", [releaseStagingTag("2.0.32")]: "2.0.32" })
  }

  await run()
  expect((await readState(file)).publishCalls).toBe(2)
}, 30_000)

test("a missing artifact cache fails closed when any package version already exists", async () => {
  const version = "2.0.32-test.12345"
  const occupied = `${releasePackageNames()[0]}@${version}`
  const file = await stateFile({ packages: { [occupied]: { integrity: "sha512-existing" } } })

  await expect(assertReleaseVersionUnoccupied(version, options(file))).rejects.toThrow(
    "Immutable npm artifact cache is missing",
  )
  expect((await readState(file)).publishCalls).toBe(0)

  const empty = await stateFile()
  await assertReleaseVersionUnoccupied(version, options(empty))
})

test("test candidate tags cannot collide across distinct valid versions", () => {
  const versions = ["2.0.32-test.a.b", "2.0.32-test.a-b", "2.0.32-test.A-B"]
  expect(new Set(versions.map(releaseCandidateTag)).size).toBe(versions.length)
})

test("test candidates use one repair round for only absent immutable artifacts", async () => {
  const version = "2.0.32-test.12345"
  const artifacts: PackedPackage[] = []
  for (const name of releasePackageNames()) artifacts.push(await fixturePackage(name, version))
  const repairName = "@synsci/sdk"
  const native = releasePackageNames().filter((name) => name.startsWith("@synsci/openscience-"))
  const optionalDependencies = Object.fromEntries(native.map((name) => [name, version]))
  const file = await stateFile({
    optionalDependencies: { [`@synsci/openscience@${version}`]: optionalDependencies },
    publishFailures: { [`${repairName}@${version}`]: 1 },
  })

  const result = await stageCandidateRelease(artifacts, fastOptions(file))

  expect(result).toEqual({ tag: releaseCandidateTag(version), version })
  const state = await readState(file)
  expect(state.publishCalls).toBe(16)
  expect(state.publishSpecs?.filter((spec) => spec === `${repairName}@${version}`)).toHaveLength(2)
  for (const name of releasePackageNames()) {
    expect(state.tags[name][releaseCandidateTag(version)]).toBe(version)
  }
  expect(await verifyReleaseOptionalDependencies(artifacts, options(file))).toHaveLength(11)

  const unrepaired = await stateFile({
    optionalDependencies: { [`@synsci/openscience@${version}`]: optionalDependencies },
    publishFailures: { [`${repairName}@${version}`]: 2 },
  })
  await expect(stageCandidateRelease(artifacts, fastOptions(unrepaired))).rejects.toThrow(
    "remains incomplete after one repair round",
  )
  expect(
    (await readState(unrepaired)).publishSpecs?.filter((spec) => spec === `${repairName}@${version}`),
  ).toHaveLength(2)

  const ghostPackages = Object.fromEntries(
    artifacts
      .filter((artifact) => artifact.name !== repairName)
      .map((artifact) => [`${artifact.name}@${version}`, { integrity: artifact.integrity }]),
  )
  const previousTags = Object.fromEntries(releasePackageNames().map((name) => [name, { test: "2.0.31-test.safe" }]))
  const acknowledgedButMissing = await stateFile({
    optionalDependencies: { [`@synsci/openscience@${version}`]: optionalDependencies },
    packages: ghostPackages,
    publishMode: "ghost",
    tags: previousTags,
  })
  await expect(stageCandidateRelease(artifacts, fastOptions(acknowledgedButMissing))).rejects.toThrow(
    "remains incomplete after one repair round",
  )
  const ghostState = await readState(acknowledgedButMissing)
  expect(ghostState.publishCalls).toBe(2)
  for (const name of releasePackageNames()) expect(ghostState.tags[name].test).toBe("2.0.31-test.safe")
})

test("npm diagnostics redact configured and recognizable credentials", () => {
  const configured = "npm_configured_secret_123456789"
  const diagnostic = [
    `NODE_AUTH_TOKEN=${configured}`,
    "npm token npm_abcdefghijklmnopqrstuvwxyz012345",
    "https://publisher:password@registry.npmjs.org/package",
  ].join("\n")

  const sanitized = sanitizeNpmDiagnostic(diagnostic, { NODE_AUTH_TOKEN: configured })
  expect(sanitized).not.toContain(configured)
  expect(sanitized).not.toContain("password")
  expect(sanitized).not.toContain("npm_abcdefghijklmnopqrstuvwxyz012345")
})

test("publish resumes missing, byte-identical, and content-equivalent artifacts without overwriting conflicts", async () => {
  const artifact = await fixturePackage()
  const spec = `${artifact.name}@${artifact.version}`
  const file = await stateFile({ publishMode: "success" })

  expect(await publishPackage({ ...artifact, tag: "release-2-0-32" }, options(file, spec))).toBe("published")
  expect((await readState(file)).publishCalls).toBe(1)
  expect(await publishPackage({ ...artifact, tag: "release-2-0-32" }, options(file, spec))).toBe("verified")
  expect((await readState(file)).publishCalls).toBe(1)

  await Bun.write(
    file,
    `${JSON.stringify(
      { ...(await readState(file)), diff: "", packages: { [spec]: { integrity: "sha512-different-archive" } } },
      null,
      2,
    )}\n`,
  )
  expect(await publishPackage({ ...artifact, tag: "release-2-0-32" }, options(file, spec))).toBe("verified")

  await Bun.write(file, `${JSON.stringify({ ...(await readState(file)), diff: "index.js" }, null, 2)}\n`)
  await expect(publishPackage({ ...artifact, tag: "release-2-0-32" }, options(file, spec))).rejects.toBeInstanceOf(
    NpmArtifactConflict,
  )
  expect((await readState(file)).publishCalls).toBe(1)
})

test("candidate verification requires the registry integrity from the immutable manifest", async () => {
  const artifact = await fixturePackage()
  const spec = `${artifact.name}@${artifact.version}`
  const exact = await stateFile({ packages: { [spec]: { integrity: artifact.integrity } } })
  await verifyPublishedPackageIntegrities([artifact], fastOptions(exact))

  const repacked = await stateFile({ diff: "", packages: { [spec]: { integrity: "sha512-repacked" } } })
  await expect(verifyPublishedPackageIntegrities([artifact], fastOptions(repacked))).rejects.toBeInstanceOf(
    NpmArtifactConflict,
  )
})

test("successful and existing publishes outwait the short publish retry window", async () => {
  const artifact = await fixturePackage()
  const spec = `${artifact.name}@${artifact.version}`
  const delayed = await stateFile({ publishMode: "success", publishVisibilityReads: 7 })

  expect(await publishPackage({ ...artifact, tag: "release-2-0-32" }, options(delayed, spec))).toBe("published")
  expect((await readState(delayed)).publishCalls).toBe(1)

  const existing = await stateFile({ publishMode: "already", publishVisibilityReads: 7 })
  expect(await publishPackage({ ...artifact, tag: "release-2-0-32" }, options(existing, spec))).toBe("verified")
  expect((await readState(existing)).publishCalls).toBe(1)
})

test("deferred publishes verify the complete set concurrently after every upload", async () => {
  const first = await fixturePackage("@synsci/release-first")
  const second = await fixturePackage("@synsci/release-second")
  const firstSpec = `${first.name}@${first.version}`
  const secondSpec = `${second.name}@${second.version}`
  const file = await stateFile({ publishMode: "success" })

  await publishPackage({ ...first, deferVerification: true, tag: "release-2-0-32" }, options(file, firstSpec))
  await publishPackage({ ...second, deferVerification: true, tag: "release-2-0-32" }, options(file, secondSpec))

  const state = await readState(file)
  expect(state.publishCalls).toBe(2)
  expect(state.packages[firstSpec]).toBeDefined()
  expect(state.packages[secondSpec]).toBeDefined()
  await verifyPublishedPackages([first, second], options(file))
})

test("genuine owner E403 fails immediately", async () => {
  const artifact = await fixturePackage()

  const denied = await stateFile({ publishMode: "permission" })
  await expect(
    publishPackage({ ...artifact, tag: "release-2-0-32" }, options(denied, `${artifact.name}@${artifact.version}`)),
  ).rejects.toBeInstanceOf(NpmPermissionError)
  expect((await readState(denied)).publishCalls).toBe(1)
})

test("latest promotion runs at most five platforms together and keeps dependencies and launcher last", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tags = Object.fromEntries(artifacts.map((artifact) => [artifact.name, { latest: "2.0.31" }]))
  const file = await stateFile({ tags })
  await using registry = await tagRegistry(file)

  await promoteRelease(artifacts, registry.options)

  const state = registry.state
  const expected = releasePromotionNames().map((name) => `${name}@2.0.32:latest`)
  expect(state.tagAdds?.toSorted()).toEqual(expected.toSorted())
  expect(state.tagAdds?.slice(-4)).toEqual(expected.slice(-4))
  expect(state.tagAdds?.at(-1)).toBe("synsci@2.0.32:latest")
  expect(registry.activity.maximum).toBeGreaterThan(1)
  expect(registry.activity.maximum).toBeLessThanOrEqual(5)
  for (const name of releasePackageNames()) expect(state.tags[name].latest).toBe("2.0.32")
})

test("test promotion batches platforms, keeps dependencies and launcher last, and leaves latest alone", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tags = Object.fromEntries(
    artifacts.map((artifact) => [artifact.name, { latest: "2.0.31", test: "2.0.30-test.1" }]),
  )
  const file = await stateFile({ tags })
  await using registry = await tagRegistry(file)

  await promoteReleaseToTag(artifacts, "test", registry.options)

  const state = registry.state
  const expected = releasePromotionNames().map((name) => `${name}@2.0.32:test`)
  expect(state.tagAdds?.toSorted()).toEqual(expected.toSorted())
  expect(state.tagAdds?.slice(-4)).toEqual(expected.slice(-4))
  expect(state.tagAdds?.at(-1)).toBe("synsci@2.0.32:test")
  expect(registry.activity.maximum).toBeGreaterThan(1)
  expect(registry.activity.maximum).toBeLessThanOrEqual(5)
  expect(registry.activity.reads.maximum).toBeGreaterThan(1)
  expect(registry.activity.reads.maximum).toBeLessThanOrEqual(5)
  for (const name of releasePackageNames()) {
    expect(state.tags[name].test).toBe("2.0.32")
    expect(state.tags[name].latest).toBe("2.0.31")
  }
})

test("promotion rolls the full snapshot back when mutation succeeds but verification read fails", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tags = Object.fromEntries(artifacts.map((artifact) => [artifact.name, { latest: "2.0.31" }]))
  const first = releasePromotionNames()[0]
  const file = await stateFile({ failTagReadAfterAdd: first, tags })
  await using registry = await tagRegistry(file)

  await expect(promoteRelease(artifacts, registry.options)).rejects.toThrow("transient dist-tag read failure")

  const restored = registry.state
  for (const name of releasePackageNames()) expect(restored.tags[name].latest).toBe("2.0.31")
  expect(registry.activity.current).toBe(0)
  expect(registry.activity.rollbackWhileActive).toBe(false)
  expect(restored.tagAdds?.filter((value) => value.endsWith("@2.0.32:latest")).toSorted()).toEqual(
    releasePromotionNames()
      .slice(0, 5)
      .map((name) => `${name}@2.0.32:latest`)
      .toSorted(),
  )
})

test("parallel promotion failure removes newly created tags only after pending writes settle", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const file = await stateFile({ failTagReadAfterAdd: releasePromotionNames()[0] })
  await using registry = await tagRegistry(file)

  await expect(promoteRelease(artifacts, registry.options)).rejects.toThrow("transient dist-tag read failure")

  expect(registry.activity.current).toBe(0)
  expect(registry.activity.rollbackWhileActive).toBe(false)
  for (const name of releasePackageNames()) expect(registry.state.tags[name]?.latest).toBeUndefined()
})

test("test promotion rolls the full snapshot back on a verified tag-write failure", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tags = Object.fromEntries(artifacts.map((artifact) => [artifact.name, { test: "2.0.30-test.1" }]))
  const first = releasePromotionNames()[0]
  const file = await stateFile({ failTagReadAfterAdd: first, tags })
  await using registry = await tagRegistry(file)

  await expect(promoteReleaseToTag(artifacts, "test", registry.options)).rejects.toThrow(
    "transient dist-tag read failure",
  )

  expect(registry.activity.current).toBe(0)
  expect(registry.activity.rollbackWhileActive).toBe(false)
  for (const name of releasePackageNames()) expect(registry.state.tags[name].test).toBe("2.0.30-test.1")
})

test("candidate staging submits absent packages in bounded parallel batches", async () => {
  const version = "2.0.32-test.777"
  const artifacts: PackedPackage[] = []
  for (const name of releasePackageNames()) artifacts.push(await fixturePackage(name, version))
  const native = releasePackageNames().filter((name) => name.startsWith("@synsci/openscience-"))
  const file = await stateFile({
    optionalDependencies: {
      [`@synsci/openscience@${version}`]: Object.fromEntries(native.map((name) => [name, version])),
    },
  })

  const result = await stageCandidateRelease(artifacts, fastOptions(file))

  expect(result).toEqual({ tag: releaseCandidateTag(version), version })
  const state = await readState(file)
  expect(state.publishCalls).toBe(15)
  expect(state.publishSpecs?.toSorted()).toEqual(artifacts.map((artifact) => `${artifact.name}@${version}`).toSorted())
  expect(state.publishMaxInflight).toBeGreaterThan(1)
  expect(state.publishMaxInflight).toBeLessThanOrEqual(5)
  for (const artifact of artifacts) {
    expect(state.packages[`${artifact.name}@${version}`].integrity).toBe(artifact.integrity)
    expect(state.tags[artifact.name][releaseCandidateTag(version)]).toBe(version)
  }
})

test("staging tags read and write in bounded batches and reject a conflict before writing", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tag = releaseStagingTag("2.0.32")
  const conflicted = releasePromotionNames().at(-1)!
  const conflict = await stateFile({ tags: { [conflicted]: { [tag]: "2.0.31" } } })
  await using blocked = await tagRegistry(conflict)

  await expect(ensureReleaseStagingTags(artifacts, tag, blocked.options)).rejects.toThrow(
    `${conflicted}'s ${tag} dist-tag already points to 2.0.31`,
  )
  expect(blocked.state.tagAdds).toBeUndefined()
  expect(blocked.activity.reads.maximum).toBeGreaterThan(1)
  expect(blocked.activity.reads.maximum).toBeLessThanOrEqual(5)

  const file = await stateFile({ tags: { [artifacts[0].name]: { [tag]: "2.0.32" } } })
  await using registry = await tagRegistry(file)

  await ensureReleaseStagingTags(artifacts, tag, registry.options)

  expect(registry.state.tagAdds?.toSorted()).toEqual(
    releasePackageNames()
      .filter((name) => name !== artifacts[0].name)
      .map((name) => `${name}@2.0.32:${tag}`)
      .toSorted(),
  )
  expect(registry.activity.maximum).toBeGreaterThan(1)
  expect(registry.activity.maximum).toBeLessThanOrEqual(5)
  expect(registry.activity.reads.maximum).toBeLessThanOrEqual(5)
  for (const name of releasePackageNames()) expect(registry.state.tags[name][tag]).toBe("2.0.32")
  registry.activity.reads.maximum = 0
  await verifyReleaseTags(artifacts, tag, registry.options)
  expect(registry.activity.reads.maximum).toBeGreaterThan(1)
  expect(registry.activity.reads.maximum).toBeLessThanOrEqual(5)
})

test("tag verification names every package whose snapshot drifted", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const [stale, unset] = releasePromotionNames()
  const tags: FakeState["tags"] = Object.fromEntries(artifacts.map((artifact) => [artifact.name, { test: "2.0.32" }]))
  tags[stale] = { test: "2.0.31" }
  tags[unset] = {}
  const file = await stateFile({ tags })

  await expect(verifyReleaseTags(artifacts, "test", options(file))).rejects.toThrow(
    `npm test snapshot does not match the candidate: ${stale}=2.0.31, ${unset}=unset`,
  )
})
