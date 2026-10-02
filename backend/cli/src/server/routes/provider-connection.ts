import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { parse } from "jsonc-parser"
import { McpUrl } from "@synsci/util/mcp-url"
import { Auth } from "../../auth"
import { Config } from "../../config/config"
import { CredentialLifecycle } from "../../credentials/lifecycle"

export const ProviderConnection = z.object({
  key: z.string().trim().min(1).optional(),
  baseURL: z
    .string()
    .trim()
    .default("")
    .refine((value) => {
      if (!value) return true
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return (
        !McpUrl.networkProblem(url, "Base URL", true) &&
        !url.search &&
        !url.hash &&
        !/\/(?:responses|chat\/completions|messages)\/?$/.test(url.pathname)
      )
    }, "Enter an HTTPS API base URL without credentials, query, fragment, or a request endpoint (loopback HTTP is allowed)."),
  api: z.enum(["responses", "chat"]).default("responses"),
})

export async function saveProviderConnection(id: string, input: z.infer<typeof ProviderConnection>) {
  return CredentialLifecycle.serialized(async () => {
    // Retain environment references verbatim instead of copying resolved secrets into config.
    const previous = Config.Info.parse(parse((await Config.getGlobalRaw()).content)).provider?.[id]
    const credential = await Auth.get(id)
    const options = { ...previous?.options }
    options.requiresCredential = true
    if (input.baseURL) options.baseURL = input.baseURL.replace(/\/+$/, "")
    else delete options.baseURL
    if (id === "openai") options.api = input.api
    try {
      if (input.key) await Auth.set(id, { type: "api", key: input.key })
      await Config.setProvider(id, { ...previous, options })
    } catch (cause) {
      const restored = await Promise.allSettled([
        previous ? Config.setProvider(id, previous) : Config.removeProvider(id),
        credential ? Auth.set(id, credential) : Auth.remove(id),
      ])
      const failures = restored.filter((result) => result.status === "rejected").map((result) => result.reason)
      if (failures.length)
        throw new AggregateError(
          [cause, ...failures],
          "Connection could not be saved or fully restored. Review the provider settings before retrying.",
        )
      throw cause
    }
    return true
  })
}

export function ProviderConnectionRoutes(invalidate: () => void) {
  return new Hono().put(
    "/:providerID/connection",
    describeRoute({
      summary: "Save a provider credential and API endpoint",
      operationId: "auth.connection",
      responses: {
        200: { description: "Saved connection", content: { "application/json": { schema: resolver(z.boolean()) } } },
      },
    }),
    validator("param", z.object({ providerID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/) })),
    validator("json", ProviderConnection),
    async (c) => {
      try {
        return c.json(await saveProviderConnection(c.req.valid("param").providerID, c.req.valid("json")))
      } finally {
        invalidate()
      }
    },
  )
}
