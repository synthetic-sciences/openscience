import { Global } from "@/global"
import { Installation } from "@/installation"
import { JsonStore } from "@/util/jsonstore"
import path from "node:path"
import z from "zod"
import type { CapabilityBinding } from "./registry"

export const CapabilityEvidenceRecord = z
  .object({
    schema_version: z.literal(1),
    capability: z.object({
      id: z.string(),
      version: z.string(),
      manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      profile: z.literal("smoke"),
      runtime_digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    target: z.enum(["local", "modal"]),
    job_id: z.string(),
    app_version: z.string(),
    release_sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    verified_at: z.string(),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    artifacts: z.array(
      z.object({
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  })
  .strict()
export type CapabilityEvidenceRecord = z.infer<typeof CapabilityEvidenceRecord>

const filepath = () => path.join(Global.Path.data, "scientific-capability-evidence.json")
const key = (id: string, target: "local" | "modal") => `${id}:${target}`

export namespace CapabilityEvidence {
  export function releaseSource(
    input: {
      artifactSource?: string
      artifactVersion?: string
      declaredSource?: string
      githubSource?: string
    } = {},
  ) {
    const artifactSource = input.artifactSource ?? Installation.ARTIFACT_SOURCE
    const artifactVersion = input.artifactVersion ?? Installation.VERSION
    const declared = [input.declaredSource, input.githubSource].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    )
    if (artifactSource && !/^[a-f0-9]{40}$/.test(artifactSource)) {
      throw new Error(`Embedded scientific capability artifact source is invalid: ${artifactSource}`)
    }
    for (const value of declared) {
      if (!/^[a-f0-9]{40}$/.test(value)) {
        throw new Error(`Scientific capability release source is not an exact lowercase Git SHA: ${value}`)
      }
    }
    if (!artifactSource && declared.length > 0) {
      if (artifactVersion === "local") return undefined
      throw new Error(`This OpenScience artifact does not embed a release source; refusing to mint release evidence`)
    }
    for (const value of declared) {
      if (value !== artifactSource) {
        throw new Error(`Scientific capability release source mismatch: artifact=${artifactSource} runtime=${value}`)
      }
    }
    return artifactSource
  }

  export async function list() {
    const data = await JsonStore.read(filepath())
    return Object.fromEntries(
      Object.entries(data).flatMap(([id, value]) => {
        const parsed = CapabilityEvidenceRecord.safeParse(value)
        return parsed.success ? [[id, parsed.data] as const] : []
      }),
    )
  }

  export async function forCapability(id: string) {
    const all = await list()
    return Object.values(all).filter((item) => item.capability.id === id)
  }

  export async function get(id: string) {
    const entries = await forCapability(id)
    return entries.sort((left, right) => right.verified_at.localeCompare(left.verified_at))[0]
  }

  export async function record(input: {
    binding: CapabilityBinding
    target: "local" | "modal"
    job_id: string
    metrics: Record<string, string | number | boolean>
    artifacts: Array<{ path: string; size: number; sha256: string }>
  }) {
    const release = releaseSource({
      declaredSource: process.env.OPENSCIENCE_RELEASE_SHA,
      githubSource: process.env.GITHUB_SHA,
    })
    const value = CapabilityEvidenceRecord.parse({
      schema_version: 1,
      capability: {
        id: input.binding.id,
        version: input.binding.version,
        manifest_sha256: input.binding.manifest_sha256,
        profile: "smoke",
        runtime_digest: input.binding.runtime_digest,
      },
      target: input.target,
      job_id: input.job_id,
      app_version: Installation.VERSION,
      release_sha: release,
      verified_at: new Date().toISOString(),
      metrics: input.metrics,
      artifacts: input.artifacts,
    })
    await JsonStore.update(filepath(), (data) => ({ ...data, [key(input.binding.id, input.target)]: value }))
    return value
  }
}
