import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { BioNemoHosted } from "../../../science/bionemo"
import { ConnectorCatalog, ConnectorCatalogEntry } from "../../../mcp/catalog"
import { CapabilityEvidence, CapabilityEvidenceRecord } from "../../../science/capability/evidence"
import { CapabilityRegistry } from "../../../science/capability/registry"
import { CapabilityRuntime } from "../../../science/capability/runtime"
import {
  CapabilityAvailability,
  CapabilityAvailabilityState,
  CapabilityManifest,
  type CapabilityManifest as Manifest,
} from "../../../science/capability/schema"
import { lazy } from "../../../util/lazy"

const DetailedCapability = CapabilityManifest.safeExtend({ current_availability: CapabilityAvailability })

const Response = z
  .object({
    schema_version: z.literal(1),
    capabilities: DetailedCapability.array(),
    evidence: z.record(z.string(), CapabilityEvidenceRecord),
    connectors: ConnectorCatalogEntry.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).array(),
    counts: z.object({
      total: z.number().int(),
      packaged: z.number().int(),
      hosted: z.number().int(),
      verified: z.number().int(),
      experimental: z.number().int(),
      blocked: z.number().int(),
    }),
  })
  .strict()

export const ScientificToolsSettingsRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get scientific capability and connector catalogs",
      description:
        "Returns truthful manifest maturity, backend availability, release evidence, and reviewed connector setup records.",
      operationId: "settings.scientificTools",
      responses: {
        200: {
          description: "Scientific tools catalog",
          content: { "application/json": { schema: resolver(Response) } },
        },
      },
    }),
    async (c) => {
      const capabilities = CapabilityRegistry.listDetailed()
      const detailed = await Promise.all(
        capabilities.map(async (manifest) => ({
          ...manifest,
          current_availability: await currentAvailability(manifest),
        })),
      )
      const evidence = Object.fromEntries(
        Object.entries(await CapabilityEvidence.list()).filter(([, record]) => {
          const manifest = CapabilityRegistry.describe(record.capability.id)
          if (!manifest?.runtime) return false
          const binding = CapabilityRegistry.binding({ manifest, profile: "smoke" })
          return (
            record.capability.version === binding.version &&
            record.capability.manifest_sha256 === binding.manifest_sha256 &&
            record.capability.profile === binding.profile &&
            record.capability.runtime_digest === binding.runtime_digest
          )
        }),
      )
      return c.json(
        Response.parse({
          schema_version: 1,
          capabilities: detailed,
          evidence,
          connectors: ConnectorCatalog.list(),
          counts: {
            total: capabilities.length,
            packaged: capabilities.filter((item) => item.runtime).length,
            hosted: capabilities.filter((item) => item.hosted).length,
            verified: capabilities.filter((item) => item.maturity === "verified").length,
            experimental: capabilities.filter((item) => item.maturity === "experimental").length,
            blocked: capabilities.filter((item) => item.maturity === "blocked").length,
          },
        }),
      )
    },
  ),
)

async function currentAvailability(manifest: Manifest) {
  let current = { ...manifest.availability }
  if (manifest.runtime) {
    try {
      current = CapabilityAvailability.parse(
        (await CapabilityRuntime.doctor(manifest, { verification: "status" })).availability,
      )
    } catch {
      if (manifest.runtime.targets.includes("local")) current.local = "degraded"
      if (manifest.runtime.targets.includes("modal")) current.hosted = "degraded"
    }
  }
  if (manifest.hosted) {
    try {
      current.hosted = CapabilityAvailabilityState.parse((await BioNemoHosted.doctor(manifest.hosted.adapter_id)).state)
    } catch {
      current.hosted = "degraded"
    }
  }
  return CapabilityAvailability.parse(current)
}
