import { constants as FS, type Stats } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { JobBroker } from "@/compute/job-broker"
import { SessionFilesystem } from "@/session/filesystem"
import { Filesystem } from "@/util/filesystem"
import type { CapabilityManifest } from "./schema"

const Result = z
  .object({
    schema_version: z.literal(1),
    capability_id: z.string(),
    ok: z.literal(true),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict()

type ArtifactSnapshot = { bytes: Buffer; size: number; sha256: string }
type RootAnchor = { path: string; handle: FileHandle; identity: Stats }
type ValidationTestHooks = {
  afterOpen?: (target: string, relative: string) => void | Promise<void>
  afterSnapshot?: (target: string, relative: string) => void | Promise<void>
}

const validationTestHooks = { value: undefined as ValidationTestHooks | undefined }

export namespace CapabilityValidationTesting {
  /** Deterministic barriers for exercising the real descriptor-backed read path. */
  export function install(input: ValidationTestHooks) {
    if (!process.env.OPENSCIENCE_TEST_HOME) {
      throw new Error("Capability validation test hooks are disabled outside tests")
    }
    const prior = validationTestHooks.value
    validationTestHooks.value = input
    return {
      [Symbol.dispose]() {
        if (validationTestHooks.value === input) validationTestHooks.value = prior
      },
    }
  }
}

const bound = (left: JobBroker.CapabilityBinding | undefined, right: JobBroker.CapabilityBinding) =>
  Boolean(
    left &&
    left.id === right.id &&
    left.version === right.version &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.profile === right.profile &&
    left.runtime_digest === right.runtime_digest,
  )

function sameIdentity(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function missing(relative: string) {
  return new Error(`Capability artifact is missing: ${relative}`)
}

function escaped(relative: string) {
  return new Error(`Capability artifact escaped its governed Session scratch directory: ${relative}`)
}

function changed(relative: string) {
  return new Error(`Capability artifact changed during its immutable snapshot: ${relative}`)
}

async function canonicalExisting(target: string, relative: string) {
  return fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing(relative)
    throw error
  })
}

async function verifyRoot(anchor: RootAnchor) {
  const [held, current, canonical] = await Promise.all([
    anchor.handle.stat(),
    fs.lstat(anchor.path),
    fs.realpath(anchor.path),
  ]).catch(() => [undefined, undefined, undefined] as const)
  if (
    !held?.isDirectory() ||
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    anchor.identity.dev !== held.dev ||
    anchor.identity.ino !== held.ino ||
    current.dev !== held.dev ||
    current.ino !== held.ino ||
    canonical !== anchor.path
  ) {
    throw new Error("Capability smoke root changed during immutable artifact validation")
  }
}

async function openRoot(workspace: string, requested: string): Promise<RootAnchor> {
  const root = path.resolve(requested)
  const canonical = await fs.realpath(root).catch(() => undefined)
  const current = await fs.lstat(root).catch(() => undefined)
  if (
    !canonical ||
    canonical !== root ||
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !Filesystem.contains(workspace, canonical)
  ) {
    throw new Error("Capability smoke root escaped Session scratch")
  }
  const handle = await fs.open(root, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0))
  try {
    const anchor = { path: root, handle, identity: await handle.stat() }
    await verifyRoot(anchor)
    return anchor
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readExact(handle: FileHandle, size: number) {
  const bytes = Buffer.allocUnsafe(size)
  const cursor = { value: 0 }
  while (cursor.value < size) {
    const result = await handle.read(bytes, cursor.value, size - cursor.value, cursor.value)
    if (!result.bytesRead) break
    cursor.value += result.bytesRead
  }
  return bytes.subarray(0, cursor.value)
}

async function snapshotArtifact(
  workspace: string,
  root: RootAnchor,
  relative: string,
  max: number,
): Promise<ArtifactSnapshot> {
  const target = path.resolve(root.path, relative)
  if (!Filesystem.contains(workspace, target) || !Filesystem.contains(root.path, target)) throw escaped(relative)

  await verifyRoot(root)
  const canonical = await canonicalExisting(target, relative)
  if (!Filesystem.contains(workspace, canonical) || !Filesystem.contains(root.path, canonical)) throw escaped(relative)
  if (canonical !== target) {
    throw new Error(`Capability artifact must be a direct regular file; symbolic links are not allowed: ${relative}`)
  }

  const requested = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing(relative)
    throw error
  })
  if (!requested.isFile() || requested.isSymbolicLink()) throw missing(relative)

  const handle = await fs.open(target, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat()
    const [current, confirmed] = await Promise.all([fs.lstat(target), fs.realpath(target)])
    if (
      !before.isFile() ||
      current.isSymbolicLink() ||
      requested.dev !== before.dev ||
      requested.ino !== before.ino ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      confirmed !== target
    ) {
      throw changed(relative)
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) throw changed(relative)
    if (before.size > max) throw new Error(`Capability artifact exceeds its ${max}-byte contract: ${relative}`)

    await validationTestHooks.value?.afterOpen?.(target, relative)
    const bytes = await readExact(handle, before.size)
    const [after, final, finalCanonical] = await Promise.all([handle.stat(), fs.lstat(target), fs.realpath(target)])
    if (
      !after.isFile() ||
      !sameIdentity(before, after) ||
      bytes.byteLength !== before.size ||
      final.isSymbolicLink() ||
      final.dev !== after.dev ||
      final.ino !== after.ino ||
      finalCanonical !== target
    ) {
      throw changed(relative)
    }
    await verifyRoot(root)
    return {
      bytes,
      size: bytes.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    }
  } finally {
    await handle.close()
  }
}

const close = (actual: unknown, expected: number, tolerance: number) =>
  typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance

function verifyMetrics(id: string, value: Record<string, string | number | boolean>) {
  if (id === "scipy" && (!close(value.x, 3, 1e-5) || !close(value.objective, 2, 1e-7))) {
    throw new Error("SciPy smoke did not converge to its optimizer invariant")
  }
  if (
    id === "matplotlib" &&
    (value.width !== 300 || value.height !== 200 || typeof value.variance !== "number" || value.variance <= 1)
  ) {
    throw new Error("Matplotlib smoke did not satisfy its image invariant")
  }
  if (
    id === "scikit-learn" &&
    (value.predictions !== 38 || value.classes !== 3 || typeof value.accuracy !== "number" || value.accuracy < 0.89)
  ) {
    throw new Error("scikit-learn smoke did not satisfy its fixed-split invariant")
  }
  if (
    id === "biopython" &&
    (value.records !== 1 ||
      value.reverse_complement !== "CTATCGGGCACCCTTTCAGCGGCCCATTACAATGGCCAT" ||
      value.translation !== "MAIVMGR")
  ) {
    throw new Error("Biopython smoke did not satisfy its exact sequence invariant")
  }
  if (
    id === "rdkit" &&
    (value.formula !== "C8H10N4O2" ||
      typeof value.molecular_weight !== "number" ||
      value.molecular_weight <= 194 ||
      value.molecular_weight >= 195 ||
      value.sdf_roundtrip !== true)
  ) {
    throw new Error("RDKit smoke did not satisfy its molecule invariant")
  }
}

const u32 = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0

function requiredSnapshot(snapshots: Map<string, ArtifactSnapshot>, relative: string) {
  const result = snapshots.get(relative.split(path.sep).join("/"))
  if (!result) throw new Error(`Capability smoke contract did not declare required artifact: ${relative}`)
  return result
}

export async function validateCapabilitySmoke(input: {
  manifest: CapabilityManifest
  job: JobBroker.Job
  sessionID: string
  expectedBinding: JobBroker.CapabilityBinding
}) {
  const smoke = input.manifest.smoke
  if (!smoke) throw new Error(`${input.manifest.name} has no packaged smoke contract`)
  if (input.job.status !== "succeeded") throw new Error(`Capability job ${input.job.id} has not succeeded`)
  if (input.expectedBinding.profile !== "smoke" || !bound(input.job.capability, input.expectedBinding)) {
    throw new Error(`Capability job ${input.job.id} is not bound to the current ${input.manifest.name} smoke manifest`)
  }
  if (!input.job.cwd) throw new Error(`Capability job ${input.job.id} has no governed working directory`)

  const workspacePath = path.resolve(await SessionFilesystem.workspace(input.sessionID))
  const workspace = await fs.realpath(workspacePath).catch(() => undefined)
  if (!workspace) throw new Error("Capability Session scratch is unavailable")
  const root = await openRoot(workspace, input.job.cwd)
  try {
    const delivered = new Map((input.job.artifacts ?? []).map((item) => [item.path.split(path.sep).join("/"), item]))
    const snapshots = new Map<string, ArtifactSnapshot>()
    const artifacts: Array<{ path: string; size: number; sha256: string }> = []
    for (const declared of smoke.artifacts) {
      const relative = declared.split(path.sep).join("/")
      if (snapshots.has(relative)) throw new Error(`Capability smoke declares duplicate artifact: ${relative}`)
      const captured = delivered.get(relative)
      if (!captured) throw new Error(`Capability job did not deliver declared artifact: ${relative}`)
      const snapshot = await snapshotArtifact(workspace, root, declared, smoke.max_artifact_bytes)
      if (snapshot.size !== captured.size || snapshot.sha256 !== captured.sha256) {
        throw new Error(`Capability artifact changed after immutable capture: ${relative}`)
      }
      snapshots.set(relative, snapshot)
      artifacts.push({ path: relative, size: snapshot.size, sha256: snapshot.sha256 })
      await validationTestHooks.value?.afterSnapshot?.(path.resolve(root.path, declared), relative)
    }

    await verifyRoot(root)
    const resultFile = requiredSnapshot(snapshots, smoke.result_path)
    const result = Result.parse(JSON.parse(resultFile.bytes.toString("utf8")))
    if (result.capability_id !== input.manifest.id) {
      throw new Error(`Capability result belongs to ${result.capability_id}, expected ${input.manifest.id}`)
    }
    verifyMetrics(input.manifest.id, result.metrics)

    if (input.manifest.id === "matplotlib") {
      const image = new Uint8Array(requiredSnapshot(snapshots, "capability-figure.png").bytes)
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      if (
        !signature.every((entry, index) => image[index] === entry) ||
        u32(image, 16) !== 300 ||
        u32(image, 20) !== 200
      ) {
        throw new Error("Matplotlib smoke did not produce the declared PNG")
      }
    }
    if (input.manifest.id === "rdkit") {
      const sdf = requiredSnapshot(snapshots, "capability-molecule.sdf")
      if (!sdf.bytes.toString("utf8").includes("$$$$")) throw new Error("RDKit smoke SDF is incomplete")
    }
    return {
      ok: true as const,
      capability_id: input.manifest.id,
      target: input.job.target.kind === "modal" ? ("modal" as const) : ("local" as const),
      metrics: result.metrics,
      artifacts,
    }
  } finally {
    await root.handle.close()
  }
}
