import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Network } from "@/settings/network"
import { lazy } from "@/util/lazy"
import z from "zod"

export const NetworkSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get network allow-list",
        description: "Get the domain allow-list catalog and the saved allow-list state.",
        operationId: "settings.network.get",
        responses: {
          200: {
            description: "Network catalog and state",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    catalog: Network.Group.array(),
                    state: Network.State,
                    allowlist: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) =>
        c.json({
          catalog: Network.CATALOG,
          state: await Network.get(),
          allowlist: await Network.allowlist(),
        }),
    )
    .put(
      "/",
      describeRoute({
        summary: "Set network allow-list",
        description: "Persist the domain allow-list state (enabled groups + custom domains).",
        operationId: "settings.network.set",
        responses: {
          200: {
            description: "Updated network state",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    state: Network.State,
                    allowlist: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator("json", Network.State),
      async (c) => {
        const state = await Network.set(c.req.valid("json"))
        return c.json({ state, allowlist: await Network.allowlist() })
      },
    ),
)
