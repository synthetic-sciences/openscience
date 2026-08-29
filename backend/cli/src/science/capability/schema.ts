import z from "zod"
import { JobBroker } from "@/compute/job-broker"

export const CapabilityMaturity = z.enum(["verified", "experimental", "blocked"])
export type CapabilityMaturity = z.infer<typeof CapabilityMaturity>
export const CapabilityStatus = CapabilityMaturity
export type CapabilityStatus = CapabilityMaturity
export const CapabilityAvailabilityState = z.enum([
  "ready",
  "configured",
  "setup_needed",
  "degraded",
  "unavailable",
  "not_applicable",
])
export type CapabilityAvailabilityState = z.infer<typeof CapabilityAvailabilityState>
export const CapabilityAvailability = z
  .object({ local: CapabilityAvailabilityState, hosted: CapabilityAvailabilityState })
  .strict()
export type CapabilityAvailability = z.infer<typeof CapabilityAvailability>
export const CapabilityCategory = z.enum([
  "analysis",
  "visualization",
  "bioinformatics",
  "cheminformatics",
  "structure",
  "docking",
  "protein_design",
  "genomics",
  "molecular_modeling",
  "quantum",
  "mass_spectrometry",
  "chromatography",
  "synthesis",
  "document",
])
export type CapabilityCategory = z.infer<typeof CapabilityCategory>
export const CapabilityPackagePin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+==[^=<>!~\s]+$/, "Capability packages must use an exact version pin")
export type CapabilityPackagePin = z.infer<typeof CapabilityPackagePin>
export const CapabilitySource = z
  .object({
    kind: z.enum(["pypi", "conda", "github", "system", "nvidia_nim"]),
    name: z.string().trim().min(1).max(160),
    version: z.string().trim().min(1).max(160),
    reference: z.string().trim().url(),
    license: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
export type CapabilitySource = z.infer<typeof CapabilitySource>
export const CapabilitySmoke = z
  .object({
    id: z.string().trim().min(1).max(120),
    script_digest: z.string().regex(/^[a-f0-9]{64}$/),
    language: z.literal("python"),
    result_path: z.string().trim().min(1).max(240),
    artifacts: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
    max_artifact_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    timeout_seconds: z.number().int().min(5).max(600),
    summary: z.string().trim().min(1).max(240),
    invariants: z.array(z.string().trim().min(1).max(240)).min(1).max(12),
  })
  .strict()
export type CapabilitySmoke = z.infer<typeof CapabilitySmoke>
export const CapabilityRuntime = z
  .object({
    kind: z.literal("python_pack"),
    pack_id: z.string().trim().min(1).max(120),
    python: z.string().regex(/^\d+\.\d+\.\d+$/),
    targets: z
      .array(z.enum(["local", "modal"]))
      .min(1)
      .max(2),
    local_platforms: z.array(z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"])).max(5),
    local_locks: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    image: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/, "Capability images must use an immutable sha256 digest"),
    lock_digest: z.string().regex(/^[a-f0-9]{64}$/),
    packages: CapabilityPackagePin.array().min(1).max(100),
    pip_requirements: z.string().trim().min(1).max(100_000),
    resources: z
      .object({
        cpus: z.number().int().min(1).max(16),
        memory_gb: z.number().min(0.5).max(64),
        time_minutes: z.number().int().min(1).max(120),
        gpu: z.literal("none"),
      })
      .strict(),
    network: z.object({ build: z.literal("package_index_only"), execution: z.literal("none") }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const supportedPlatforms = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"])
    for (const key of Object.keys(value.local_locks)) {
      if (supportedPlatforms.has(key)) continue
      ctx.addIssue({
        code: "custom",
        path: ["local_locks", key],
        message: "Local lock platform is not supported",
      })
    }
    if (value.targets.includes("local") && value.local_platforms.length === 0) {
      ctx.addIssue({ code: "custom", path: ["local_platforms"], message: "Local runtimes require a platform lock" })
    }
    if (value.targets.includes("local") && Object.keys(value.local_locks).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["local_locks"],
        message: "Local runtimes require immutable per-platform locks",
      })
    }
    if (!value.targets.includes("local") && value.local_platforms.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["local_platforms"],
        message: "Hosted-only runtimes cannot advertise local platforms",
      })
    }
    if (!value.targets.includes("local") && Object.keys(value.local_locks).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["local_locks"],
        message: "Hosted-only runtimes cannot advertise local lockfiles",
      })
    }
    if (
      JSON.stringify(Object.keys(value.local_locks).toSorted()) !==
      JSON.stringify([...value.local_platforms].toSorted())
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["local_locks"],
        message: "Local lock platforms must match the advertised local platforms exactly",
      })
    }
    const locked = new Set(
      value.pip_requirements
        .split(/\r?\n/u)
        .map((line) => line.trim().split(/\s+/u)[0])
        .filter(Boolean),
    )
    if (locked.size !== value.packages.length || value.packages.some((pin) => !locked.has(pin))) {
      ctx.addIssue({
        code: "custom",
        path: ["pip_requirements"],
        message: "Hashed requirements must cover every exact package pin once",
      })
    }
    if (!value.pip_requirements.split(/\r?\n/u).every((line) => !line.trim() || line.includes("--hash=sha256:"))) {
      ctx.addIssue({
        code: "custom",
        path: ["pip_requirements"],
        message: "Every locked requirement must include an approved sha256 wheel hash",
      })
    }
  })
export type CapabilityRuntime = z.infer<typeof CapabilityRuntime>
export const CapabilityHosted = z
  .object({
    kind: z.literal("nvidia_nim"),
    adapter_id: z.enum([
      "boltz2",
      "diffdock",
      "evo2",
      "genmol",
      "molmim",
      "msa-search",
      "openfold2",
      "openfold3",
      "proteinmpnn",
      "rfdiffusion",
    ]),
    credential: z.literal("nvidia_nim"),
    docs_url: z.string().url(),
    terms_url: z.string().url(),
  })
  .strict()
export type CapabilityHosted = z.infer<typeof CapabilityHosted>
export const CapabilitySetup = z
  .object({
    instructions: z.string().trim().min(1).max(1_000),
    requirements: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  })
  .strict()
export type CapabilitySetup = z.infer<typeof CapabilitySetup>
export const CapabilityManifest = z
  .object({
    schema_version: z.literal(2),
    id: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().trim().min(1).max(120),
    category: CapabilityCategory,
    summary: z.string().trim().min(1).max(600),
    maturity: CapabilityMaturity,
    availability: CapabilityAvailability,
    basis: z.string().trim().min(1).max(1_500),
    source: CapabilitySource,
    runtime: CapabilityRuntime.optional(),
    smoke: CapabilitySmoke.optional(),
    hosted: CapabilityHosted.optional(),
    setup: CapabilitySetup.optional(),
    blocker: z.string().trim().min(1).max(1_500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.runtime && !value.smoke) || (!value.runtime && value.smoke))
      ctx.addIssue({
        code: "custom",
        path: ["smoke"],
        message: "Packaged runtimes and smoke contracts must be declared together",
      })
    if (value.maturity === "blocked" && !value.blocker)
      ctx.addIssue({ code: "custom", path: ["blocker"], message: "Blocked capabilities require a blocker" })
    if (!value.runtime && !value.hosted && !value.setup && value.maturity !== "blocked")
      ctx.addIssue({
        code: "custom",
        path: ["setup"],
        message: "Catalog-only capabilities require truthful setup guidance",
      })
    if (value.availability.local === "ready" && !value.runtime)
      ctx.addIssue({
        code: "custom",
        path: ["availability", "local"],
        message: "Local readiness requires a packaged runtime",
      })
    if (value.availability.hosted === "ready" && !value.runtime?.targets.includes("modal") && !value.hosted)
      ctx.addIssue({
        code: "custom",
        path: ["availability", "hosted"],
        message: "Hosted readiness requires a Modal runtime or hosted adapter",
      })
  })
export type CapabilityManifest = z.infer<typeof CapabilityManifest>
/** Callers describe work but cannot replace the pinned environment, GPU, or secrets. */
export const CapabilityWorkload = z
  .object({
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    command: z.string().trim().min(1).max(100_000),
    target: z.enum(["local", "modal"]),
    cwd: z.string().trim().min(1).max(2_000).optional(),
    resources: z
      .object({
        cpus: z.number().int().min(1).max(16).optional(),
        memory_gb: z.number().min(0.5).max(64).optional(),
        time_minutes: z.number().int().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    artifacts: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    uploads: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  })
  .strict()
export type CapabilityWorkload = z.infer<typeof CapabilityWorkload>
export const CapabilityCompiledJob = JobBroker.Input.extend({ capability: JobBroker.CapabilityBinding })
export type CapabilityCompiledJob = z.infer<typeof CapabilityCompiledJob>
