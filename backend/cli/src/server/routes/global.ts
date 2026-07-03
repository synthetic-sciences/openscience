import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { OpenScience } from "@/openscience"
import { Provider } from "@/provider/provider"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenScience server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenScience system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        return streamSSE(c, async (stream) => {
          stream.writeSSE({
            data: JSON.stringify({
              payload: {
                type: "server.connected",
                properties: {},
              },
            }),
          })
          async function handler(event: any) {
            await stream.writeSSE({
              data: JSON.stringify(event),
            })
          }
          GlobalBus.on("event", handler)

          // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
          const heartbeat = setInterval(() => {
            stream.writeSSE({
              data: JSON.stringify({
                payload: {
                  type: "server.heartbeat",
                  properties: {},
                },
              }),
            })
          }, 30000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              GlobalBus.off("event", handler)
              resolve()
              log.info("global event disconnected")
            })
          })
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenScience configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenScience configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .get(
      "/config/raw",
      describeRoute({
        summary: "Get raw global configuration",
        description: "Read the verbatim global config file for the advanced editor.",
        operationId: "global.configRawGet",
        responses: {
          200: {
            description: "Raw global config",
            content: {
              "application/json": {
                schema: resolver(z.object({ content: z.string(), path: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobalRaw())
      },
    )
    .put(
      "/config/raw",
      describeRoute({
        summary: "Replace raw global configuration",
        description: "Overwrite the global config file verbatim (supports removing keys).",
        operationId: "global.configRawSet",
        responses: {
          200: {
            description: "Replaced global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ content: z.string() })),
      async (c) => {
        const next = await Config.replaceGlobal(c.req.valid("json").content)
        return c.json(next)
      },
    )
    .post(
      "/config/unset",
      describeRoute({
        summary: "Unset a global config key",
        description: "Remove a key path from the global config (deep-merge cannot unset).",
        operationId: "global.configUnset",
        responses: {
          200: {
            description: "Updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ path: z.array(z.string()).min(1) })),
      async (c) => {
        const result = await Config.unsetGlobal(c.req.valid("json").path)
        return c.json(result.config)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenScience instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
    .post(
      "/sync",
      describeRoute({
        summary: "Sync account services",
        description: "Refresh OpenScience account services and reload local provider/config state.",
        operationId: "global.sync",
        responses: {
          200: {
            description: "Services synced",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    user: z.unknown().optional(),
                    credentials: z.number(),
                    last_synced: z.number(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const result = await OpenScience.syncServices()
        Provider.invalidate()
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json({
          user: result?.user,
          credentials: result?.credentials ?? 0,
          last_synced: Date.now(),
        })
      },
    ),
)
