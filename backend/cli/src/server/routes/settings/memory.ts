import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Memory } from "@/settings/memory"
import { lazy } from "@/util/lazy"
import z from "zod"

export const MemorySettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get memory",
        description: "Get the saved memory document for a scope (global or project).",
        operationId: "settings.memory.get",
        responses: {
          200: {
            description: "Memory document",
            content: { "application/json": { schema: resolver(Memory.Doc) } },
          },
        },
      }),
      validator("query", z.object({ scope: Memory.Scope.default("global") })),
      async (c) => c.json(await Memory.get(c.req.valid("query").scope)),
    )
    .put(
      "/",
      describeRoute({
        summary: "Set memory",
        description: "Replace the saved memory document for a scope (global or project).",
        operationId: "settings.memory.set",
        responses: {
          200: {
            description: "Updated memory document",
            content: { "application/json": { schema: resolver(Memory.Doc) } },
          },
        },
      }),
      validator("query", z.object({ scope: Memory.Scope.default("global") })),
      validator("json", Memory.Doc),
      async (c) => c.json(await Memory.set(c.req.valid("query").scope, c.req.valid("json"))),
    ),
)
