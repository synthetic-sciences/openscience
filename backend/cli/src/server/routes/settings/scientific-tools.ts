import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
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
import { lazy } from "@synsci/util/lazy"

const DetailedCapability = CapabilityManifest.safeExtend({ current_availability: CapabilityAvailability })

const SetupResult = z
  .object({
    capability: z.string(),
    state: z.literal("ready"),
    environment: z.string(),
    python: z.string(),
    packages: z.record(z.string(), z.string()),
    lock_digest: z.string(),
    conda_lock_sha256: z.string(),
  })
  .strict()

const SetupError = z
  .object({
    error: z.enum(["not_found", "not_installable"]),
    message: z.string(),
  })
  .strict()

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
  new Hono()
    .get(
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
        const availability = {
          runtime: new Map<string, Promise<z.infer<typeof CapabilityAvailability>>>(),
          hosted: new Map<string, Promise<z.infer<typeof CapabilityAvailabilityState>>>(),
        }
        const detailed = await Promise.all(
          capabilities.map(async (manifest) => ({
            ...manifest,
            current_availability: await currentAvailability(manifest, availability),
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
    )
    .post(
      "/:id/setup",
      describeRoute({
        summary: "Install a packaged scientific tool runtime",
        description:
          "Installs and verifies the exact device-local environment declared by a packaged capability manifest. The user initiates this operation explicitly from Settings.",
        operationId: "settings.scientificTool.setup",
        responses: {
          200: {
            description: "Scientific tool runtime installed",
            content: { "application/json": { schema: resolver(SetupResult) } },
          },
          404: {
            description: "Unknown capability",
            content: { "application/json": { schema: resolver(SetupError) } },
          },
          409: {
            description: "Capability has no packaged local runtime",
            content: { "application/json": { schema: resolver(SetupError) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().trim().min(1) })),
      async (c) => {
        const { id } = c.req.valid("param")
        const manifest = CapabilityRegistry.describe(id)
        if (!manifest)
          return c.json(SetupError.parse({ error: "not_found", message: `Unknown scientific capability: ${id}` }), 404)
        if (manifest.maturity === "blocked" || !manifest.runtime?.targets.includes("local"))
          return c.json(
            SetupError.parse({
              error: "not_installable",
              message: manifest.blocker ?? `${manifest.name} has no packaged local runtime.`,
            }),
            409,
          )
        return c.json(SetupResult.parse(await CapabilityRuntime.setup(manifest)))
      },
    ),
)

async function currentAvailability(
  manifest: Manifest,
  cache: {
    runtime: Map<string, Promise<z.infer<typeof CapabilityAvailability>>>
    hosted: Map<string, Promise<z.infer<typeof CapabilityAvailabilityState>>>
  },
) {
  let current = { ...manifest.availability }
  if (manifest.runtime) {
    try {
      const key = `${manifest.runtime.pack_id}:${manifest.runtime.lock_digest}`
      const status =
        cache.runtime.get(key) ??
        CapabilityRuntime.doctor(manifest, { verification: "status" }).then((result) =>
          CapabilityAvailability.parse(result.availability),
        )
      cache.runtime.set(key, status)
      current = await status
    } catch {
      if (manifest.runtime.targets.includes("local")) current.local = "degraded"
      if (manifest.runtime.targets.includes("modal")) current.hosted = "degraded"
    }
  }
  if (manifest.hosted) {
    try {
      const key = manifest.hosted.credential
      const status =
        cache.hosted.get(key) ??
        BioNemoHosted.doctor(manifest.hosted.adapter_id).then((result) =>
          CapabilityAvailabilityState.parse(result.state),
        )
      cache.hosted.set(key, status)
      current.hosted = await status
    } catch {
      current.hosted = "degraded"
    }
  }
  return CapabilityAvailability.parse(current)
}
