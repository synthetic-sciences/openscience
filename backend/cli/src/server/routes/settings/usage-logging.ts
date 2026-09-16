import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { UsageLogging } from "@/session/usage-logging"

export const UsageLoggingRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get device session-trace sharing preference and delivery status",
        operationId: "settings.usageLogging.get",
        responses: {
          200: {
            description: "Session trace sharing",
            content: { "application/json": { schema: resolver(UsageLogging.Status) } },
          },
        },
      }),
      async (c) => c.json(await UsageLogging.status()),
    )
    .put(
      "/",
      describeRoute({
        summary: "Update device session-trace sharing; disabling discards queued records",
        operationId: "settings.usageLogging.update",
        responses: {
          200: {
            description: "Session trace sharing",
            content: { "application/json": { schema: resolver(UsageLogging.Status) } },
          },
        },
      }),
      validator("json", z.object({ enabled: z.boolean() }).strict()),
      async (c) => c.json(await UsageLogging.setEnabled(c.req.valid("json").enabled)),
    ),
)
