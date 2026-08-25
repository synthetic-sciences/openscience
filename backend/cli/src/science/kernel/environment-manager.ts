import { Global } from "@/global"
import { FileLease } from "@/util/file-lease"
import { Log } from "@/util/log"
import crypto from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import type { KernelStartOptions } from "./types"

const log = Log.create({ service: "science.environment" })

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
  channels: z.string().array(),
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

const root = () => path.join(Global.Path.data, "conda")
const environmentRoot = () => path.join(root(), "envs")
const stagingRoot = () => path.join(root(), ".staging")
const rollbackRoot = () => path.join(root(), ".rollback")
const statePath = () => path.join(root(), "state.json")
const executableName = () => (process.platform === "win32" ? "micromamba.exe" : "micromamba")
const micromamba = () => path.join(root(), "bin", executableName())
const environmentPath = (name: string) => path.join(environmentRoot(), name)
const manifestPath = (name: string) => path.join(environmentPath(name), ".openscience-environment.json")

const platform = () => {
  if (process.platform === "darwin" && process.arch === "arm64") return "osx-arm64"
  if (process.platform === "darwin" && process.arch === "x64") return "osx-64"
  if (process.platform === "linux" && process.arch === "arm64") return "linux-aarch64"
  if (process.platform === "linux" && process.arch === "x64") return "linux-64"
  if (process.platform === "win32" && process.arch === "x64") return "win-64"
  throw new Error(`Managed scientific environments are not available on ${process.platform}/${process.arch}`)
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

async function run(command: string[], options: { cwd?: string; timeout?: number } = {}) {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, MAMBA_ROOT_PREFIX: root(), MAMBA_NO_RC: "true" },
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

async function installMicromamba() {
  if (await executable(micromamba())) return micromamba()
  await state({ status: "installing", phase: "installing_micromamba", error: undefined })
  const archive = path.join(stagingRoot(), `micromamba-${crypto.randomUUID()}.tar.bz2`)
  const extracted = path.join(stagingRoot(), `micromamba-${crypto.randomUUID()}`)
  await fs.mkdir(extracted, { recursive: true })
  const response = await fetch(`https://micro.mamba.pm/api/micromamba/${platform()}/latest`, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Micromamba download failed with HTTP ${response.status}`)
  await Bun.write(archive, await response.arrayBuffer(), { mode: 0o600 })
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
  await fs.mkdir(path.dirname(micromamba()), { recursive: true })
  await fs.copyFile(source, micromamba())
  if (process.platform !== "win32") await fs.chmod(micromamba(), 0o755)
  await fs.rm(archive, { force: true }).catch(() => undefined)
  await fs.rm(extracted, { recursive: true, force: true }).catch(() => undefined)
  return micromamba()
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

async function ensureStarter(language: ManagedEnvironmentLanguage) {
  if (await probe(language)) return
  const spec = STARTERS[language]
  await state({ status: "installing", phase: `provisioning_${language}`, error: undefined })
  const stage = path.join(stagingRoot(), `${language}-${crypto.randomUUID()}`)
  await fs.mkdir(stagingRoot(), { recursive: true })
  const channels = spec.channels.flatMap((channel) => ["-c", channel])
  await run([await installMicromamba(), "--no-rc", "create", "-y", "-p", stage, ...channels, ...spec.packages])
  if (!(await probe(language, stage))) throw new Error(`${language} starter environment failed its import probe`)
  const now = new Date().toISOString()
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ channels: spec.channels, packages: spec.packages }))
    .digest("hex")
  await writeJson(path.join(stage, ".openscience-environment.json"), {
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
  await fs.mkdir(environmentRoot(), { recursive: true })
  const target = environmentPath(language)
  const previous = path.join(rollbackRoot(), `${language}-${Date.now()}`)
  if (await fs.stat(target).catch(() => undefined)) {
    await fs.mkdir(rollbackRoot(), { recursive: true })
    await fs.rename(target, previous)
  }
  await fs.rename(stage, target).catch(async (error) => {
    if (await fs.stat(previous).catch(() => undefined)) await fs.rename(previous, target).catch(() => undefined)
    throw error
  })
}

async function ensureTaskEnvironment(name: string) {
  const target = environmentPath(name)
  const binary = path.join(target, process.platform === "win32" ? "python.exe" : "bin/python")
  if (await executable(binary)) return
  await state({ status: "installing", phase: `provisioning_task:${name}`, error: undefined })
  const stage = path.join(stagingRoot(), `${name}-${crypto.randomUUID()}`)
  await fs.mkdir(stagingRoot(), { recursive: true })
  await run([
    await installMicromamba(),
    "--no-rc",
    "create",
    "-y",
    "-p",
    stage,
    "-c",
    "conda-forge",
    "python=3.11",
    "pip",
  ])
  const stageBinary = path.join(stage, process.platform === "win32" ? "python.exe" : "bin/python")
  if (!(await executable(stageBinary))) throw new Error(`Task environment '${name}' did not contain Python`)
  await run([stageBinary, "-I", "-c", 'print("ok")'], { timeout: 30_000 })
  const now = new Date().toISOString()
  await writeJson(path.join(stage, ".openscience-environment.json"), {
    version: 1,
    name,
    language: "python",
    kind: "task",
    spec: crypto.createHash("sha256").update("python=3.11\npip").digest("hex"),
    packages: ["python=3.11", "pip"],
    channels: ["conda-forge"],
    created_at: now,
    verified_at: now,
  } satisfies z.infer<typeof Manifest>)
  await fs.mkdir(environmentRoot(), { recursive: true })
  await fs.rename(stage, target)
}

const setup: { value?: Promise<void> } = {}

export namespace ManagedEnvironments {
  export const pythonPackages = [...STARTERS.python.packages]
  export const rPackages = [...STARTERS.r.packages]

  export async function bootstrap() {
    if (process.env.OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP === "1") return
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS !== "1") return
    const current =
      setup.value ??
      (async () => {
        await fs.mkdir(root(), { recursive: true })
        await using lease = await FileLease.acquire(path.join(root(), "bootstrap.lock"), 45 * 60 * 1000)
        try {
          await installMicromamba()
          await ensureStarter("python")
          await ensureStarter("r")
          await state({ status: "ready", phase: "ready", error: undefined })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await state({ status: "failed", phase: "failed", error: message }).catch(() => undefined)
          throw error
        }
      })()
    setup.value = current
    return current.finally(() => {
      if (setup.value === current) setup.value = undefined
    })
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
  export async function ensureTask(name: string) {
    const parsed = TaskName.parse(name)
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS !== "1") return
    await bootstrap()
    await using lease = await FileLease.acquire(path.join(root(), `task-${parsed}.lock`), 45 * 60 * 1000)
    await ensureTaskEnvironment(parsed)
    await state({ status: "ready", phase: "ready", error: undefined })
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
    if (environment === language) await bootstrap()
    const prefix = environmentPath(environment)
    const binary =
      language === "python"
        ? path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python")
        : path.join(prefix, process.platform === "win32" ? "Scripts/Rscript.exe" : "bin/Rscript")
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
