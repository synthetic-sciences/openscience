import z from "zod"
import { JobBroker } from "@/compute/job-broker"

export const CapabilityStatus = z.enum(["verified", "experimental", "blocked"])
export type CapabilityStatus = z.infer<typeof CapabilityStatus>

export const CapabilityPackagePin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+==[^=<>!~\s]+$/, "Capability packages must use an exact version pin")

export const CapabilityManifest = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1),
    category: z.enum(["analysis", "visualization", "bioinformatics", "cheminformatics", "structure"]),
    summary: z.string().min(1),
    status: CapabilityStatus,
    basis: z.string().min(1),
    execution: z
      .object({
        kind: z.literal("compute_job"),
        targets: z.array(z.literal("modal")).min(1),
        packages: z.array(CapabilityPackagePin).max(20),
        image: z.string().trim().min(1).optional(),
        gpu: z.string().trim().min(1).optional(),
      })
      .optional(),
    blocker: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "blocked" && !value.blocker) {
      ctx.addIssue({ code: "custom", path: ["blocker"], message: "Blocked capabilities require a blocker" })
    }
    if (value.status !== "blocked" && !value.execution) {
      ctx.addIssue({ code: "custom", path: ["execution"], message: "Runnable capabilities require execution" })
    }
  })
export type CapabilityManifest = z.infer<typeof CapabilityManifest>

export const CapabilityPlanInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    command: z.string().trim().min(1).max(100_000),
    target: JobBroker.Target,
    cwd: z.string().trim().min(1).max(2_000).optional(),
    resources: JobBroker.Resources.optional(),
    artifacts: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    uploads: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    packages: z.array(CapabilityPackagePin).max(100).optional(),
    secret_refs: JobBroker.SecretRef.array().max(8).optional(),
  })
  .strict()
export type CapabilityPlanInput = z.infer<typeof CapabilityPlanInput>
