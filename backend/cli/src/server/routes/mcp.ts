import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { MCP } from "../../mcp"
import { Config } from "../../config/config"
import { errors } from "../error"
import { lazy } from "@synsci/util/lazy"

const McpAuthPending = z
  .discriminatedUnion("pending", [
    z.object({
      pending: z.literal(true),
      authorizationUrl: z.string(),
      flowId: z.string(),
    }),
    z.object({
      pending: z.literal(false),
    }),
  ])
  .meta({ ref: "MCPAuthPending" })

export const McpRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get MCP status",
        description: "Get the status of all Model Context Protocol (MCP) servers.",
        operationId: "mcp.status",
        responses: {
          200: {
            description: "MCP server status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MCP.status())
      },
    )
    .get(
      "/:name",
      describeRoute({
        summary: "Inspect MCP server",
        description:
          "Get live status, authentication state, and discovered capabilities for one configured MCP server.",
        operationId: "mcp.inspect",
        responses: {
          200: {
            description: "MCP server inspection",
            content: {
              "application/json": {
                schema: resolver(MCP.Inspection),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        return c.json(await MCP.inspect(name))
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Add MCP server",
        description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
        operationId: "mcp.add",
        responses: {
          200: {
            description: "MCP server added successfully",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          config: Config.Mcp,
        }),
      ),
      async (c) => {
        const { name, config } = c.req.valid("json")
        const result = await MCP.add(name, config)
        return c.json(result.status)
      },
    )
    .put(
      "/:name/config",
      describeRoute({
        summary: "Persist MCP server",
        description: "Persistently add or update a Model Context Protocol (MCP) server in config.",
        operationId: "mcp.config.set",
        responses: {
          200: {
            description: "MCP server persisted successfully",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator(
        "json",
        z.object({
          config: Config.Mcp,
          scope: Config.Scope.optional(),
        }),
      ),
      async (c) => {
        const { name } = c.req.valid("param")
        const { config, scope = "global" } = c.req.valid("json")
        const current = scope === "global" ? await Config.getGlobal() : await Config.get()
        const parsed = Config.Mcp.safeParse(current.mcp?.[name])
        const next = Config.restoreMcp(config, parsed.success ? parsed.data : undefined)
        await Config.setMcp(name, next, scope)
        const result = await MCP.add(name, next)
        return c.json(result.status)
      },
    )
    .delete(
      "/:name/config",
      describeRoute({
        summary: "Remove MCP server",
        description: "Remove a Model Context Protocol (MCP) server from config and disconnect it.",
        operationId: "mcp.config.remove",
        responses: {
          200: {
            description: "MCP server removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("query", z.object({ scope: Config.Scope.optional() })),
      async (c) => {
        const { name } = c.req.valid("param")
        const { scope = "global" } = c.req.valid("query")
        await MCP.remove(name, scope)
        return c.json({ success: true as const })
      },
    )
    .post(
      "/:name/auth",
      describeRoute({
        summary: "Start MCP OAuth",
        description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
        operationId: "mcp.auth.start",
        responses: {
          200: {
            description: "OAuth flow started or existing credentials settled",
            content: {
              "application/json": {
                schema: resolver(MCP.AuthStart),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const supportsOAuth = await MCP.supportsOAuth(name)
        if (!supportsOAuth) {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        const result = await MCP.startAuth(name)
        return c.json(result)
      },
    )
    .get(
      "/:name/auth/pending",
      describeRoute({
        summary: "Read pending MCP OAuth",
        description: "Return the exact resumable browser authorization operation, if one exists.",
        operationId: "mcp.auth.pending",
        responses: {
          200: {
            description: "Pending OAuth operation",
            content: {
              "application/json": {
                schema: resolver(McpAuthPending),
              },
            },
          },
        },
      }),
      async (c) => {
        const pending = await MCP.pendingAuth(c.req.param("name"))
        return c.json(pending ? { pending: true, ...pending } : { pending: false })
      },
    )
    .post(
      "/:name/auth/wait",
      describeRoute({
        summary: "Wait for MCP OAuth",
        description: "Wait for an already-started browser OAuth operation without launching a second browser.",
        operationId: "mcp.auth.wait",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: { "application/json": { schema: resolver(MCP.Status) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("query", z.object({ flow_id: z.string().min(1) })),
      async (c) => c.json(await MCP.waitForAuth(c.req.param("name"), c.req.valid("query").flow_id)),
    )
    .post(
      "/:name/auth/callback",
      describeRoute({
        summary: "Complete MCP OAuth",
        description:
          "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
        operationId: "mcp.auth.callback",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(MCP.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          code: z.string().describe("Authorization code from OAuth callback"),
        }),
      ),
      async (c) => {
        const name = c.req.param("name")
        const { code } = c.req.valid("json")
        const status = await MCP.finishAuth(name, code)
        return c.json(status)
      },
    )
    .post(
      "/:name/auth/authenticate",
      describeRoute({
        summary: "Authenticate MCP OAuth",
        description: "Start OAuth flow and wait for callback (opens browser)",
        operationId: "mcp.auth.authenticate",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(MCP.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const supportsOAuth = await MCP.supportsOAuth(name)
        if (!supportsOAuth) {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        const status = await MCP.authenticate(name)
        return c.json(status)
      },
    )
    .delete(
      "/:name/auth/pending",
      describeRoute({
        summary: "Cancel pending MCP OAuth",
        description: "Cancel only the pending browser authorization flow without deleting existing credentials.",
        operationId: "mcp.auth.cancel",
        responses: {
          200: {
            description: "Pending OAuth flow cancelled",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("query", z.object({ flow_id: z.string().min(1) })),
      async (c) => {
        const name = c.req.param("name")
        const { flow_id } = c.req.valid("query")
        await MCP.cancelAuth(name, flow_id)
        return c.json({ success: true as const })
      },
    )
    .delete(
      "/:name/auth",
      describeRoute({
        summary: "Remove MCP OAuth",
        description: "Remove OAuth credentials for an MCP server",
        operationId: "mcp.auth.remove",
        responses: {
          200: {
            description: "OAuth credentials removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        await MCP.removeAuth(name)
        return c.json({ success: true as const })
      },
    )
    .post(
      "/:name/connect",
      describeRoute({
        description: "Connect an MCP server",
        operationId: "mcp.connect",
        responses: {
          200: {
            description: "MCP server connected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await MCP.connect(name)
        return c.json(true)
      },
    )
    .post(
      "/:name/disconnect",
      describeRoute({
        description: "Disconnect an MCP server",
        operationId: "mcp.disconnect",
        responses: {
          200: {
            description: "MCP server disconnected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await MCP.disconnect(name)
        return c.json(true)
      },
    ),
)
