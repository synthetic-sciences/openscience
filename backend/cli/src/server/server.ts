import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { serveWebAsset } from "../web/serve"
import { isAllowedHost, isAllowedOrigin, isCrossOrigin } from "./host-guard"
import { timingSafeEqual } from "../util/timing-safe"
import { FolderResolveRoutes } from "./routes/folder-resolve"
import { AtlasBridgeRoutes } from "./routes/atlas-bridge"
import { RepoRoutes } from "./routes/repo"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@synsci/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill/skill"
import { Auth } from "../auth"
import { Command } from "../command"
import { Global } from "../global"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { lazy } from "../util/lazy"
import { InstanceBootstrap } from "../project/bootstrap"
import { Storage } from "../storage/storage"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { AccountRoutes } from "./routes/account"
import { SettingsSkillsRoutes } from "./routes/settings/skills"
import { MemorySettingsRoutes } from "./routes/settings/memory"
import { NetworkSettingsRoutes } from "./routes/settings/network"
import { CredentialsRoutes } from "./routes/settings/credentials"
import { StorageRoutes } from "./routes/settings/storage"
import { ComputeSettingsRoutes } from "./routes/settings/compute"
import { RegistryPermissionsRoutes } from "./routes/settings/registry-permissions"
import { SettingsPreferencesRoutes } from "./routes/settings/preferences"
import { LocalModelsRoutes } from "./routes/settings/local"
import { BillingSettingsRoutes } from "./routes/settings/billing"
import { WalletSettingsRoutes } from "./routes/settings/wallet"
import { SettingsUsageRoutes } from "./routes/settings/usage"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })

  let _url: URL | undefined
  let _corsWhitelist: string[] = []
  let _server: Bun.Server<unknown> | undefined

  // Per-process secret marking trusted in-process calls (Server.internalFetch).
  // Generated fresh each run, kept in memory, never sent to any client — a
  // network request cannot reproduce it.
  const INTERNAL_HEADER = "x-openscience-internal"
  const INTERNAL_NONCE = crypto.randomUUID()

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  export function requestIP(req: Request): string | undefined {
    return _server?.requestIP(req)?.address
  }

  const app = new Hono()
  export const App: () => Hono = lazy(
    () =>
      // TODO: Break server.ts into smaller route files to fix type inference
      app
        .onError((err, c) => {
          log.error("failed", {
            error: err,
          })
          if (err instanceof NamedError) {
            let status: ContentfulStatusCode
            if (err instanceof Storage.NotFoundError) status = 404
            else if (err instanceof Provider.ModelNotFoundError) status = 400
            else if (err.name.startsWith("Worktree")) status = 400
            else status = 500
            return c.json(err.toObject(), { status })
          }
          if (err instanceof HTTPException) return err.getResponse()
          const message = err instanceof Error && err.stack ? err.stack : err.toString()
          return c.json(new NamedError.Unknown({ message }).toObject(), {
            status: 500,
          })
        })
        .use(async (c, next) => {
          // In-process callers (Server.internalFetch) carry a per-process nonce
          // and are never network-reachable — trust them outright. Compare in
          // constant time so the nonce (which bypasses the host/origin guards)
          // can't be recovered byte-by-byte via a timing side channel.
          const internal = c.req.header(INTERNAL_HEADER)
          if (internal !== undefined && timingSafeEqual(internal, INTERNAL_NONCE)) return next()

          // 1. DNS-rebinding defense: only loopback Host values are accepted.
          const host = c.req.header("host") ?? new URL(c.req.url).host
          if (!isAllowedHost(host)) {
            return c.json({ error: "Forbidden host" }, 403)
          }

          // 2. Cross-origin defense (covers WebSocket upgrades, which CORS does
          //    not). A foreign Origin — or a cross-site fetch that omits Origin
          //    (e.g. a no-cors GET) — is rejected. See isCrossOrigin.
          if (isCrossOrigin(c.req.header("origin"), c.req.header("sec-fetch-site"), _corsWhitelist)) {
            return c.json({ error: "Forbidden origin" }, 403)
          }
          return next()
        })
        .use(async (c, next) => {
          const skipLogging = c.req.path === "/log"
          if (!skipLogging) {
            log.info("request", {
              method: c.req.method,
              path: c.req.path,
            })
          }
          const timer = log.time("request", {
            method: c.req.method,
            path: c.req.path,
          })
          await next()
          if (!skipLogging) {
            timer.stop()
          }
        })
        .use(
          cors({
            // Reuse the same allow-list the request guard enforces, so CORS
            // response headers and the cross-origin gate never drift apart.
            origin(input) {
              if (!input) return
              return isAllowedOrigin(input, _corsWhitelist) ? input : undefined
            },
          }),
        )
        .route("/global", GlobalRoutes())
        .route("/account", AccountRoutes())
        // Settings panels backed by global (project-independent) stores, so
        // mounted before the Instance.provide wrapper below (no directory).
        .route("/settings/credentials", CredentialsRoutes())
        .route("/settings/storage", StorageRoutes())
        .route("/settings/compute", ComputeSettingsRoutes())
        .route("/settings/permissions", RegistryPermissionsRoutes())
        .route("/settings/preferences", SettingsPreferencesRoutes())
        .route("/settings/local", LocalModelsRoutes())
        .route("/settings/billing", BillingSettingsRoutes())
        .route("/settings/wallet", WalletSettingsRoutes())
        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          validator("json", Auth.Info),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            // Don't depend on the client remembering to call global.sync —
            // stale provider state would keep serving the old credential.
            Provider.invalidate()
            return c.json(true)
          },
        )
        .delete(
          "/auth/:providerID",
          describeRoute({
            summary: "Remove auth credentials",
            description: "Remove authentication credentials",
            operationId: "auth.remove",
            responses: {
              200: {
                description: "Successfully removed authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            await Auth.remove(providerID)
            Provider.invalidate()
            return c.json(true)
          },
        )
        // Folder-resolve endpoints are filesystem-global (no project Instance
        // needed), so mount before the Instance.provide wrapper below.
        .route("/api/resolve-folder", FolderResolveRoutes())
        // Atlas graph bridge — proxies /api/thesis/* to the Atlas REST API
        // using the user's stored thk_ key (see routes/atlas-bridge.ts).
        .route("/api/thesis", AtlasBridgeRoutes())
        // Repository tab (status/commit/push/remote) — shells out to git.
        .route("/api/repo", RepoRoutes())
        .use(async (c, next) => {
          let directory = c.req.query("directory") || c.req.header("x-openscience-directory") || process.cwd()
          try {
            directory = decodeURIComponent(directory)
          } catch {
            // fallback to original value
          }
          return Instance.provide({
            directory,
            init: InstanceBootstrap,
            async fn() {
              return next()
            },
          })
        })
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "openscience",
                version: "0.0.3",
                description: "openscience api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .use(validator("query", z.object({ directory: z.string().optional() })))
        .route("/project", ProjectRoutes())
        .route("/pty", PtyRoutes())
        .route("/config", ConfigRoutes())
        .route("/experimental", ExperimentalRoutes())
        .route("/session", SessionRoutes())
        .route("/permission", PermissionRoutes())
        .route("/question", QuestionRoutes())
        .route("/provider", ProviderRoutes())
        .route("/", FileRoutes())
        .route("/mcp", McpRoutes())
        .route("/settings/skills", SettingsSkillsRoutes())
        .route("/settings/memory", MemorySettingsRoutes())
        .route("/settings/network", NetworkSettingsRoutes())
        .route("/settings/usage", SettingsUsageRoutes())
        .post(
          "/instance/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenScience instance, releasing all resources.",
            operationId: "instance.dispose",
            responses: {
              200: {
                description: "Instance disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.dispose()
            return c.json(true)
          },
        )
        .get(
          "/path",
          describeRoute({
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenScience instance.",
            operationId: "path.get",
            responses: {
              200: {
                description: "Path",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          home: z.string(),
                          state: z.string(),
                          config: z.string(),
                          worktree: z.string(),
                          directory: z.string(),
                        })
                        .meta({
                          ref: "Path",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              home: Global.Path.home,
              state: Global.Path.state,
              config: Global.Path.config,
              worktree: Instance.worktree,
              directory: Instance.directory,
            })
          },
        )
        .get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
            operationId: "vcs.get",
            responses: {
              200: {
                description: "VCS info",
                content: {
                  "application/json": {
                    schema: resolver(Vcs.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            const branch = await Vcs.branch()
            return c.json({
              branch,
            })
          },
        )
        .get(
          "/command",
          describeRoute({
            summary: "List commands",
            description: "Get a list of all available commands in the OpenScience system.",
            operationId: "command.list",
            responses: {
              200: {
                description: "List of commands",
                content: {
                  "application/json": {
                    schema: resolver(Command.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const commands = await Command.list()
            return c.json(commands)
          },
        )
        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              service: z.string().meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            const logger = Log.create({ service })

            switch (level) {
              case "debug":
                logger.debug(message, extra)
                break
              case "info":
                logger.info(message, extra)
                break
              case "error":
                logger.error(message, extra)
                break
              case "warn":
                logger.warn(message, extra)
                break
            }

            return c.json(true)
          },
        )
        .get(
          "/agent",
          describeRoute({
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenScience system.",
            operationId: "app.agents",
            responses: {
              200: {
                description: "List of agents",
                content: {
                  "application/json": {
                    schema: resolver(Agent.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const modes = await Agent.list()
            return c.json(modes)
          },
        )
        .get(
          "/skill",
          describeRoute({
            summary: "List skills",
            description: "Get a list of all available skills in the OpenScience system.",
            operationId: "app.skills",
            responses: {
              200: {
                description: "List of skills",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const skills = await Skill.all()
            return c.json(skills)
          },
        )
        .put(
          "/skill/:name",
          describeRoute({
            summary: "Write user skill",
            description: "Create or update a local user-authored skill.",
            operationId: "app.skill.write",
            responses: {
              200: {
                description: "Saved skill",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info),
                  },
                },
              },
            },
          }),
          validator("param", z.object({ name: z.string() })),
          validator("json", z.object({ content: z.string() })),
          async (c) => {
            const name = c.req.valid("param").name
            const content = c.req.valid("json").content
            return c.json(await Skill.writeUser({ name, content }))
          },
        )
        .delete(
          "/skill/:name",
          describeRoute({
            summary: "Delete user skill",
            description: "Delete a local user-authored skill.",
            operationId: "app.skill.delete",
            responses: {
              200: {
                description: "Deleted",
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
            return c.json(await Skill.deleteUser(c.req.valid("param").name))
          },
        )
        .get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        )
        .get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        )
        .get(
          "/event",
          describeRoute({
            summary: "Subscribe to events",
            description: "Get events",
            operationId: "event.subscribe",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(BusEvent.payloads()),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("event connected")
            return streamSSE(c, async (stream) => {
              stream.writeSSE({
                data: JSON.stringify({
                  type: "server.connected",
                  properties: {},
                }),
              })
              const unsub = Bus.subscribeAll(async (event) => {
                await stream.writeSSE({
                  data: JSON.stringify(event),
                })
                if (event.type === Bus.InstanceDisposed.type) {
                  stream.close()
                }
              })

              // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
              const heartbeat = setInterval(() => {
                stream.writeSSE({
                  data: JSON.stringify({
                    type: "server.heartbeat",
                    properties: {},
                  }),
                })
              }, 30000)

              await new Promise<void>((resolve) => {
                stream.onAbort(() => {
                  clearInterval(heartbeat)
                  unsub()
                  resolve()
                  log.info("event disconnected")
                })
              })
            })
          },
        )
        .all("/*", async (c) => {
          const csp =
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data: https://syntheticsciences.ai https://*.syntheticsciences.ai; object-src 'self' data: blob:; frame-src 'self' blob:"

          // Unmatched /api/* must 404 — never SPA-fallback (the SPA would
          // try to JSON.parse `<!doctype`) and never proxy upstream.
          if (c.req.path.startsWith("/api/")) return c.notFound()

          const local = await serveWebAsset(c)
          if (local) {
            local.headers.set("Content-Security-Policy", csp)
            return local
          }
          return c.notFound()
        }) as unknown as Hono,
  )

  /**
   * Build a fetch function for in-process callers. Requests carry the
   * per-process nonce header so the request guard trusts them without a
   * network Host/Origin (they are never network-reachable).
   */
  export function internalFetch(): typeof globalThis.fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      request.headers.set(INTERNAL_HEADER, INTERNAL_NONCE)
      return App().fetch(request)
    }) as typeof globalThis.fetch
  }

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "openscience",
          version: "1.0.0",
          description: "openscience api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export function listen(opts: { port: number; cors?: string[] }) {
    _corsWhitelist = opts.cors ?? []

    const args = {
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: App().fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url
    _server = server

    return server
  }
}
