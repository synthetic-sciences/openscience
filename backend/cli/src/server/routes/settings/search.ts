import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { researchSearchConfigured } from "../../../tool/research-search"

export function SearchSettingsRoutes() {
  return new Hono().get(
    "/",
    describeRoute({
      summary: "Research search configuration",
      description:
        "Whether research_search has a configured Firecrawl or Ace credential. Does not verify quota, network permissions, or provider availability.",
      operationId: "settings.search",
      responses: {
        200: {
          description: "Search setup",
          content: { "application/json": { schema: resolver(z.object({ configured: z.boolean() })) } },
        },
      },
    }),
    async (c) => c.json({ configured: await researchSearchConfigured() }),
  )
}
