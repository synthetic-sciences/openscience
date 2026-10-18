import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { LoggingHealth } from "@/session/logging-health"
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
    .get(
      "/health",
      describeRoute({
        summary: "Read account, device and workspace-scoped server logging health for the last 24 hours",
        operationId: "settings.usageLogging.health",
        responses: {
          200: {
            description: "Server reconciliation or an explicit unavailable state",
            content: { "application/json": { schema: resolver(LoggingHealth.Result) } },
          },
        },
      }),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return c.json(await LoggingHealth.check())
      },
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
