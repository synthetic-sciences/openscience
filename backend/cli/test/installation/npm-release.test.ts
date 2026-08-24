import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import os from "os"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import {
  NpmArtifactConflict,
  NpmPermissionError,
  loadReleaseArtifacts,
  packPackage,
  preflightRelease,
  promoteRelease,
  publishPackage,
  releasePackageNames,
  releasePromotionNames,
  saveReleaseArtifacts,
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

test("already-published responses wait for visibility while genuine owner E403 fails immediately", async () => {
  const artifact = await fixturePackage()
  const spec = `${artifact.name}@${artifact.version}`
  const delayed = await stateFile({ publishMode: "already", publishVisibilityReads: 2 })

  expect(await publishPackage({ ...artifact, tag: "release-2-0-32" }, options(delayed, spec))).toBe("verified")
  expect((await readState(delayed)).publishCalls).toBe(1)

  const denied = await stateFile({ publishMode: "permission" })
  await expect(publishPackage({ ...artifact, tag: "release-2-0-32" }, options(denied, spec))).rejects.toBeInstanceOf(
    NpmPermissionError,
  )
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
