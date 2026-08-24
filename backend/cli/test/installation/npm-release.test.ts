import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import os from "os"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import {
  NpmArtifactConflict,
  NpmPermissionError,
  createCompiledPackageManifest,
  loadReleaseArtifacts,
  packPackage,
  preflightRelease,
  promoteRelease,
  publishPackage,
  releasePackageNames,
  releasePromotionNames,
  saveReleaseArtifacts,
  verifyPackedModuleExports,
  verifyPublishedPackages,
  type NpmCommandOptions,
  type PackedPackage,
} from "../../../../tooling/repo/npm-release"

type FakeState = {
  diff?: string
  failTagReadAfterAdd?: string
  identity: string
  owners: string[]
  packages: Record<string, { integrity: string; visibilityReads?: number }>
  publishCalls: number
  publishMode?: "already" | "permission" | "success"
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

async function readState(file: string) {
  return (await Bun.file(file).json()) as FakeState
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

test("latest promotion is ordered with launcher last", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tags = Object.fromEntries(artifacts.map((artifact) => [artifact.name, { latest: "2.0.31" }]))
  const file = await stateFile({ tags })

  await promoteRelease(artifacts, options(file))

  const state = await readState(file)
  expect(state.tagAdds).toEqual(releasePromotionNames().map((name) => `${name}@2.0.32:latest`))
  expect(state.tagAdds?.at(-1)).toBe("synsci@2.0.32:latest")
})

test("promotion rolls the full snapshot back when mutation succeeds but verification read fails", async () => {
  const base = await fixturePackage()
  const artifacts = releasePackageNames().map((name) => ({ ...base, name }))
  const tags = Object.fromEntries(artifacts.map((artifact) => [artifact.name, { latest: "2.0.31" }]))
  const first = releasePromotionNames()[0]
  const file = await stateFile({ failTagReadAfterAdd: first, tags })

  await expect(promoteRelease(artifacts, options(file))).rejects.toThrow("transient dist-tag read failure")

  const restored = await readState(file)
  for (const name of releasePackageNames()) expect(restored.tags[name].latest).toBe("2.0.31")
})
