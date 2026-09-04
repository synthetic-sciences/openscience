import { Global } from "@/global"
import {
  capabilityLockDigest,
  condaLockError,
  condaLockPlatform,
  type CoreScienceCondaPlatform,
} from "@/science/capability/conda-locks"
import { FileLease } from "@/util/file-lease"
import { Log } from "@/util/log"
import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js"
import crypto from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import type { KernelStartOptions } from "./types"

const log = Log.create({ service: "science.environment" })

type ManagedEnvironmentTestSupport = {
  micromambaSha256?: string
  ownershipFile?: string
  attestationLog?: string
}
const TEST_SUPPORT = Symbol.for("openscience.managed-environment.test-support.v1")
const testSupport = () =>
  (globalThis as typeof globalThis & { [TEST_SUPPORT]?: ManagedEnvironmentTestSupport })[TEST_SUPPORT]

const Language = z.enum(["python", "r"])
export type ManagedEnvironmentLanguage = z.infer<typeof Language>

const State = z.object({
  version: z.literal(1),
  status: z.enum(["absent", "installing", "ready", "failed"]),
  phase: z.string(),
  updated_at: z.string(),
  error: z.string().optional(),
})
export type ManagedEnvironmentState = z.infer<typeof State>

const Manifest = z.object({
  version: z.literal(1),
  name: z.string(),
  language: Language,
  kind: z.enum(["starter", "task"]),
  spec: z.string(),
  packages: z.string().array(),
  pip_packages: z.string().array().optional(),
  channels: z.string().array(),
  conda_lock_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  created_at: z.string(),
  verified_at: z.string(),
})

const STARTERS = {
  python: {
    name: "python",
    channels: ["conda-forge"],
    packages: ["python=3.11", "numpy", "pandas<3", "scipy", "matplotlib", "seaborn", "pillow", "pip"],
    probe: [
      "import json",
      "import numpy, pandas, scipy, matplotlib, seaborn",
      "from PIL import Image",
      'print(json.dumps({"ok": True}))',
    ].join("\n"),
  },
  r: {
    name: "r",
    channels: ["conda-forge", "bioconda"],
    packages: ["r-base", "r-tidyverse", "r-ggplot2", "r-jsonlite"],
    probe: 'suppressPackageStartupMessages({library(tidyverse); library(ggplot2); library(jsonlite)}); cat("ok")',
  },
} as const

const TaskName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "python" && value !== "r", "Use a distinct task environment name")
const IntegrityReceipt = z
  .object({
    version: z.literal(1),
    name: TaskName,
    spec: z.string().regex(/^[a-f0-9]{64}$/),
    manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    conda_lock_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    verified_at: z.string().datetime(),
  })
  .strict()
const explicitLock = (platform: CoreScienceCondaPlatform) =>
  z
    .string()
    .min(1)
    .max(250_000)
    .superRefine((value, ctx) => {
      const error = condaLockError(platform, value)
      if (error) ctx.addIssue({ code: "custom", message: error })
    })
const CondaLocks = z
  .object({
    "osx-arm64": explicitLock("osx-arm64"),
    "linux-aarch64": explicitLock("linux-aarch64"),
    "linux-64": explicitLock("linux-64"),
  })
  .strict()
const TaskSpec = z
  .object({
    channels: z.array(z.string().trim().min(1)).min(1).max(8).default(["conda-forge"]),
    packages: z.array(z.string().trim().min(1)).min(1).max(64).default(["python=3.11", "pip"]),
    conda_locks: CondaLocks.optional(),
    pip_packages: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_.-]+==[^=<>!~\s]+$/, "Task pip packages must use exact version pins"),
      )
      .max(100)
      .default([]),
    pip_requirements: z.string().trim().min(1).max(100_000).optional(),
    lock_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.conda_locks) return
    if (value.channels.length !== 1 || value.channels[0] !== "conda-forge") {
      ctx.addIssue({ code: "custom", path: ["channels"], message: "Explicit Conda locks must use only conda-forge" })
    }
    if (value.pip_packages.length > 0 && !value.pip_requirements) {
      ctx.addIssue({
        code: "custom",
        path: ["pip_requirements"],
        message: "Explicit Conda task environments require hashed pip requirements",
      })
    }
    for (const name of ["python", "pip"] as const) {
      const pin = value.packages.find((item) => item.startsWith(`${name}=`))
      const version = pin?.match(new RegExp(`^${name}=(\\d+\\.\\d+(?:\\.\\d+)?)$`, "u"))?.[1]
      if (!version) {
        ctx.addIssue({
          code: "custom",
          path: ["packages"],
          message: `Explicit Conda locks require an exact ${name} pin`,
        })
        continue
      }
      for (const [platform, lock] of Object.entries(value.conda_locks)) {
        if (condaLockError(platform as CoreScienceCondaPlatform, lock)) continue
        if (
          lock
            .split("\n")
            .slice(1)
            .some((line) => new URL(line).pathname.split("/").at(-1)?.startsWith(`${name}-${version}-`))
        ) {
          continue
        }
        ctx.addIssue({
          code: "custom",
          path: ["conda_locks", platform],
          message: `${platform} Conda lock does not contain ${pin}`,
        })
      }
    }
  })
export type ManagedTaskSpec = z.infer<typeof TaskSpec>

const root = () => path.join(Global.Path.data, "conda")
const environmentRoot = () => path.join(root(), "envs")
const stagingRoot = () => path.join(root(), ".staging")
const rollbackRoot = () => path.join(root(), ".rollback")
const archiveRoot = (digest: string, platform: CoreScienceCondaPlatform) =>
  path.join(root(), "archives", digest, platform)
const condaArchiveRoot = (digest: string, platform: CoreScienceCondaPlatform) =>
  path.join(archiveRoot(digest, platform), "conda")
const wheelArchiveRoot = (digest: string, platform: CoreScienceCondaPlatform) =>
  path.join(archiveRoot(digest, platform), "wheels")
const statePath = () => path.join(root(), "state.json")
const executableName = () => (process.platform === "win32" ? "micromamba.exe" : "micromamba")
const micromamba = () => path.join(root(), "bin", executableName())
const environmentPath = (name: string) => path.join(environmentRoot(), name)
const manifestPath = (name: string) => path.join(environmentPath(name), ".openscience-environment.json")
const integrityPath = (name: string) => path.join(root(), "integrity", `${name}.json`)

const MICROMAMBA_VERSION = "2.9.0"
const MICROMAMBA = {
  "osx-arm64": {
    archive: "500f5074feb8d02c4296ef9921c3650ed2874171805a9fbb8fbb53896433646b",
    binary: "ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be",
  },
  "osx-64": {
    archive: "0426ecdc41636d369f57b8fe6acbf4385a69eca45b56d9ee7d3a840a9965d44f",
    binary: "1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a",
  },
  "linux-aarch64": {
    archive: "e705ffeed90ce0659eb546e4b1e1028c9eaf0bc9cc854867b19ac5ce0ba5852f",
    binary: "9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7",
  },
  "linux-64": {
    archive: "8761c382127e6363bd9e0a2451aa3ef90d071a79133f736e2f759a3bf13040dd",
    binary: "366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3",
  },
  "win-64": {
    archive: "97a336f4ab794bd96a6a4da5e6ed63e75a1d31830414a182419b23d3b36f3fe0",
    binary: "a6d804394b2418991c4e29562853eaace2f2ce9d9da661a98e74e02e8dbb44b0",
  },
} as const

const platform = () => {
  if (process.platform === "darwin" && process.arch === "arm64") return "osx-arm64"
  if (process.platform === "darwin" && process.arch === "x64") return "osx-64"
  if (process.platform === "linux" && process.arch === "arm64") return "linux-aarch64"
  if (process.platform === "linux" && process.arch === "x64") return "linux-64"
  if (process.platform === "win32" && process.arch === "x64") return "win-64"
  throw new Error(`Managed scientific environments are not available on ${process.platform}/${process.arch}`)
}

async function sha256(file: string) {
  const bytes = await Bun.file(file).arrayBuffer()
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

async function installedMicromambaIsLocked() {
  const selectedPlatform = platform()
  const fixtureDigest = testSupport()?.micromambaSha256
  const expected = fixtureDigest?.match(/^[a-f0-9]{64}$/u) ? fixtureDigest : MICROMAMBA[selectedPlatform].binary
  return (await executable(micromamba())) && (await sha256(micromamba()).catch(() => "")) === expected
}

async function executable(file: string) {
  return fs.access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(
    () => true,
    () => false,
  )
}

async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(temporary, file).catch(async (error) => {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

async function state(value?: Partial<ManagedEnvironmentState>) {
  if (!value) {
    const parsed = State.safeParse(
      await Bun.file(statePath())
        .json()
        .catch(() => undefined),
    )
    return parsed.success
      ? parsed.data
      : ({ version: 1, status: "absent", phase: "not_started", updated_at: new Date().toISOString() } as const)
  }
  const current = await state()
  const next = State.parse({ ...current, ...value, version: 1, updated_at: new Date().toISOString() })
  await writeJson(statePath(), next)
  return next
}

async function run(command: string[], options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), MAMBA_ROOT_PREFIX: root(), MAMBA_NO_RC: "true" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), options.timeout ?? 20 * 60 * 1000)
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  if (exit === 0) return stdout
  throw new Error((stderr || stdout || `Command failed with exit ${exit}`).trim().slice(-4_000))
}

function isolatedPythonEnvironment(binary: string) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith("PYTHON") || name.startsWith("PIP_") || name === "VIRTUAL_ENV") delete env[name]
  }
  env.CONDA_PREFIX = path.dirname(path.dirname(binary))
  env.PATH = [path.dirname(binary), process.env.PATH].filter(Boolean).join(path.delimiter)
  env.PIP_CONFIG_FILE = process.platform === "win32" ? "NUL" : "/dev/null"
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1"
  env.PIP_NO_INPUT = "1"
  env.PYTHONDONTWRITEBYTECODE = "1"
  return env
}

function isolatedPipCommand(binary: string, python: string, args: readonly string[]) {
  const prefix = path.dirname(path.dirname(binary))
  const minor = python.split(".").slice(0, 2).join(".")
  const paths = [
    path.join(prefix, "lib", `python${minor}`),
    path.join(prefix, "lib", `python${minor}`, "lib-dynload"),
    path.join(prefix, "lib", `python${minor}`, "site-packages"),
  ]
  const bootstrap = [
    "import runpy, sys",
    `sys.path[:] = ${JSON.stringify(paths)}`,
    'runpy.run_module("pip", run_name="__main__")',
  ].join("\n")
  return [binary, "-I", "-S", "-B", "-c", bootstrap, ...args]
}

async function runIsolatedPip(binary: string, python: string, args: readonly string[], timeout: number) {
  return run(isolatedPipCommand(binary, python, args), {
    timeout,
    env: isolatedPythonEnvironment(binary),
  })
}

async function runIsolatedPython(binary: string, args: readonly string[], timeout = 30_000) {
  return run([binary, "-I", "-B", ...args], {
    timeout,
    env: isolatedPythonEnvironment(binary),
  })
}

function condaArtifacts(lock: string) {
  return lock
    .split("\n")
    .slice(1)
    .map((entry) => {
      const url = new URL(entry)
      const digest = url.hash.slice("#sha256=".length)
      url.hash = ""
      return { url: url.toString(), digest, name: path.basename(url.pathname) }
    })
}

function requirementArtifacts(requirements: string) {
  if (!requirements.trim()) return []
  return requirements.split("\n").map((line) => {
    const pin = line.trim().split(/\s+/u)[0]!
    const offset = pin.indexOf("==")
    return {
      pin,
      name: pin.slice(0, offset),
      version: pin.slice(offset + 2),
      hashes: [...line.matchAll(/--hash=sha256:([a-f0-9]{64})/gu)].map((match) => match[1]!),
    }
  })
}

async function ensureCondaArchives(digest: string, selected: CoreScienceCondaPlatform, lock: string) {
  const destination = condaArchiveRoot(digest, selected)
  await fs.mkdir(destination, { recursive: true })
  await Promise.all(
    condaArtifacts(lock).map(async (artifact) => {
      const target = path.join(destination, artifact.name)
      if ((await lockedFileSha256(target)) === artifact.digest) return
      const cached = path.join(root(), "pkgs", artifact.name)
      const temporary = path.join(stagingRoot(), `conda-archive-${crypto.randomUUID()}`)
      await fs.mkdir(stagingRoot(), { recursive: true })
      try {
        if ((await lockedFileSha256(cached)) === artifact.digest) {
          await fs.copyFile(cached, temporary)
        } else {
          const response = await fetch(artifact.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) })
          if (!response.ok) throw new Error(`Locked Conda archive download failed with HTTP ${response.status}`)
          await Bun.write(temporary, await response.arrayBuffer(), { mode: 0o600 })
        }
        if ((await lockedFileSha256(temporary)) !== artifact.digest) {
          throw new Error(`Locked Conda archive ${artifact.name} failed its sha256 checksum`)
        }
        await fs.rename(temporary, target)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    }),
  )
  return destination
}

const normalizedDistribution = (value: string) => value.toLowerCase().replaceAll(/[-_.]+/gu, "_")

async function verifiedWheels(directory: string, pins: readonly string[], requirements: string) {
  const expected = requirementArtifacts(requirements)
  if (
    expected.length !== pins.length ||
    expected.some((item) => !pins.includes(item.pin) || item.hashes.length === 0)
  ) {
    return undefined
  }
  const files = (await fs.readdir(directory).catch(() => [])).filter((file) => file.endsWith(".whl"))
  if (files.length !== expected.length) return undefined
  const result = new Map<string, string>()
  for (const file of files) {
    const normalized = normalizedDistribution(file)
    const item = expected.find((candidate) =>
      normalized.startsWith(`${normalizedDistribution(candidate.name)}_${normalizedDistribution(candidate.version)}_`),
    )
    const target = path.join(directory, file)
    if (!item || result.has(item.pin) || !item.hashes.includes((await lockedFileSha256(target)) ?? "")) return undefined
    result.set(item.pin, target)
  }
  return result.size === expected.length ? result : undefined
}

async function ensureWheelArchives(
  binary: string,
  python: string,
  digest: string,
  selected: CoreScienceCondaPlatform,
  pins: readonly string[],
  requirements: string,
) {
  const destination = wheelArchiveRoot(digest, selected)
  if (await verifiedWheels(destination, pins, requirements)) return destination
  const staging = path.join(stagingRoot(), `wheels-${crypto.randomUUID()}`)
  const requirementFile = path.join(stagingRoot(), `requirements-${crypto.randomUUID()}.txt`)
  await fs.mkdir(staging, { recursive: true })
  await Bun.write(requirementFile, requirements, { mode: 0o600 })
  try {
    await runIsolatedPip(
      binary,
      python,
      [
        "download",
        "--disable-pip-version-check",
        "--no-deps",
        "--only-binary=:all:",
        "--require-hashes",
        "--dest",
        staging,
        "-r",
        requirementFile,
      ],
      45 * 60 * 1000,
    )
    if (!(await verifiedWheels(staging, pins, requirements))) {
      throw new Error("Downloaded wheels do not exactly cover the hashed task requirements")
    }
    const previous = `${destination}.${crypto.randomUUID()}.previous`
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const hadPrevious = !!(await fs.stat(destination).catch(() => undefined))
    if (hadPrevious) await fs.rename(destination, previous)
    try {
      await fs.rename(staging, destination)
    } catch (error) {
      if (hadPrevious) await fs.rename(previous, destination).catch(() => undefined)
      throw error
    }
    if (hadPrevious) await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined)
    return destination
  } finally {
    await fs.rm(requirementFile, { force: true }).catch(() => undefined)
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function installMicromamba() {
  const selectedPlatform = platform()
  const locked = MICROMAMBA[selectedPlatform]
  if (await installedMicromambaIsLocked()) return micromamba()
  await state({ status: "installing", phase: "installing_micromamba", error: undefined })
  const archive = path.join(stagingRoot(), `micromamba-${crypto.randomUUID()}.tar.bz2`)
  const extracted = path.join(stagingRoot(), `micromamba-${crypto.randomUUID()}`)
  const replacement = `${micromamba()}.${process.pid}.${crypto.randomUUID()}.tmp`
  const previous = `${micromamba()}.${process.pid}.${crypto.randomUUID()}.previous`
  let preservePrevious = false
  try {
    await fs.mkdir(extracted, { recursive: true })
    const response = await fetch(`https://micro.mamba.pm/api/micromamba/${selectedPlatform}/${MICROMAMBA_VERSION}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Micromamba download failed with HTTP ${response.status}`)
    await Bun.write(archive, await response.arrayBuffer(), { mode: 0o600 })
    if ((await sha256(archive)) !== locked.archive) {
      throw new Error(`Micromamba ${MICROMAMBA_VERSION} archive failed its ${selectedPlatform} checksum`)
    }
    await run(["tar", "-xf", archive, "-C", extracted], { timeout: 60_000 })
    const candidates = [
      path.join(extracted, "bin", "micromamba"),
      path.join(extracted, "Library", "bin", "micromamba.exe"),
      path.join(extracted, "micromamba.exe"),
    ]
    const source = (
      await Promise.all(candidates.map(async (file) => ((await executable(file)) ? file : undefined)))
    ).find((file): file is string => !!file)
    if (!source) throw new Error("The official micromamba archive did not contain the expected executable")
    if ((await sha256(source)) !== locked.binary) {
      throw new Error(`Micromamba ${MICROMAMBA_VERSION} executable failed its ${selectedPlatform} checksum`)
    }
    await fs.mkdir(path.dirname(micromamba()), { recursive: true })
    await fs.copyFile(source, replacement)
    if (process.platform !== "win32") await fs.chmod(replacement, 0o755)
    const hadPrevious = !!(await fs.stat(micromamba()).catch(() => undefined))
    if (hadPrevious) await fs.rename(micromamba(), previous)
    try {
      await fs.rename(replacement, micromamba())
    } catch (error) {
      if (hadPrevious) {
        try {
          await fs.rename(previous, micromamba())
        } catch (restoreError) {
          preservePrevious = true
          throw new AggregateError(
            [error, restoreError],
            `Micromamba replacement failed and the previous verified binary remains at ${previous}`,
          )
        }
      }
      throw error
    }
    if (hadPrevious)
      await fs.rm(previous, { force: true }).catch((error) => {
        log.warn("failed to remove replaced micromamba rollback", { previous, error: String(error) })
      })
    return micromamba()
  } finally {
    await fs.rm(archive, { force: true }).catch(() => undefined)
    await fs.rm(extracted, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(replacement, { force: true }).catch(() => undefined)
    if (!preservePrevious) await fs.rm(previous, { force: true }).catch(() => undefined)
  }
}

async function probe(language: ManagedEnvironmentLanguage, prefix = environmentPath(language)) {
  const binary =
    language === "python"
      ? path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python")
      : path.join(prefix, process.platform === "win32" ? "Scripts/Rscript.exe" : "bin/Rscript")
  if (!(await executable(binary))) return false
  const command = language === "python" ? [binary, "-I", "-c", STARTERS.python.probe] : [binary, "-e", STARTERS.r.probe]
  return run(command, { timeout: 30_000 }).then(
    () => true,
    () => false,
  )
}

type OwnedFile = {
  kind: "file" | "symlink"
  digest?: string
  archiveDigest?: string
  content?: string
  placeholder?: string
  mode?: string
  size?: number
  archiveSize?: number
  canonical?: "macho_unsigned"
  linkTarget?: string
  optional?: boolean
}
type Ownership = {
  directories: Set<string>
  files: Map<string, OwnedFile>
  scripts: Set<string>
  removals: Set<string>
}
const digestBytes = (value: ArrayBuffer | Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

/** Conda re-signs Mach-O files whose embedded prefix was relocated. Remove
 * only a structurally valid terminal LC_CODE_SIGNATURE and its corresponding
 * __LINKEDIT sizes; every executable/data byte and other load-command field
 * remains authenticated. */
function canonicalMachO(value: Uint8Array) {
  if (value.byteLength < 32) return undefined
  const output = value.slice()
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  const magic = view.getUint32(0, true)
  const header = magic === 0xfeedfacf ? 32 : magic === 0xfeedface ? 28 : undefined
  if (!header) return undefined
  const cpu = view.getUint32(4, true)
  const page = cpu === 0x0100000c ? 16_384n : cpu === 0x01000007 ? 4_096n : undefined
  if (!page) return undefined
  const commands = view.getUint32(16, true)
  let offset = header
  let signature: { offset: number; size: number; command: number } | undefined
  let linkedit: { command: number; vmsize: bigint; fileoff: bigint; filesize: bigint } | undefined
  for (let index = 0; index < commands; index++) {
    if (offset + 8 > output.byteLength) return undefined
    const command = view.getUint32(offset, true)
    const size = view.getUint32(offset + 4, true)
    if (size < 8 || offset + size > output.byteLength) return undefined
    if (command === 0x1d) {
      if (size < 16 || signature) return undefined
      signature = {
        offset: view.getUint32(offset + 8, true),
        size: view.getUint32(offset + 12, true),
        command: offset,
      }
    }
    if (command === 0x19 && size >= 72) {
      const name = new TextDecoder().decode(output.subarray(offset + 8, offset + 24)).replace(/\0.*$/u, "")
      if (name === "__LINKEDIT") {
        if (linkedit) return undefined
        linkedit = {
          command: offset,
          vmsize: view.getBigUint64(offset + 32, true),
          fileoff: view.getBigUint64(offset + 40, true),
          filesize: view.getBigUint64(offset + 48, true),
        }
      }
    }
    offset += size
  }
  if (
    !signature ||
    !linkedit ||
    signature.offset < offset ||
    signature.size <= 0 ||
    signature.offset + signature.size !== output.byteLength
  )
    return undefined
  const length = BigInt(output.byteLength)
  const signedOffset = BigInt(signature.offset)
  const align = (size: bigint) => ((size + page - 1n) / page) * page
  if (
    linkedit.fileoff > signedOffset ||
    linkedit.filesize !== length - linkedit.fileoff ||
    linkedit.vmsize !== align(linkedit.filesize)
  )
    return undefined
  const unsignedFilesize = signedOffset - linkedit.fileoff
  view.setBigUint64(linkedit.command + 32, align(unsignedFilesize), true)
  view.setBigUint64(linkedit.command + 48, unsignedFilesize, true)
  view.setUint32(signature.command + 8, 0, true)
  view.setUint32(signature.command + 12, 0, true)
  return output.slice(0, signature.offset)
}
const portable = (value: string) => {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return undefined
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined
  return parts.join("/")
}
const native = (value: string) => value.split("/").join(path.sep)
const own = (ownership: Ownership, relative: string, file: OwnedFile, overlay = false) => {
  const existing = ownership.files.get(relative)
  if (!overlay && existing && JSON.stringify(existing) !== JSON.stringify(file)) return false
  ownership.files.set(relative, file)
  return true
}

function condaPath(relative: string, noarch: boolean, python: string) {
  if (!noarch) return relative
  if (relative.startsWith("site-packages/")) {
    return `lib/python${python.split(".").slice(0, 2).join(".")}/site-packages/${relative.slice(14)}`
  }
  if (relative.startsWith("python-scripts/")) return `bin/${relative.slice(15)}`
  return relative
}

async function condaOwnership(digest: string, platform: CoreScienceCondaPlatform, lock: string, python: string) {
  if (!(await installedMicromambaIsLocked())) return undefined
  const ownership: Ownership = { directories: new Set(), files: new Map(), scripts: new Set(), removals: new Set() }
  const temporary = path.join(stagingRoot(), `conda-attestation-${crypto.randomUUID()}`)
  await fs.mkdir(temporary, { recursive: true })
  try {
    for (const [index, artifact] of condaArtifacts(lock).entries()) {
      const archive = path.join(condaArchiveRoot(digest, platform), artifact.name)
      const bytes = await openedBytes(archive)
      if (!bytes || digestBytes(bytes) !== artifact.digest) return undefined
      const authenticated = path.join(temporary, `${index}-${artifact.name}`)
      await Bun.write(authenticated, bytes, { mode: 0o600 })
      const extracted = path.join(temporary, String(index))
      await run([micromamba(), "package", "extract", authenticated, extracted], { timeout: 120_000 })
      const paths = z
        .object({
          paths: z.array(
            z
              .object({
                _path: z.string().min(1),
                path_type: z.enum(["directory", "hardlink", "softlink"]),
                sha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
                size_in_bytes: z.number().int().nonnegative().optional(),
                prefix_placeholder: z.string().min(1).optional(),
                file_mode: z.enum(["text", "binary"]).optional(),
              })
              .passthrough(),
          ),
        })
        .safeParse(
          await Bun.file(path.join(extracted, "info", "paths.json"))
            .json()
            .catch(() => undefined),
        )
      const indexData = z
        .object({ noarch: z.union([z.string(), z.boolean()]).optional() })
        .passthrough()
        .safeParse(
          await Bun.file(path.join(extracted, "info", "index.json"))
            .json()
            .catch(() => undefined),
        )
      const link = z
        .object({
          noarch: z.object({ type: z.string(), entry_points: z.array(z.string()).optional() }).optional(),
        })
        .passthrough()
        .safeParse(
          await Bun.file(path.join(extracted, "info", "link.json"))
            .json()
            .catch(() => ({})),
        )
      if (!paths.success || !indexData.success || !link.success) return undefined
      const noarch = indexData.data.noarch === "python" || link.data.noarch?.type === "python"
      for (const item of paths.data.paths) {
        const source = portable(item._path)
        if (!source) return undefined
        const relative = portable(condaPath(source, noarch, python))
        if (item.path_type === "directory") {
          if (!relative || ownership.files.has(relative)) return undefined
          ownership.directories.add(relative)
          continue
        }
        let file: OwnedFile = {
          kind: item.path_type === "softlink" ? "symlink" : "file",
          digest: item.sha256,
          placeholder: item.prefix_placeholder,
          mode: item.file_mode,
          size: item.size_in_bytes,
        }
        if (item.path_type === "softlink") {
          const target = await fs.readlink(path.join(extracted, native(source))).catch(() => undefined)
          if (!target || path.isAbsolute(target) || target.includes("\0")) return undefined
          file.linkTarget = target
        }
        if (
          platform === "osx-arm64" &&
          item.path_type === "hardlink" &&
          item.prefix_placeholder &&
          item.file_mode === "binary"
        ) {
          const archived = await openedBytes(path.join(extracted, native(source)))
          const canonical = archived ? canonicalMachO(archived) : undefined
          if (canonical) {
            file = {
              ...file,
              digest: digestBytes(canonical),
              size: canonical.byteLength,
              archiveDigest: item.sha256,
              archiveSize: item.size_in_bytes,
              canonical: "macho_unsigned",
            }
          }
        }
        if (!relative || !item.sha256 || ownership.directories.has(relative) || !own(ownership, relative, file))
          return undefined
      }
      for (const entry of link.data.noarch?.entry_points ?? []) {
        const name = portable(`bin/${entry.split("=", 1)[0]!.trim()}`)
        if (!name) return undefined
        ownership.scripts.add(name)
      }
    }
    return ownership
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

function wheelPath(relative: string, python: string) {
  const site = `lib/python${python.split(".").slice(0, 2).join(".")}/site-packages`
  const parts = relative.split("/")
  const data = parts.findIndex((part) => part.endsWith(".data"))
  if (data < 0) return `${site}/${relative}`
  const scheme = parts[data + 1]
  const rest = parts.slice(data + 2).join("/")
  if (!rest) return undefined
  if (scheme === "purelib" || scheme === "platlib") return `${site}/${rest}`
  if (scheme === "scripts") return `bin/${rest}`
  if (scheme === "data") return rest
  return undefined
}

async function wheelOwnership(
  ownership: Ownership,
  digest: string,
  platform: CoreScienceCondaPlatform,
  python: string,
  pins: readonly string[],
  requirements: string,
) {
  const wheels = await verifiedWheels(wheelArchiveRoot(digest, platform), pins, requirements)
  if (!wheels) return false
  const wheelOwned = new Set<string>()
  const site = `lib/python${python.split(".").slice(0, 2).join(".")}/site-packages`
  for (const archive of wheels.values()) {
    const reader = new ZipReader(new BlobReader(new Blob([await Bun.file(archive).arrayBuffer()])))
    try {
      const entries = await reader.getEntries()
      const info = entries.find((entry) => !entry.directory && entry.filename.endsWith(".dist-info/METADATA"))?.filename
      const root = info?.slice(0, -"METADATA".length)
      if (!root) return false
      const files = new Set<string>()
      let record: string | undefined
      for (const entry of entries) {
        if (entry.directory) continue
        const archived = portable(entry.filename)
        const relative = archived ? portable(wheelPath(archived, python) ?? "") : undefined
        if (!relative) return false
        if (entry.filename.endsWith(".dist-info/RECORD")) {
          record = relative
          continue
        }
        const blob = await entry.getData?.(new BlobWriter())
        if (!blob || wheelOwned.has(relative) || ownership.directories.has(relative)) return false
        const bytes = await blob.arrayBuffer()
        if (!own(ownership, relative, { kind: "file", digest: digestBytes(bytes), size: bytes.byteLength }, true))
          return false
        wheelOwned.add(relative)
        files.add(relative)
        if (!entry.filename.endsWith(".dist-info/entry_points.txt")) continue
        const text = await blob.text()
        const section = text.match(/\[console_scripts\]([\s\S]*?)(?:\n\[|$)/u)?.[1] ?? ""
        for (const line of section.split("\n")) {
          const name = portable(`bin/${line.split("=", 1)[0]!.trim()}`)
          if (!name || line.trim().startsWith("#") || !line.includes("=")) continue
          ownership.scripts.add(name)
        }
      }
      if (!record || wheelOwned.has(record) || ownership.directories.has(record)) return false
      const metadata = portable(wheelPath(`${root}INSTALLER`, python)!)!
      const requested = portable(wheelPath(`${root}REQUESTED`, python)!)!
      const directUrl = portable(wheelPath(`${root}direct_url.json`, python)!)!
      for (const [relative, content] of [
        [metadata, "pip\n"],
        [requested, ""],
      ] as const) {
        if (wheelOwned.has(relative) || ownership.directories.has(relative)) return false
        if (
          !own(
            ownership,
            relative,
            { kind: "file", digest: digestBytes(content), size: new TextEncoder().encode(content).byteLength, content },
            true,
          )
        )
          return false
        wheelOwned.add(relative)
        files.add(relative)
      }
      ownership.removals.add(directUrl)
      ownership.files.delete(directUrl)
      const csv = (value: string) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
      const rows = [...files].toSorted().map((relative) => {
        const expected = ownership.files.get(relative)
        if (!expected?.digest || expected.size === undefined) return undefined
        const installed = path.posix.relative(site, relative)
        const encoded = Buffer.from(expected.digest, "hex").toString("base64url")
        return `${csv(installed)},sha256=${encoded},${expected.size}`
      })
      if (rows.some((row) => !row)) return false
      rows.push(`${csv(path.posix.relative(site, record))},,`)
      const content = `${rows.toSorted().join("\n")}\n`
      if (
        !own(
          ownership,
          record,
          {
            kind: "file",
            digest: digestBytes(content),
            size: new TextEncoder().encode(content).byteLength,
            content,
          },
          true,
        )
      )
        return false
      wheelOwned.add(record)
    } finally {
      await reader.close()
    }
  }
  return true
}

async function fixtureOwnership() {
  const file = testSupport()?.ownershipFile
  if (!file) return undefined
  const fixtureFile = z.union([
    z.string().regex(/^[a-f0-9]{64}$/),
    z.null(),
    z
      .object({
        kind: z.literal("symlink"),
        digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        linkTarget: z.string().min(1),
      })
      .strict(),
    z
      .object({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
        canonical: z.literal("macho_unsigned"),
      })
      .strict(),
  ])
  const parsed = z
    .object({
      version: z.literal(1),
      files: z.record(z.string(), fixtureFile),
      scripts: z.array(z.string()).default([]),
    })
    .strict()
    .safeParse(
      await Bun.file(file)
        .json()
        .catch(() => undefined),
    )
  if (!parsed.success) return undefined
  const ownership: Ownership = {
    directories: new Set(),
    files: new Map(),
    scripts: new Set(),
    removals: new Set(),
  }
  for (const [relative, value] of Object.entries(parsed.data.files)) {
    const safe = portable(relative)
    const owned =
      typeof value === "string"
        ? { kind: "file" as const, digest: value }
        : value && "kind" in value
          ? value
          : value
            ? { kind: "file" as const, ...value }
            : { kind: "file" as const }
    if (!safe || !own(ownership, safe, owned)) return undefined
  }
  for (const relative of parsed.data.scripts) {
    const safe = portable(relative)
    if (!safe) return undefined
    ownership.scripts.add(safe)
  }
  return ownership
}

function restorePrefix(bytes: Uint8Array, placeholder: string, prefix: string, mode?: string) {
  if (mode === "text") {
    const value = new TextDecoder().decode(bytes)
    if (!value.includes(prefix)) return undefined
    return new TextEncoder().encode(value.replaceAll(prefix, placeholder))
  }
  const replacement = new TextEncoder().encode(placeholder)
  const prefixBytes = new TextEncoder().encode(prefix)
  const padding = replacement.byteLength - prefixBytes.byteLength
  if (padding < 0) return undefined
  const output = bytes.slice()
  let found = false
  for (let offset = 0; offset <= output.byteLength - prefixBytes.byteLength; offset++) {
    if (!prefixBytes.every((byte, index) => output[offset + index] === byte)) continue
    let terminator = offset + prefixBytes.byteLength
    while (terminator < output.byteLength && output[terminator] !== 0) terminator++
    const occurrences: number[] = []
    for (let cursor = offset; cursor <= terminator - prefixBytes.byteLength; cursor++) {
      if (!prefixBytes.every((byte, index) => output[cursor + index] === byte)) continue
      occurrences.push(cursor)
      cursor += prefixBytes.byteLength - 1
    }
    const expansion = padding * occurrences.length
    if (terminator + expansion >= output.byteLength) continue
    if (!output.subarray(terminator, terminator + expansion + 1).every((byte) => byte === 0)) continue
    let end = terminator
    for (const occurrence of occurrences.toReversed()) {
      output.copyWithin(occurrence + replacement.byteLength, occurrence + prefixBytes.byteLength, end)
      output.set(replacement, occurrence)
      end += padding
    }
    found = true
    offset = end
  }
  return found ? output : undefined
}

async function openedBytes(file: string) {
  const nofollow = "O_NOFOLLOW" in constants ? (constants as typeof constants & { O_NOFOLLOW: number }).O_NOFOLLOW : 0
  const handle = await fs.open(file, constants.O_RDONLY | nofollow).catch(() => undefined)
  if (!handle) return undefined
  try {
    const before = await handle.stat()
    if (!before.isFile()) return undefined
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      return undefined
    return new Uint8Array(bytes)
  } finally {
    await handle.close()
  }
}

async function lockedFileSha256(file: string) {
  const bytes = await openedBytes(file)
  return bytes ? digestBytes(bytes) : undefined
}

async function verifyOwnership(prefix: string, ownership: Ownership, options: { allowCondaMetadata?: boolean } = {}) {
  const reject = (_reason: string, _relative?: string) => false
  const root = await fs.realpath(prefix).catch(() => undefined)
  if (!root) return reject("missing root")
  const base = `${root}${path.sep}`
  const directories = new Set<string>()
  const present = new Set<string>()
  const walk = async (directory: string): Promise<boolean> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined)
    if (!entries) return reject("unreadable directory", path.relative(root, directory))
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      const relative = portable(path.relative(root, target).split(path.sep).join("/"))
      if (!relative) return reject("invalid relative path", path.relative(root, target))
      if (entry.isDirectory()) {
        if (ownership.files.has(relative)) return reject("file replaced by directory", relative)
        directories.add(relative)
        if (!(await walk(target))) return false
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) return reject("unsupported filesystem entry", relative)
      const controlled = options.allowCondaMetadata && relative.startsWith("conda-meta/")
      if (controlled) {
        if (entry.isSymbolicLink()) return reject("symlink in conda metadata", relative)
        continue
      }
      const expected = ownership.files.get(relative)
      if (!expected && entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo"))) {
        await fs.rm(target, { force: true }).catch(() => undefined)
        if (await Bun.file(target).exists()) return reject("unowned generated bytecode could not be removed", relative)
        continue
      }
      if (!expected) return reject("unowned file", relative)
      if (entry.isFile() && expected.kind !== "file") return reject("path type changed to file", relative)
      if (entry.isSymbolicLink() && expected.kind !== "symlink") return reject("path type changed to symlink", relative)
      if (
        entry.isSymbolicLink() &&
        (!expected.linkTarget || (await fs.readlink(target).catch(() => undefined)) !== expected.linkTarget)
      )
        return reject("symlink target changed", relative)
      present.add(relative)
      const resolved = await fs.realpath(target).catch(() => undefined)
      if (!resolved || (resolved !== root && !resolved.startsWith(base))) return reject("path escapes prefix", relative)
      const resolvedRelative = portable(path.relative(root, resolved).split(path.sep).join("/"))
      if (entry.isSymbolicLink() && (await fs.stat(resolved).catch(() => undefined))?.isDirectory()) {
        // The archive-authenticated link target is exact and its resolved tree
        // is traversed independently below the prefix. Conda's digest/size for
        // directory symlinks is package-specific and is not a link-byte hash.
        continue
      }
      // A Conda softlink's paths.json digest can describe the target present
      // in the source package's build environment. Authenticate the exact
      // link text and the currently locked, in-prefix target independently.
      const record = entry.isSymbolicLink() ? ownership.files.get(resolvedRelative ?? "") : expected
      if (!record || record.kind !== "file") return reject("resolved target is not archive-owned", relative)
      const bytes = await openedBytes(resolved)
      if (!bytes) return reject("owned bytes changed while reading", relative)
      if (!record.digest) continue
      const restored = record.placeholder ? restorePrefix(bytes, record.placeholder, prefix, record.mode) : bytes
      if (!restored) return reject("owned file prefix normalization mismatch", relative)
      const normalized = record.canonical === "macho_unsigned" ? canonicalMachO(restored) : restored
      if (!normalized) return reject("owned Mach-O signature structure mismatch", relative)
      if (record.size !== undefined && normalized.byteLength !== record.size)
        return reject(`owned file size mismatch (${normalized.byteLength} != ${record.size})`, relative)
      if (!entry.isSymbolicLink() && expected.size !== undefined && normalized.byteLength !== expected.size)
        return reject("owned file size identity mismatch", relative)
      const actual = digestBytes(normalized)
      if (actual !== record.digest || (!entry.isSymbolicLink() && expected.digest && actual !== expected.digest))
        return reject("owned file digest mismatch", relative)
    }
    return true
  }
  if (!(await walk(root))) return false
  const missingFile = [...ownership.files].find(([relative, file]) => !file.optional && !present.has(relative))?.[0]
  if (missingFile) return reject("archive-owned file missing", missingFile)
  const missingDirectory = [...ownership.directories].find((relative) => !directories.has(relative))
  if (missingDirectory) return reject("archive-owned directory missing", missingDirectory)
  return true
}

async function cleanupGenerated(prefix: string, ownership: Ownership) {
  for (const relative of ownership.removals) {
    await fs.rm(path.join(prefix, native(relative)), { force: true }).catch(() => undefined)
  }
  for (const relative of ownership.scripts) {
    if (ownership.files.has(relative)) continue
    await fs.rm(path.join(prefix, native(relative)), { force: true }).catch(() => undefined)
  }
  const walk = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo"))) {
        const relative = portable(path.relative(prefix, target).split(path.sep).join("/"))
        if (relative && ownership.files.has(relative)) continue
        await fs.rm(target, { force: true }).catch(() => undefined)
      }
    }
  }
  await walk(prefix)
  for (const [relative, file] of ownership.files) {
    if (file.content === undefined) continue
    const target = path.join(prefix, native(relative))
    const current = await fs.lstat(target).catch(() => undefined)
    if (current && !current.isFile()) throw new Error(`Refusing to normalize non-file managed metadata: ${relative}`)
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await Bun.write(temporary, file.content, { mode: 0o600 })
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

const attestation = new Map<string, Promise<boolean>>()

async function trustedOwnership(
  digest: string,
  platform: CoreScienceCondaPlatform,
  lock: string,
  python: string,
  pins: readonly string[],
  requirements: string,
) {
  const fixture = await fixtureOwnership()
  if (fixture) return fixture
  const ownership = await condaOwnership(digest, platform, lock, python)
  if (!ownership || !(await wheelOwnership(ownership, digest, platform, python, pins, requirements))) return undefined
  return ownership
}

async function attestExact(
  prefix: string,
  binary: string,
  digest: string,
  platform: CoreScienceCondaPlatform,
  lock: string,
  python: string,
  pins: readonly string[],
  requirements: string,
  manifest: z.infer<typeof Manifest>,
) {
  const manifestContent = JSON.stringify(manifest, null, 2)
  const key = `${prefix}:${digest}:${digestBytes(manifestContent)}`
  const existing = attestation.get(key)
  if (existing) return existing
  const current = (async () => {
    const ownership = await trustedOwnership(digest, platform, lock, python, pins, requirements)
    if (!ownership) return false
    if (
      !own(ownership, ".openscience-environment.json", {
        kind: "file",
        digest: digestBytes(manifestContent),
        size: new TextEncoder().encode(manifestContent).byteLength,
      })
    )
      return false
    if (!(await verifyOwnership(prefix, ownership))) return false
    const attestationLog = testSupport()?.attestationLog
    if (attestationLog) await fs.appendFile(attestationLog, "closure\n")
    if (!(await attestPython(binary, python, pins))) return false
    // Some packaging bootstraps can materialize bytecode despite isolated
    // interpreter flags. Remove only unowned generated bytecode, then require
    // the complete archive closure again before publishing the receipt.
    await cleanupGenerated(prefix, ownership)
    if (!(await verifyOwnership(prefix, ownership))) return false
    await writeJson(integrityPath(manifest.name), {
      version: 1,
      name: manifest.name,
      spec: manifest.spec,
      manifest_sha256: digestBytes(manifestContent),
      conda_lock_sha256: manifest.conda_lock_sha256!,
      verified_at: new Date().toISOString(),
    } satisfies z.infer<typeof IntegrityReceipt>)
    return true
  })().finally(() => {
    if (attestation.get(key) === current) attestation.delete(key)
  })
  attestation.set(key, current)
  return current
}

async function attestPython(binary: string, python?: string, pins: readonly string[] = []) {
  if (!python && pins.length === 0)
    return runIsolatedPython(binary, ["-c", 'print("ok")']).then(
      () => true,
      () => false,
    )
  const names = pins.map((pin) => pin.slice(0, pin.indexOf("==")))
  const code = [
    "import importlib.metadata, json, platform",
    `names = ${JSON.stringify(names)}`,
    "print(json.dumps({'python': platform.python_version(), 'packages': {name: importlib.metadata.version(name) for name in names}}, sort_keys=True))",
  ].join("\n")
  const output = await runIsolatedPython(binary, ["-c", code]).catch(() => undefined)
  const value = await Promise.resolve(output)
    .then((item) => (item ? JSON.parse(item) : undefined))
    .catch(() => undefined)
  const result = z.object({ python: z.string(), packages: z.record(z.string(), z.string()) }).safeParse(value)
  if (!result.success || (python && result.data.python !== python)) return false
  return pins.every((pin) => {
    const offset = pin.indexOf("==")
    return result.data.packages[pin.slice(0, offset)] === pin.slice(offset + 2)
  })
}

async function replaceEnvironment(target: string, create: () => Promise<void>) {
  await fs.mkdir(environmentRoot(), { recursive: true })
  const previous = path.join(rollbackRoot(), `${path.basename(target)}-${Date.now()}-${crypto.randomUUID()}`)
  const hadPrevious = !!(await fs.stat(target).catch(() => undefined))
  if (hadPrevious) {
    await fs.mkdir(rollbackRoot(), { recursive: true })
    await fs.rename(target, previous)
  }
  try {
    // Conda environments contain absolute prefixes (including Mach-O dylib
    // install names on macOS). Solve directly at the durable path: renaming a
    // staged prefix makes an otherwise valid environment unlaunchable.
    await create()
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    if (hadPrevious) await fs.rename(previous, target).catch(() => undefined)
    throw error
  }
  if (hadPrevious) {
    await fs.rm(previous, { recursive: true, force: true }).catch((error) => {
      log.warn("failed to remove replaced environment rollback", { previous, error: String(error) })
    })
  }
}

async function ensureStarter(language: ManagedEnvironmentLanguage) {
  if (await probe(language)) return
  const spec = STARTERS[language]
  await state({ status: "installing", phase: `provisioning_${language}`, error: undefined })
  const target = environmentPath(language)
  const channels = spec.channels.flatMap((channel) => ["-c", channel])
  await replaceEnvironment(target, async () => {
    await run([await installMicromamba(), "--no-rc", "create", "-y", "-p", target, ...channels, ...spec.packages])
    if (!(await probe(language, target))) throw new Error(`${language} starter environment failed its import probe`)
    const now = new Date().toISOString()
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify({ channels: spec.channels, packages: spec.packages }))
      .digest("hex")
    await writeJson(path.join(target, ".openscience-environment.json"), {
      version: 1,
      name: spec.name,
      language,
      kind: "starter",
      spec: digest,
      packages: [...spec.packages],
      channels: [...spec.channels],
      created_at: now,
      verified_at: now,
    } satisfies z.infer<typeof Manifest>)
  })
}

function taskDigest(spec: ManagedTaskSpec) {
  return capabilityLockDigest({
    channels: spec.channels,
    packages: spec.packages,
    conda_locks: spec.conda_locks,
    pip_packages: spec.pip_packages,
    pip_requirements: spec.pip_requirements,
  })
}

const EXACT_TASK_TIMESTAMP = "1970-01-01T00:00:00.000Z"
function exactTaskManifest(name: string, spec: ManagedTaskSpec, digest: string, lockSha: string) {
  return exactManifest(name, digest, lockSha, spec.packages, spec.pip_packages, spec.channels)
}

function exactManifest(
  name: string,
  digest: string,
  lockSha: string,
  packages: readonly string[],
  pipPackages: readonly string[],
  channels: readonly string[],
) {
  return Manifest.parse({
    version: 1,
    name,
    language: "python",
    kind: "task",
    spec: digest,
    packages: [...packages],
    pip_packages: [...pipPackages],
    channels: [...channels],
    conda_lock_sha256: lockSha,
    created_at: EXACT_TASK_TIMESTAMP,
    verified_at: EXACT_TASK_TIMESTAMP,
  })
}

const sameManifest = (left: z.infer<typeof Manifest>, right: z.infer<typeof Manifest>) =>
  JSON.stringify(left) === JSON.stringify(right)

async function ensureTaskEnvironment(name: string, spec: ManagedTaskSpec, selected?: CoreScienceCondaPlatform) {
  const target = environmentPath(name)
  const binary = path.join(target, process.platform === "win32" ? "python.exe" : "bin/python")
  const digest = taskDigest(spec)
  const lock = selected ? spec.conda_locks?.[selected] : undefined
  const lockSha = lock ? new Bun.CryptoHasher("sha256").update(lock).digest("hex") : undefined
  const python = lock ? spec.packages.find((item) => /^python=\d+\.\d+\.\d+$/u.test(item))?.slice(7) : undefined
  const expectedManifest = lockSha ? exactTaskManifest(name, spec, digest, lockSha) : undefined
  const current = Manifest.safeParse(
    await Bun.file(path.join(target, ".openscience-environment.json"))
      .json()
      .catch(() => undefined),
  )
  if (
    current.success &&
    current.data.kind === "task" &&
    current.data.spec === digest &&
    current.data.conda_lock_sha256 === lockSha &&
    (!expectedManifest || sameManifest(current.data, expectedManifest)) &&
    (await executable(binary)) &&
    (lock && selected && python
      ? await attestExact(
          target,
          binary,
          digest,
          selected,
          lock,
          python,
          spec.pip_packages,
          spec.pip_requirements ?? "",
          expectedManifest!,
        )
      : await attestPython(binary))
  )
    return
  await state({ status: "installing", phase: `provisioning_task:${name}`, error: undefined })
  await replaceEnvironment(target, async () => {
    if (lock) {
      const file = path.join(stagingRoot(), `conda-lock-${crypto.randomUUID()}.txt`)
      await fs.mkdir(stagingRoot(), { recursive: true })
      await Bun.write(file, lock, { mode: 0o600 })
      try {
        await run([await installMicromamba(), "--no-rc", "create", "-y", "-p", target, "--file", file])
      } finally {
        await fs.rm(file, { force: true }).catch(() => undefined)
      }
    } else {
      const channels = spec.channels.flatMap((channel) => ["-c", channel])
      await run([await installMicromamba(), "--no-rc", "create", "-y", "-p", target, ...channels, ...spec.packages])
    }
    if (!(await executable(binary))) throw new Error(`Task environment '${name}' did not contain Python`)
    const fixture = Boolean(testSupport()?.ownershipFile)
    if (lock && selected && python) {
      if (!fixture) await ensureCondaArchives(digest, selected, lock)
      const conda = fixture ? await fixtureOwnership() : await condaOwnership(digest, selected, lock, python)
      if (!conda) throw new Error(`Task environment '${name}' did not retain its trusted Conda archives`)
      await cleanupGenerated(target, conda)
      if (!(await verifyOwnership(target, conda, { allowCondaMetadata: true }))) {
        throw new Error(`Task environment '${name}' failed Conda-only archive attestation before Python startup`)
      }
      const attestationLog = testSupport()?.attestationLog
      if (attestationLog) await fs.appendFile(attestationLog, "closure\n")
    }
    if (spec.pip_packages.length) {
      if (!spec.pip_requirements) {
        await run(
          [
            binary,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-cache-dir",
            "--no-deps",
            ...spec.pip_packages,
          ],
          { timeout: 45 * 60 * 1000 },
        )
      } else {
        const requirements = path.join(stagingRoot(), `requirements-${crypto.randomUUID()}.txt`)
        const wheels =
          lock && selected && !fixture
            ? await ensureWheelArchives(binary, python!, digest, selected, spec.pip_packages, spec.pip_requirements)
            : undefined
        await Bun.write(requirements, spec.pip_requirements, { mode: 0o600 })
        try {
          const args = [
            "install",
            "--disable-pip-version-check",
            "--no-deps",
            "--no-compile",
            "--only-binary=:all:",
            "--require-hashes",
            ...(wheels ? ["--no-index", "--find-links", wheels] : ["--no-cache-dir"]),
            "-r",
            requirements,
          ]
          if (lock && python) await runIsolatedPip(binary, python, args, 45 * 60 * 1000)
          else await run([binary, "-m", "pip", ...args], { timeout: 45 * 60 * 1000 })
        } finally {
          await fs.rm(requirements, { force: true }).catch(() => undefined)
        }
      }
    }
    if (lock && selected && python) {
      const ownership = await trustedOwnership(
        digest,
        selected,
        lock,
        python,
        spec.pip_packages,
        spec.pip_requirements ?? "",
      )
      if (!ownership) throw new Error(`Task environment '${name}' did not retain its trusted package archives`)
      await cleanupGenerated(target, ownership)
      await fs.rm(path.join(target, "conda-meta"), { recursive: true, force: true })
      if (!expectedManifest) throw new Error(`Task environment '${name}' did not produce an exact manifest`)
      await writeJson(path.join(target, ".openscience-environment.json"), expectedManifest)
      if (
        !(await attestExact(
          target,
          binary,
          digest,
          selected,
          lock,
          python,
          spec.pip_packages,
          spec.pip_requirements ?? "",
          expectedManifest,
        ))
      ) {
        throw new Error(`Task environment '${name}' failed archive-derived file attestation`)
      }
    } else if (!(await attestPython(binary))) {
      throw new Error(`Task environment '${name}' failed its Python probe`)
    }
    if (!expectedManifest) {
      const now = new Date().toISOString()
      await writeJson(path.join(target, ".openscience-environment.json"), {
        version: 1,
        name,
        language: "python",
        kind: "task",
        spec: digest,
        packages: [...spec.packages],
        pip_packages: [...spec.pip_packages],
        channels: [...spec.channels],
        conda_lock_sha256: lockSha,
        created_at: now,
        verified_at: now,
      } satisfies z.infer<typeof Manifest>)
    }
  })
}

const micromambaSetup: { value?: Promise<void> } = {}
const starterSetup: Partial<Record<ManagedEnvironmentLanguage, Promise<void>>> = {}

async function ensureMicromamba() {
  if (await installedMicromambaIsLocked()) return
  if (micromambaSetup.value) {
    await micromambaSetup.value
    if (await installedMicromambaIsLocked()) return
    micromambaSetup.value = undefined
  }
  const current = (async () => {
    await fs.mkdir(root(), { recursive: true })
    await using lease = await FileLease.acquire(path.join(root(), "micromamba.lock"), 45 * 60 * 1000)
    await installMicromamba()
  })()
  micromambaSetup.value = current
  try {
    await current
  } catch (error) {
    if (micromambaSetup.value === current) micromambaSetup.value = undefined
    throw error
  }
}

async function ensureLanguage(language: ManagedEnvironmentLanguage) {
  const existing = starterSetup[language]
  if (existing) return existing
  const current = (async () => {
    await fs.mkdir(root(), { recursive: true })
    await ensureMicromamba()
    await using lease = await FileLease.acquire(path.join(root(), `starter-${language}.lock`), 45 * 60 * 1000)
    try {
      await ensureStarter(language)
      await state({ status: "ready", phase: `ready:${language}`, error: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await state({ status: "failed", phase: `failed:${language}`, error: message }).catch(() => undefined)
      throw error
    }
  })()
  starterSetup[language] = current
  try {
    await current
  } catch (error) {
    if (starterSetup[language] === current) delete starterSetup[language]
    throw error
  }
}

export namespace ManagedEnvironments {
  export const pythonPackages = [...STARTERS.python.packages]
  export const rPackages = [...STARTERS.r.packages]

  export async function bootstrap() {
    if (process.env.OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP === "1") return
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS !== "1") return
    await ensureLanguage("python")
    await ensureLanguage("r")
    await state({ status: "ready", phase: "ready", error: undefined })
  }

  export async function status() {
    const current = await state()
    const environments = await Promise.all(
      (["python", "r"] as const).map(async (language) => {
        const manifest = Manifest.safeParse(
          await Bun.file(manifestPath(language))
            .json()
            .catch(() => undefined),
        )
        return {
          language,
          ready: await probe(language),
          path: environmentPath(language),
          packages: [...STARTERS[language].packages],
          manifest: manifest.success ? manifest.data : null,
        }
      }),
    )
    return { ...current, environments }
  }

  /** Create a machine-wide named Python environment only after the caller has
   * obtained package-install approval. Subsequent projects and sessions reuse
   * it; normal execution never creates environments as a side effect. */
  export async function ensureTask(name: string, spec?: ManagedTaskSpec) {
    const parsed = TaskName.parse(name)
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS !== "1") return
    const input = TaskSpec.parse(spec ?? {})
    const selected = input.conda_locks ? condaLockPlatform() : undefined
    if (input.conda_locks && !selected) {
      throw new Error(
        `Release-locked task environments require macOS 12+ on Apple Silicon or glibc 2.28+ Linux on arm64/x64; ${process.platform}/${process.arch} is unsupported`,
      )
    }
    const digest = taskDigest(input)
    if (input.lock_digest && input.lock_digest !== digest) {
      throw new Error(`Task environment '${parsed}' lock digest does not match its exact package specification`)
    }
    await ensureMicromamba()
    await using lease = await FileLease.acquire(path.join(root(), `task-${parsed}.lock`), 45 * 60 * 1000)
    await ensureTaskEnvironment(parsed, input, selected)
    await state({ status: "ready", phase: "ready", error: undefined })
  }

  export async function inspect(
    name: string,
    expected: {
      conda_lock?: string
      lock_digest?: string
      pip_packages?: readonly string[]
      pip_requirements?: string
      python?: string
    } = {},
    options: { verification?: "full" | "status" } = {},
  ) {
    const parsed = TaskName.parse(name)
    const target = environmentPath(parsed)
    const binary = path.join(target, process.platform === "win32" ? "python.exe" : "bin/python")
    const selected = expected.conda_lock ? condaLockPlatform() : undefined
    const manifest = Manifest.safeParse(
      await Bun.file(path.join(target, ".openscience-environment.json"))
        .json()
        .catch(() => undefined),
    )
    const exactRequested = Object.values(expected).some((value) => value !== undefined)
    const completeExact = Boolean(
      expected.conda_lock &&
      expected.lock_digest &&
      expected.python &&
      expected.pip_packages &&
      expected.pip_requirements !== undefined,
    )
    const expectedManifest =
      completeExact && expected.conda_lock && expected.lock_digest && expected.python && expected.pip_packages
        ? exactManifest(
            parsed,
            expected.lock_digest,
            digestBytes(expected.conda_lock),
            [`python=${expected.python}`, "pip=25.1.1"],
            expected.pip_packages,
            ["conda-forge"],
          )
        : undefined
    const receipt = IntegrityReceipt.safeParse(
      await Bun.file(integrityPath(parsed))
        .json()
        .catch(() => undefined),
    )
    const receiptMatches = Boolean(
      expectedManifest &&
      receipt.success &&
      receipt.data.name === parsed &&
      receipt.data.spec === expectedManifest.spec &&
      receipt.data.conda_lock_sha256 === expectedManifest.conda_lock_sha256 &&
      receipt.data.manifest_sha256 === digestBytes(JSON.stringify(expectedManifest, null, 2)),
    )
    if (options.verification === "status") {
      const manifestMatches = Boolean(
        expectedManifest && manifest.success && sameManifest(manifest.data, expectedManifest),
      )
      return {
        name: parsed,
        path: target,
        ready: Boolean((await executable(binary)) && manifestMatches && receiptMatches),
        manifest: manifest.success ? manifest.data : null,
        integrity:
          receiptMatches && receipt.success
            ? {
                state: "last_verified" as const,
                verified_at: receipt.data.verified_at,
                verification_required_before_execution: true,
              }
            : {
                state: "verification_needed" as const,
                verified_at: null,
                verification_required_before_execution: true,
              },
      }
    }
    const exact = Boolean(
      completeExact &&
      selected &&
      manifest.success &&
      expectedManifest &&
      sameManifest(manifest.data, expectedManifest) &&
      (await attestExact(
        target,
        binary,
        expected.lock_digest!,
        selected,
        expected.conda_lock!,
        expected.python!,
        expected.pip_packages!,
        expected.pip_requirements!,
        expectedManifest,
      )),
    )
    return {
      name: parsed,
      path: target,
      ready: (await executable(binary)) && (exactRequested ? exact : await attestPython(binary)),
      manifest: manifest.success ? manifest.data : null,
      integrity: exact
        ? {
            state: "verified" as const,
            verified_at: new Date().toISOString(),
            verification_required_before_execution: true,
          }
        : {
            state: "verification_needed" as const,
            verified_at: receipt.success ? receipt.data.verified_at : null,
            verification_required_before_execution: true,
          },
    }
  }

  export async function runtime(
    language: ManagedEnvironmentLanguage,
    environment: string = language,
  ): Promise<KernelStartOptions> {
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS !== "1") {
      if (environment !== language) {
        throw new Error(`Task environment '${environment}' is unavailable`)
      }
      return { environmentName: environment }
    }
    if (environment === language) await ensureLanguage(language)
    const prefix = environmentPath(environment)
    let binary =
      language === "python"
        ? path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python")
        : path.join(prefix, process.platform === "win32" ? "Scripts/Rscript.exe" : "bin/Rscript")
    if (environment === language && !(await executable(binary))) {
      delete starterSetup[language]
      await ensureLanguage(language)
      binary =
        language === "python"
          ? path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python")
          : path.join(prefix, process.platform === "win32" ? "Scripts/Rscript.exe" : "bin/Rscript")
    }
    if (!(await executable(binary))) {
      throw new Error(
        environment === language
          ? `Managed ${language} environment '${environment}' is unavailable. Open Settings → Compute to repair it.`
          : `Task environment '${environment}' is unavailable. Ask OpenScience to install its initial packages before using it.`,
      )
    }
    const bin = path.dirname(binary)
    return {
      binary,
      environmentName: environment,
      env: {
        CONDA_PREFIX: prefix,
        PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
        MAMBA_ROOT_PREFIX: root(),
      },
    }
  }

  export function startInBackground() {
    void bootstrap().catch((error) => log.warn("starter environment setup failed", { error: String(error) }))
  }
}
