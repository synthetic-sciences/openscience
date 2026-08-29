import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@synsci/util/error"
import z from "zod/v4"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback, OAUTH_AUTHORIZATION_FAILED_MESSAGE, OAuthAuthorizationFailedError } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import open from "open"
import { OpenScience } from "@/openscience"
import { CredentialProcessLedger } from "@/credentials/process-ledger"
import { ProjectTrust } from "@/project/trust"
import { AuthoritySignal } from "@/project/authority-signal"
import { Sandbox } from "@/sandbox/sandbox"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { invocation as groupLauncherInvocation } from "./group-launcher"
import { UpdateQuiescence } from "@/process/update-quiescence"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { FileLease } from "@/util/file-lease"
import { Global } from "@/global"
import { McpRemoteUrl } from "./remote-url"
import { McpSecretStorage } from "./secret-storage"

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000
  const CLI_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url))

  async function waitForOwnedGroup(marker: string, pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const owner = await fsp.readFile(marker, "utf8").catch(() => undefined)
      if (owner?.trim() === String(pid)) return
      await Bun.sleep(10)
    }
    throw new Error(`Local MCP process ${pid} did not establish an owned process group`)
  }

  export const Resource = z
    .object({
      name: z.string(),
      uri: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      client: z.string(),
    })
    .meta({ ref: "McpResource" })
  export type Resource = z.infer<typeof Resource>

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const BrowserOpenFailed = BusEvent.define(
    "mcp.browser.open.failed",
    z.object({
      mcpName: z.string(),
      url: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client
  type ToolList = Awaited<ReturnType<MCPClient["listTools"]>>
  const credentialProcesses = new WeakMap<MCPClient, string>()
  const localClients = new WeakSet<MCPClient>()
  const localSandboxes = new WeakMap<MCPClient, Sandbox.Wrapped>()
  const toolLists = new WeakMap<MCPClient, { value: ToolList; at: number }>()
  const toolRequests = new WeakMap<MCPClient, Promise<ToolList>>()
  const toolRevisions = new WeakMap<MCPClient, number>()
  const TOOL_LIST_TTL_MS = 30_000

  function remoteAuthority(entry: Config.Mcp): string {
    const { enabled: _enabled, ...authority } = entry
    return JSON.stringify(authority)
  }

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }

  async function oauthAuthorityFingerprint(entry: Config.Mcp): Promise<string> {
    if (entry.type !== "remote") throw new Error("OAuth authority requires a remote MCP configuration")
    const authority = {
      type: entry.type,
      url: new URL(entry.url).toString(),
      headers: entry.headers ?? {},
      oauth: entry.oauth ?? null,
    }
    return McpSecretStorage.identifier("oauth-authority", JSON.stringify(canonical(authority)))
  }

  function oauthFlowId(state: string): Promise<string> {
    return McpSecretStorage.identifier("oauth-flow", state)
  }

  async function withConnectorOperation<T>(
    mcpName: string,
    action: () => Promise<T>,
    timeout = 2 * DEFAULT_TIMEOUT,
  ): Promise<T> {
    const digest = await McpSecretStorage.identifier("connector-operation-lock", mcpName)
    const lock = path.join(Global.Path.data, "mcp-operations", `${digest}.lock`)
    await using lease = await FileLease.acquire(lock, timeout)
    return await lease.during(action)
  }

  async function oauthFlowMatches(
    config: Config.Mcp,
    flow: Awaited<ReturnType<typeof McpAuth.pendingOAuthFlow>>,
  ): Promise<boolean> {
    if (!flow || config.type !== "remote" || !flow.serverUrl || !flow.authorityFingerprint) return false
    return (
      new URL(config.url).toString() === flow.serverUrl &&
      (await oauthAuthorityFingerprint(config)) === flow.authorityFingerprint &&
      (config.enabled !== false || flow.allowDisabled === true)
    )
  }

  async function assertRemoteAuthority(
    mcpName: string,
    expected: Config.Mcp,
    options: { allowDisabled?: boolean } = {},
  ): Promise<Extract<Config.Mcp, { type: "remote" }>> {
    if (expected.type !== "remote") throw new Error(`MCP connector ${mcpName} is not remote`)
    const expectedAuthority = remoteAuthority(expected)
    const current = (await Config.getExecution()).mcp?.[mcpName]
    if (
      !current ||
      !isMcpConfigured(current) ||
      current.type !== "remote" ||
      remoteAuthority(current) !== expectedAuthority ||
      (current.enabled === false && !options.allowDisabled)
    ) {
      throw new Error(`MCP connector ${mcpName} changed before its authenticated request was dispatched`)
    }
    return current
  }

  function remoteCredentialFetch(mcpName: string, expected: Config.Mcp, options: { allowDisabled?: boolean } = {}) {
    if (expected.type !== "remote") throw new Error(`MCP connector ${mcpName} is not remote`)
    const endpointOrigin = McpRemoteUrl.endpoint(expected.url).origin
    let fingerprint: Promise<string> | undefined
    const authorityFingerprint = () => (fingerprint ??= oauthAuthorityFingerprint(expected))
    return (url: string | URL, init?: RequestInit) => {
      let approved: RequestInit | undefined
      return CredentialLifecycle.dispatch(
        async () => {
          const current = await assertRemoteAuthority(mcpName, expected, options)
          const targetOrigin = McpRemoteUrl.discovered(url, expected.url, "MCP or OAuth request URL").origin
          const headers = new Headers(init?.headers)
          if (targetOrigin !== endpointOrigin) {
            // Configured headers are authority for the MCP endpoint, not for a
            // discovered OAuth issuer. Never forward them across origins.
            for (const name of Object.keys(current.headers ?? {})) headers.delete(name)
            const accessToken = (await McpAuth.getForAuthority(mcpName, current.url, await authorityFingerprint()))
              ?.tokens?.accessToken
            if (accessToken && headers.get("authorization") === `Bearer ${accessToken}`) {
              headers.delete("authorization")
            }
          }
          approved = { ...init, headers }

          const authorization = headers.get("authorization")
          if (!authorization?.toLowerCase().startsWith("bearer ")) return
          const configured = new Headers(current.headers).get("authorization")
          const oauth = (await McpAuth.getForAuthority(mcpName, current.url, await authorityFingerprint()))?.tokens
            ?.accessToken
          if (authorization !== configured && authorization !== (oauth ? `Bearer ${oauth}` : undefined)) {
            throw new Error(`MCP connector ${mcpName} tried to dispatch with stale OAuth authority`)
          }
        },
        () => McpRemoteUrl.fetchNoRedirect(url, approved),
      )
    }
  }

  function invalidateTools(client: MCPClient) {
    toolRevisions.set(client, (toolRevisions.get(client) ?? 0) + 1)
    toolLists.delete(client)
    toolRequests.delete(client)
  }

  function listTools(client: MCPClient, timeout = DEFAULT_TIMEOUT): Promise<ToolList> {
    const cached = toolLists.get(client)
    if (cached && Date.now() - cached.at < TOOL_LIST_TTL_MS) return Promise.resolve(cached.value)
    const pending = toolRequests.get(client)
    if (pending) return pending
    const revision = toolRevisions.get(client) ?? 0
    const request = withTimeout(client.listTools(), timeout)
      .then((value) => {
        if ((toolRevisions.get(client) ?? 0) === revision) toolLists.set(client, { value, at: Date.now() })
        return value
      })
      .finally(() => {
        if (toolRequests.get(client) === request) toolRequests.delete(client)
      })
    toolRequests.set(client, request)
    return request
  }

  async function closeClient(client: MCPClient): Promise<void> {
    invalidateTools(client)
    const id = credentialProcesses.get(client)
    try {
      // Enumerate and revoke while the owned launcher is still alive. Closing
      // stdio first would let a direct setsid child reparent outside both the
      // leader's descendant closure and its original process group.
      if (id && localClients.has(client)) await CredentialProcessLedger.revoke({ id, kind: "mcp" })
      await client.close()
    } finally {
      if (id) {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await CredentialProcessLedger.complete(id)) break
          await Bun.sleep(20)
        }
        credentialProcesses.delete(client)
      }
      const sandbox = localSandboxes.get(client)
      if (sandbox) {
        Sandbox.cleanup(sandbox)
        localSandboxes.delete(client)
      }
      localClients.delete(client)
    }
  }

  /** Stop project-controlled local transports without disturbing remote MCP
   * connections. Trust revocation also reaps dead-owner transports through the
   * durable credential-process ledger in ProjectBootstrap. */
  export async function disposeLocal(): Promise<void> {
    const current = await state()
    const local = Object.entries(current.clients).filter(([, client]) => localClients.has(client))
    const results = await Promise.allSettled(local.map(([, client]) => closeClient(client)))
    for (const [name] of local) {
      delete current.clients[name]
      current.status[name] = { status: "disabled" }
    }
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Local MCP servers could not be stopped")
  }

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  export const AuthStart = z
    .discriminatedUnion("state", [
      z.object({
        state: z.literal("pending"),
        authorizationUrl: z.string(),
        flowId: z.string(),
      }),
      z.object({
        state: z.literal("settled"),
        result: Status,
      }),
    ])
    .meta({ ref: "MCPAuthStart" })
  export type AuthStart = z.infer<typeof AuthStart>

  export const Inspection = z
    .object({
      status: Status,
      auth: z.enum(["authenticated", "expired", "not_authenticated"]).optional(),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
      resources: z.array(
        z.object({
          name: z.string(),
          uri: z.string(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      ),
      prompts: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
      errors: z.object({
        tools: z.string().optional(),
        resources: z.string().optional(),
        prompts: z.string().optional(),
      }),
    })
    .meta({ ref: "MCPInspection" })
  export type Inspection = z.infer<typeof Inspection>

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      invalidateTools(client)
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // Convert MCP tool definition to AI SDK Tool type
  const validator = new AjvJsonSchemaValidator()

  /** MCP publishes JSON Schema rather than Zod. Attach the SDK's own AJV
   * validator so malformed model calls reach the AI SDK repair hook before a
   * permission prompt or remote MCP request can start. */
  export function inputSchema(name: string, schema: JSONSchema7) {
    const validate = validator.getValidator<Record<string, unknown>>(schema as never)
    return jsonSchema(schema, {
      validate(input) {
        const result = validate(input)
        if (result.valid) return { success: true, value: result.data }
        return {
          success: false,
          error: new Error(
            `The ${name} MCP tool received invalid arguments or incomplete input. No action was taken. Retry with all required fields.`,
          ),
        }
      },
    })
  }

  async function convertMcpTool(
    clientName: string,
    mcpTool: MCPToolDef,
    client: MCPClient,
    timeout?: number,
    projectOwned = false,
  ): Promise<Tool> {
    const published = mcpTool.inputSchema

    // Spread first, then override type to ensure it's always "object"
    const schema: JSONSchema7 = {
      ...(published as JSONSchema7),
      type: "object",
      properties: (published.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: inputSchema(mcpTool.name, schema),
      execute: async (args: unknown) => {
        return withUpdateAdmission(async () => {
          if (projectOwned) await ProjectTrust.require(Instance.project, "project_mcp")
          const current = await state()
          const config = (await Config.getExecution()).mcp?.[clientName]
          if (
            current.clients[clientName] !== client ||
            current.status[clientName]?.status !== "connected" ||
            !config ||
            !isMcpConfigured(config) ||
            config.enabled === false
          ) {
            throw new Error(`MCP connector ${clientName} is no longer authorized for this tool call`)
          }
          return client.callTool(
            {
              name: mcpTool.name,
              arguments: (args || {}) as Record<string, unknown>,
            },
            CallToolResultSchema,
            {
              resetTimeoutOnProgress: true,
              timeout,
            },
          )
        })
      },
    })
  }

  async function withUpdateAdmission<T>(action: () => Promise<T>): Promise<T> {
    const release = await AuthoritySignal.exclusive(async () => UpdateQuiescence.enter("mcp"))
    try {
      return await action()
    } finally {
      release()
    }
  }

  // Store transports for OAuth servers to allow finishing auth
  type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
  interface PendingOAuthTransport {
    state?: string
    transport: TransportWithAuth
    client?: MCPClient
  }
  const pendingOAuthTransports = new Map<string, PendingOAuthTransport>()
  const startingOAuthFlows = new Set<string>()
  const authenticationWaiters = new Map<string, { flowId?: string; promise: Promise<Status> }>()

  async function closePendingOAuthTransport(name: string, state?: string) {
    const pending = pendingOAuthTransports.get(name)
    if (!pending || (state !== undefined && pending.state !== state)) return
    if (pending.client) await closeClient(pending.client)
    else await pending.transport.close()
    if (pendingOAuthTransports.get(name) === pending) pendingOAuthTransports.delete(name)
  }

  async function replacePendingOAuthTransport(name: string, pending: PendingOAuthTransport) {
    await closePendingOAuthTransport(name)
    pendingOAuthTransports.set(name, pending)
  }

  // Prompt cache types
  type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]

  type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  function isMcpConfigured(entry: McpEntry): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  export function localEnv(
    base: Record<string, string>,
    command: string,
    environment?: Record<string, string>,
  ): Record<string, string> {
    return OpenScience.filterControlPlaneEnv({
      ...base,
      ...(command === "openscience" ? { BUN_BE_BUN: "1" } : {}),
      ...environment,
    })
  }

  function localReadRoots(values: string[], cwd: string): string[] {
    const roots = new Set<string>([cwd])
    const dependencies = (modules: string) => {
      const queue = fs
        .readdirSync(modules, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .flatMap((entry) => {
          const candidate = path.join(modules, entry.name)
          if (!entry.name.startsWith("@")) return [candidate]
          return fs
            .readdirSync(candidate, { withFileTypes: true })
            .filter((child) => child.isDirectory() || child.isSymbolicLink())
            .map((child) => path.join(candidate, child.name))
        })
      for (const candidate of queue) {
        const real = (() => {
          try {
            return fs.realpathSync.native(candidate)
          } catch {
            return undefined
          }
        })()
        if (!real) continue
        const stores = [
          `${path.sep}node_modules${path.sep}.bun${path.sep}`,
          `${path.sep}node_modules${path.sep}.pnpm${path.sep}`,
        ]
        const marker = stores.find((value) => real.includes(value))
        if (marker) {
          roots.add(real.slice(0, real.indexOf(marker) + marker.length - 1))
          return
        }
        roots.add(real)
      }
    }
    for (const value of values) {
      if (!path.isAbsolute(value)) continue
      const start = (() => {
        try {
          return fs.statSync(value).isDirectory() ? value : path.dirname(value)
        } catch {
          return path.dirname(value)
        }
      })()
      let cursor = start
      while (true) {
        if (fs.existsSync(path.join(cursor, "package.json"))) {
          roots.add(cursor)
          const modules = path.join(cursor, "node_modules")
          if (fs.existsSync(modules)) {
            roots.add(modules)
            dependencies(modules)
          }
          break
        }
        const parent = path.dirname(cursor)
        if (parent === cursor) {
          roots.add(start)
          break
        }
        cursor = parent
      }
    }
    return [...roots]
  }

  const state = Instance.state(
    async () => {
      const cfg = await Config.getExecution()
      const config = cfg.mcp ?? {}
      const clients: Record<string, MCPClient> = {}
      const status: Record<string, Status> = {}

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          if (!isMcpConfigured(mcp)) {
            log.error("Ignoring MCP config entry without type", { key })
            return
          }

          // If disabled by config, mark as disabled without trying to connect
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }

          const result = await create(key, mcp).catch(() => undefined)
          if (!result) return
          try {
            status[key] = result.status

            if (result.mcpClient) {
              clients[key] = result.mcpClient
            }
          } finally {
            result.releaseUpdate?.()
          }
        }),
      )
      return {
        status,
        clients,
      }
    },
    async (state) => {
      const closures = Object.values(state.clients).map((client) => closeClient(client))
      const pending = [...pendingOAuthTransports.keys()]
      closures.push(...pending.map((name) => closePendingOAuthTransport(name)))
      const results = await Promise.allSettled(closures)
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) throw new AggregateError(failures, "MCP transports could not be closed")
    },
  )

  // Helper function to fetch prompts for a specific client
  async function fetchPromptsForClient(clientName: string, client: Client) {
    const prompts = await client.listPrompts().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!prompts) {
      return
    }

    const commands: Record<string, PromptInfo & { client: string }> = {}

    for (const prompt of prompts.prompts) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedPromptName

      commands[key] = { ...prompt, client: clientName }
    }
    return commands
  }

  async function fetchResourcesForClient(clientName: string, client: Client) {
    const resources = await client.listResources().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!resources) {
      return
    }

    const commands: Record<string, ResourceInfo & { client: string }> = {}

    for (const resource of resources.resources) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedResourceName

      commands[key] = { ...resource, client: clientName }
    }
    return commands
  }

  export async function add(name: string, mcp: Config.Mcp) {
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      return {
        status,
      }
    }
    try {
      if (!result.mcpClient) {
        const existingClient = s.clients[name]
        if (existingClient) {
          await closeClient(existingClient)
          delete s.clients[name]
        }
        s.status[name] = result.status
        return {
          status: s.status,
        }
      }
      // Close existing client if present to prevent memory leaks
      const existingClient = s.clients[name]
      if (existingClient) {
        await closeClient(existingClient).catch(async (error) => {
          await closeClient(result.mcpClient!).catch(() => undefined)
          throw error
        })
      }
      s.clients[name] = result.mcpClient
      s.status[name] = result.status

      return {
        status: s.status,
      }
    } finally {
      result.releaseUpdate?.()
    }
  }

  async function create(key: string, mcp: Config.Mcp, options: { allowDisabled?: boolean } = {}) {
    OpenScience.registerSecretValues(
      mcp.type === "local"
        ? Object.values(mcp.environment ?? {})
        : [
            ...Object.values(mcp.headers ?? {}),
            ...(typeof mcp.oauth === "object" && mcp.oauth.clientSecret ? [mcp.oauth.clientSecret] : []),
          ],
    )
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
        releaseUpdate: undefined,
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined
    let releaseUpdate: (() => void) | undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const fingerprint = oauthDisabled ? undefined : await oauthAuthorityFingerprint(mcp)
      let authProvider: McpOAuthProvider | undefined

      // Passive startup must never perform dynamic registration or create new
      // OAuth authority. Supply a provider only when URL-bound tokens already
      // exist; explicit startAuth owns all registration and browser flow writes.
      const storedOAuth = fingerprint ? await McpAuth.getForAuthority(key, mcp.url, fingerprint) : undefined
      if (fingerprint && storedOAuth?.tokens) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, origin: url.origin })
              // Store the URL - actual browser opening is handled by startAuth
            },
          },
          {
            verify: () => assertRemoteAuthority(key, mcp).then(() => undefined),
            authorityFingerprint: fingerprint,
          },
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
            fetch: remoteCredentialFetch(key, mcp, options),
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
            fetch: remoteCredentialFetch(key, mcp, options),
          }),
        },
      ]

      let lastError: Error | undefined
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      for (const { name, transport } of transports) {
        const client = new Client({
          name: "openscience",
          version: Installation.VERSION,
        })
        try {
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Handle OAuth-specific errors
          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key, transport: name })

            // Check if this is a "needs registration" error
            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              status = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide clientId in config.",
              }
              await closeClient(client).catch((cause) => {
                log.warn("failed to close registration probe", { key, transport: name, error: cause })
              })
              log.warn("MCP server requires a pre-registered client ID", { server: key })
            } else {
              // Store transport for later finishAuth call
              await replacePendingOAuthTransport(key, { transport, client })
              status = { status: "needs_auth" as const }
              log.warn("MCP server requires authentication", { server: key, hint: `openscience mcp auth ${key}` })
            }
            break
          }

          await closeClient(client).catch((cause) => {
            log.warn("failed to close rejected MCP transport", { key, transport: name, error: cause })
          })

          log.debug("transport connection failed", {
            key,
            transport: name,
            error: OpenScience.redactSecrets(lastError.message),
          })
          status = {
            status: "failed" as const,
            error: OpenScience.redactSecrets(lastError.message),
          }
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      const cwd = Instance.directory
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      try {
        const launched = await OpenScience.withSubprocessEnv(process.env, async (base) =>
          AuthoritySignal.exclusive(async () => {
            const releaseUpdate = UpdateQuiescence.enter("mcp")
            try {
              await ProjectTrust.require(Instance.project, "project_mcp")
              const options = await Config.trustedSandbox()
              const sandbox = Sandbox.wrapArgv({
                file: cmd,
                args,
                workspace: [Instance.directory, Instance.worktree],
                readable: localReadRoots(args, cwd),
                unreadable: OpenScience.kernelSensitivePaths(),
                options,
              })
              const result = await (async () => {
                const ready = path.join(os.tmpdir(), `openscience-mcp-group-${process.pid}-${crypto.randomUUID()}`)
                const launcher = groupLauncherInvocation({
                  execPath: process.execPath,
                  sourceEntry: CLI_ENTRY,
                  ready,
                  file: sandbox.file,
                  args: sandbox.args,
                })
                const transport = new StdioClientTransport({
                  stderr: "pipe",
                  // The SDK transport does not expose child_process.detached.
                  // Launch through a tiny trusted proxy that calls setsid(), then
                  // keeps the sandboxed server and its ordinary descendants in a
                  // dedicated, durably reapable process group.
                  command: launcher.command,
                  args: launcher.args,
                  cwd,
                  env: localEnv(base, sandbox.file, mcp.environment),
                })
                transport.stderr?.on("data", (chunk: Buffer) => {
                  log.info(`mcp stderr: ${OpenScience.redactSecrets(chunk.toString())}`, { key })
                })
                const client = new Client({
                  name: "openscience",
                  version: Installation.VERSION,
                })
                try {
                  // Start and durably register the process before releasing either
                  // the authority or credential-mutation lease. Client.connect()
                  // normally starts the SDK transport itself, so replace that
                  // second start with a no-op after the owned first start.
                  await withTimeout(transport.start(), connectTimeout)
                  const pid = transport.pid
                  if (!pid) throw new Error("Local MCP transport started without a process id")
                  await withTimeout(waitForOwnedGroup(ready, pid), connectTimeout)
                  const id = `mcp-${crypto.randomUUID()}`
                  const registered = await CredentialProcessLedger.register({
                    id,
                    kind: "mcp",
                    pid,
                    detached: true,
                    projectID: Instance.project.id,
                    windowsRelease: launcher.release,
                  })
                  if (!registered) throw new Error("Local MCP transport exited before durable registration")
                  credentialProcesses.set(client, id)
                  localClients.add(client)
                  localSandboxes.set(client, sandbox)
                  transport.start = async () => undefined
                  return { client, transport }
                } catch (error) {
                  Sandbox.cleanup(sandbox)
                  await transport.close().catch(() => undefined)
                  throw error
                } finally {
                  await fsp.rm(ready, { force: true }).catch(() => undefined)
                  await fsp.rm(`${ready}.release`, { force: true }).catch(() => undefined)
                  if (launcher.release && launcher.release !== `${ready}.release`) {
                    await fsp.rm(launcher.release, { force: true }).catch(() => undefined)
                  }
                }
              })()
              return { ...result, releaseUpdate }
            } catch (error) {
              releaseUpdate()
              throw error
            }
          }),
        )
        const client = launched.client
        try {
          await withTimeout(client.connect(launched.transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          releaseUpdate = launched.releaseUpdate
          status = {
            status: "connected",
          }
        } catch (error) {
          await closeClient(client).catch(() => launched.transport.close().catch(() => undefined))
          launched.releaseUpdate()
          throw error
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: OpenScience.redactSecrets(error instanceof Error ? error.message : String(error)),
        }
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
        releaseUpdate: undefined,
      }
    }

    const result = await listTools(mcpClient, mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await closeClient(mcpClient).catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      releaseUpdate?.()
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
        releaseUpdate: undefined,
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
      releaseUpdate,
    }
  }

  export async function status() {
    const s = await state()
    const cfg = await Config.getExecution()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    // Include all configured MCPs from config, not just connected ones
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      result[key] = s.status[key] ?? { status: "disabled" }
    }

    return result
  }

  export async function inspect(name: string): Promise<Inspection> {
    return (async () => {
      const cfg = await Config.getExecution()
      const mcp = cfg.mcp?.[name]
      if (!mcp || !isMcpConfigured(mcp)) throw new Error(`MCP server not found: ${name}`)

      const s = await state()
      const status = s.status[name] ?? ({ status: "disabled" } as const)
      const auth = mcp.type === "remote" && mcp.oauth !== false ? await getAuthStatus(name) : undefined
      const client = s.clients[name]
      if (!client) {
        return {
          status,
          auth,
          tools: [],
          resources: [],
          prompts: [],
          errors: {},
        }
      }

      const timeout = mcp.timeout ?? cfg.experimental?.mcp_timeout ?? DEFAULT_TIMEOUT
      const failure = (error: unknown) =>
        OpenScience.redactSecrets(error instanceof Error ? error.message : String(error))
      const [tools, resources, prompts] = await Promise.all([
        withTimeout(client.listTools(), timeout)
          .then((result) => ({
            items: result.tools.map((tool) => ({ name: tool.name, description: tool.description })),
            error: undefined,
          }))
          .catch((error) => ({ items: [], error: failure(error) })),
        withTimeout(client.listResources(), timeout)
          .then((result) => ({
            items: result.resources.map((resource) => ({
              name: resource.name,
              uri: resource.uri,
              description: resource.description,
              mimeType: resource.mimeType,
            })),
            error: undefined,
          }))
          .catch((error) => ({ items: [], error: failure(error) })),
        withTimeout(client.listPrompts(), timeout)
          .then((result) => ({
            items: result.prompts.map((prompt) => ({ name: prompt.name, description: prompt.description })),
            error: undefined,
          }))
          .catch((error) => ({ items: [], error: failure(error) })),
      ])

      return {
        status,
        auth,
        tools: tools.items,
        resources: resources.items,
        prompts: prompts.items,
        errors: {
          tools: tools.error,
          resources: resources.error,
          prompts: prompts.error,
        },
      }
    })()
  }

  export async function clients() {
    const [current, cfg] = await Promise.all([state(), Config.getExecution()])
    const allowed = new Set(
      Object.entries(cfg.mcp ?? {})
        .filter(([, entry]) => isMcpConfigured(entry) && entry.enabled !== false)
        .map(([name]) => name),
    )
    return Object.fromEntries(Object.entries(current.clients).filter(([name]) => allowed.has(name)))
  }

  export async function connect(name: string, options: { allowDisabled?: boolean } = {}) {
    const cfg = await Config.getExecution()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    if (!isMcpConfigured(mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true }, options)

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      return
    }

    try {
      const s = await state()
      s.status[name] = result.status
      if (result.mcpClient) {
        // Close existing client if present to prevent memory leaks
        const existingClient = s.clients[name]
        if (existingClient) {
          await closeClient(existingClient).catch(async (error) => {
            await closeClient(result.mcpClient!).catch(() => undefined)
            throw error
          })
        }
        s.clients[name] = result.mcpClient
      }
    } finally {
      result.releaseUpdate?.()
    }
  }

  export async function disconnect(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await closeClient(client)
      delete s.clients[name]
    }
    s.status[name] = { status: "disabled" }
  }

  export async function remove(name: string, scope: Config.Scope = "global") {
    return withConnectorOperation(name, () => removeLocked(name, scope))
  }

  async function removeLocked(name: string, scope: Config.Scope) {
    const current = scope === "global" ? await Config.getGlobal() : await Config.get()
    const configured = current.mcp?.[name]
    if (configured && isMcpConfigured(configured)) {
      const safe: Config.Mcp =
        configured.type === "local"
          ? { ...configured, enabled: false, environment: undefined }
          : {
              ...configured,
              enabled: false,
              headers: undefined,
              oauth:
                typeof configured.oauth === "object"
                  ? { ...configured.oauth, clientSecret: undefined }
                  : configured.oauth,
            }
      // First land a non-authoritative disabled definition. Every later crash
      // point is safe: either the original remains visibly connected, or only
      // this scrubbed retry marker remains.
      await Config.setMcp(name, safe, scope)
    }
    await removeAuthLocked(name, { reconnect: false })
    await Config.removeMcp(name, scope)
    const s = await state()
    const client = s.clients[name]
    if (client) await closeClient(client)
    delete s.clients[name]
    delete s.status[name]
  }

  export async function tools() {
    return (async () => {
      const result: Record<string, Tool> = {}
      const s = await state()
      const cfg = await Config.getExecution()
      const config = cfg.mcp ?? {}
      const clientsSnapshot = await clients()
      const defaultTimeout = cfg.experimental?.mcp_timeout

      for (const [clientName, client] of Object.entries(clientsSnapshot)) {
        // Only include tools from connected MCPs (skip disabled ones)
        if (s.status[clientName]?.status !== "connected") {
          continue
        }

        const mcpConfig = config[clientName]
        const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
        const timeout = entry?.timeout ?? defaultTimeout
        const toolsResult = await listTools(client, timeout ?? DEFAULT_TIMEOUT).catch((e) => {
          log.error("failed to get tools", { clientName, error: e.message })
          const failedStatus = {
            status: "failed" as const,
            error: e instanceof Error ? e.message : String(e),
          }
          s.status[clientName] = failedStatus
          return undefined
        })
        if (!toolsResult) {
          continue
        }
        const projectOwned = await Config.projectControlsMcp(clientName)
        for (const mcpTool of toolsResult.tools) {
          const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
          const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
          result[sanitizedClientName + "_" + sanitizedToolName] = await convertMcpTool(
            clientName,
            mcpTool,
            client,
            timeout,
            projectOwned,
          )
        }
      }
      return result
    })()
  }

  export async function prompts() {
    return (async () => {
      const s = await state()
      const clientsSnapshot = await clients()

      const prompts = Object.fromEntries<PromptInfo & { client: string }>(
        (
          await Promise.all(
            Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
              if (s.status[clientName]?.status !== "connected") {
                return []
              }

              return Object.entries((await fetchPromptsForClient(clientName, client)) ?? {})
            }),
          )
        ).flat(),
      )

      return prompts
    })()
  }

  export async function resources() {
    return (async () => {
      const s = await state()
      const clientsSnapshot = await clients()

      const result = Object.fromEntries<ResourceInfo & { client: string }>(
        (
          await Promise.all(
            Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
              if (s.status[clientName]?.status !== "connected") {
                return []
              }

              return Object.entries((await fetchResourcesForClient(clientName, client)) ?? {})
            }),
          )
        ).flat(),
      )

      return result
    })()
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    return withUpdateAdmission(async () => {
      if (await Config.projectControlsMcp(clientName)) {
        await ProjectTrust.require(Instance.project, "project_mcp")
      }
      const clientsSnapshot = await clients()
      const client = clientsSnapshot[clientName]

      if (!client) {
        log.warn("client not found for prompt", {
          clientName,
        })
        return undefined
      }

      const result = await client
        .getPrompt({
          name: name,
          arguments: args,
        })
        .catch((e) => {
          log.error("failed to get prompt from MCP server", {
            clientName,
            promptName: name,
            error: e.message,
          })
          return undefined
        })

      return result
    })
  }

  export async function readResource(clientName: string, resourceUri: string) {
    return withUpdateAdmission(async () => {
      if (await Config.projectControlsMcp(clientName)) {
        await ProjectTrust.require(Instance.project, "project_mcp")
      }
      const clientsSnapshot = await clients()
      const client = clientsSnapshot[clientName]

      if (!client) {
        log.warn("client not found for prompt", {
          clientName: clientName,
        })
        return undefined
      }

      const result = await client
        .readResource({
          uri: resourceUri,
        })
        .catch((e) => {
          log.error("failed to get prompt from MCP server", {
            clientName: clientName,
            resourceUri: resourceUri,
            error: e.message,
          })
          return undefined
        })

      return result
    })
  }

  /**
   * Start OAuth authentication flow for an MCP server.
   * Returns the authorization URL that should be opened in a browser.
   */
  export function startAuth(mcpName: string): Promise<AuthStart> {
    return withConnectorOperation(mcpName, () => startAuthLocked(mcpName))
  }

  async function startAuthLocked(mcpName: string): Promise<AuthStart> {
    const cfg = await Config.getExecution()
    const mcpConfig = cfg.mcp?.[mcpName]

    if (!mcpConfig) {
      throw new Error(`MCP server not found: ${mcpName}`)
    }

    if (!isMcpConfigured(mcpConfig)) {
      throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
    }

    if (mcpConfig.type !== "remote") {
      throw new Error(`MCP server ${mcpName} is not a remote server`)
    }

    if (mcpConfig.oauth === false) {
      throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
    }

    if (startingOAuthFlows.has(mcpName)) {
      throw new Error(`OAuth authorization is already starting for MCP server: ${mcpName}`)
    }
    startingOAuthFlows.add(mcpName)

    try {
      // Start the callback server
      await McpOAuthCallback.ensureRunning()

      // Generate and store a cryptographically secure state parameter BEFORE creating the provider.
      // The SDK will call provider.state() to read this value.
      const existingFlow = await McpAuth.pendingOAuthFlow(mcpName)
      if (existingFlow) throw new Error(`OAuth authorization is already in progress for MCP server: ${mcpName}`)
      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      await McpAuth.updateOAuthState(mcpName, oauthState, {
        serverUrl: mcpConfig.url,
        authorityFingerprint: await oauthAuthorityFingerprint(mcpConfig),
        allowDisabled: mcpConfig.enabled === false,
      })

      // Create a new auth provider for this flow. Persist the exact URL before
      // returning it so a process restart can reopen the same PKCE operation
      // instead of waiting forever or generating a clobbering verifier.
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
        },
        {
          onRedirect: async (url) => {
            McpRemoteUrl.discovered(url, mcpConfig.url, "OAuth authorization URL")
            await McpAuth.updateOAuthAuthorizationUrl(mcpName, oauthState, url.toString())
            capturedUrl = url
          },
        },
        {
          verify: () =>
            assertRemoteAuthority(mcpName, mcpConfig, { allowDisabled: mcpConfig.enabled === false }).then(
              () => undefined,
            ),
          flowState: oauthState,
          authorityFingerprint: await oauthAuthorityFingerprint(mcpConfig),
          allowDisabled: mcpConfig.enabled === false,
        },
      )

      const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
        authProvider,
        requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
        fetch: remoteCredentialFetch(mcpName, mcpConfig, { allowDisabled: mcpConfig.enabled === false }),
      })

      const client = new Client({
        name: "openscience",
        version: Installation.VERSION,
      })

      await replacePendingOAuthTransport(mcpName, { state: oauthState, transport, client })
      try {
        await withTimeout(client.connect(transport), mcpConfig.timeout ?? DEFAULT_TIMEOUT)
        // If we get here, the existing authority was already sufficient.
        await closePendingOAuthTransport(mcpName, oauthState)
        await McpAuth.clearOAuthFlow(mcpName, oauthState)
        return {
          state: "settled",
          result: await proveAuthenticatedConnection(mcpName, mcpConfig),
        }
      } catch (error) {
        const foreignName =
          error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : ""
        const unauthorized = error instanceof UnauthorizedError || foreignName === "UnauthorizedError"
        if (unauthorized && capturedUrl) {
          return {
            state: "pending",
            authorizationUrl: capturedUrl.toString(),
            flowId: await oauthFlowId(oauthState),
          }
        }

        const cleanup = await Promise.allSettled([
          closePendingOAuthTransport(mcpName, oauthState),
          McpAuth.clearOAuthFlowIfCurrent(mcpName, oauthState),
        ])
        const failures = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (failures.length) {
          throw new AggregateError([error, ...failures], "OAuth startup and its fail-closed cleanup both failed")
        }
        throw error
      }
    } finally {
      startingOAuthFlows.delete(mcpName)
    }
  }

  async function proveAuthenticatedConnection(mcpName: string, config: Config.Mcp): Promise<Status> {
    await connect(mcpName, { allowDisabled: config.enabled === false })
    let connected = (await state()).status[mcpName]
    if (connected?.status !== "connected") {
      return connected ?? { status: "failed", error: "Connector did not establish an authenticated connection" }
    }
    if (config.enabled !== false) return connected

    const global = (await Config.getGlobal()).mcp?.[mcpName]
    if (!global || !isMcpConfigured(global) || JSON.stringify(global) !== JSON.stringify(config)) {
      await disconnect(mcpName)
      return {
        status: "failed",
        error: "Connector configuration changed during authentication; it remains safely disabled",
      }
    }

    // Only persist enablement after a real authenticated MCP connection has
    // succeeded. A crash before this point leaves the preset safely off.
    await Config.setMcp(mcpName, { ...config, enabled: true }, "global")
    await connect(mcpName)
    connected = (await state()).status[mcpName]
    if (connected?.status === "connected") return connected

    await Config.setMcp(mcpName, config, "global")
    return connected ?? { status: "failed", error: "Connector failed after durable enablement and was turned off" }
  }

  /**
   * Complete OAuth authentication after user authorizes in browser.
   * Opens the browser and waits for callback.
   */
  async function authenticateFlow(
    mcpName: string,
    options: { openBrowser: boolean; expectedFlowId?: string; create?: boolean },
  ): Promise<Status> {
    let persisted = await McpAuth.pendingOAuthFlow(mcpName)
    if (persisted) {
      const current = (await Config.getExecution()).mcp?.[mcpName]
      if (!current || !isMcpConfigured(current) || !(await oauthFlowMatches(current, persisted))) {
        await closePendingOAuthTransport(mcpName, persisted.state).catch(() => undefined)
        await McpAuth.clearOAuthFlow(mcpName, persisted.state)
        persisted = undefined
      }
    }
    if (options.expectedFlowId && (!persisted || (await oauthFlowId(persisted.state)) !== options.expectedFlowId)) {
      throw new Error(`OAuth authorization changed before waiting for MCP server: ${mcpName}`)
    }
    if (persisted?.callback?.type === "code") return finishAuth(mcpName, persisted.callback.value)
    if (persisted?.callback?.type === "error") {
      await McpAuth.clearOAuthFlow(mcpName, persisted.state)
      return { status: "failed", error: OAUTH_AUTHORIZATION_FAILED_MESSAGE }
    }
    if (persisted?.callback?.type === "cancelled") {
      await McpAuth.clearOAuthFlow(mcpName, persisted.state)
      throw new Error("Authorization cancelled")
    }
    if (persisted) {
      if (startingOAuthFlows.has(mcpName)) {
        throw new Error(`OAuth authorization is already in progress for MCP server: ${mcpName}`)
      }
      if (!persisted.authorizationUrl) {
        // The prior process died (or the provider failed) before a usable PKCE
        // URL was durably produced. It is safe to abandon only that exact flow.
        await McpAuth.clearOAuthFlow(mcpName, persisted.state)
        persisted = undefined
      }
    }

    if (!persisted && options.create === false) {
      throw new Error(`No matching pending OAuth authorization for MCP server: ${mcpName}`)
    }
    const started: AuthStart = persisted
      ? {
          state: "pending",
          authorizationUrl: persisted.authorizationUrl!,
          flowId: await oauthFlowId(persisted.state),
        }
      : await startAuth(mcpName)
    if (started.state === "settled") return started.result
    const { authorizationUrl } = started

    // Get the state that was already generated and stored in startAuth()
    const oauthState = persisted?.state ?? (await McpAuth.getOAuthState(mcpName))
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // A persisted flow can outlive the process that originally owned the
    // loopback callback server. Re-establish (or join) the exact same-profile
    // listener before reopening the durable authorization URL or waiting for
    // its redirect. Merely polling the encrypted store would leave restarted
    // desktop/SSH sessions with a dead callback endpoint.
    await McpOAuthCallback.ensureRunning()

    // The SDK has already added the state parameter to the authorization URL
    // We just need to open the browser
    log.info("opening browser for oauth", { mcpName })

    // Register the callback BEFORE opening the browser to avoid race condition
    // when the IdP has an active SSO session and redirects immediately
    const callbackPromise = McpOAuthCallback.waitForCallback(mcpName, oauthState)

    if (options.openBrowser) {
      try {
        const subprocess = await open(authorizationUrl)
        // The open package spawns a detached process and returns immediately.
        // We need to listen for errors which fire asynchronously:
        // - "error" event: command not found (ENOENT)
        // - "exit" with non-zero code: command exists but failed (e.g., no display)
        await new Promise<void>((resolve, reject) => {
          // Give the process a moment to fail if it's going to
          const timeout = setTimeout(() => resolve(), 500)
          subprocess.on("error", (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          subprocess.on("exit", (code) => {
            if (code !== null && code !== 0) {
              clearTimeout(timeout)
              reject(new Error(`Browser open failed with exit code ${code}`))
            }
          })
        })
      } catch (error) {
        // Browser opening failed (e.g., in remote/headless sessions like SSH, devcontainers)
        // Emit event so CLI can display the URL for manual opening
        log.warn("failed to open browser, user must open URL manually", { mcpName, error })
        Bus.publish(BrowserOpenFailed, { mcpName, url: authorizationUrl })
      }
    }

    // Wait for callback using the already-registered promise
    const code = await callbackPromise.catch(async (error): Promise<string | Status> => {
      await closePendingOAuthTransport(mcpName, oauthState).catch(() => undefined)
      await McpAuth.clearOAuthFlow(mcpName, oauthState).catch(() => undefined)
      if (error instanceof OAuthAuthorizationFailedError) {
        return { status: "failed", error: OAUTH_AUTHORIZATION_FAILED_MESSAGE }
      }
      throw error
    })
    if (typeof code !== "string") return code

    // Validate and clear the state
    const storedState = await McpAuth.getOAuthState(mcpName)
    if (storedState !== oauthState) {
      await McpAuth.clearOAuthFlow(mcpName, oauthState)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    // Finish auth
    return finishAuth(mcpName, code)
  }

  export function authenticate(mcpName: string): Promise<Status> {
    const current = authenticationWaiters.get(mcpName)
    if (current) return current.promise
    const started = authenticateFlow(mcpName, { openBrowser: true, create: true }).finally(() => {
      if (authenticationWaiters.get(mcpName)?.promise === started) authenticationWaiters.delete(mcpName)
    })
    authenticationWaiters.set(mcpName, { promise: started })
    return started
  }

  export async function waitForAuth(mcpName: string, flowId: string): Promise<Status> {
    const current = authenticationWaiters.get(mcpName)
    if (current) {
      if (current.flowId && current.flowId !== flowId) {
        throw new Error(`OAuth authorization changed before waiting for MCP server: ${mcpName}`)
      }
      const pending = await pendingAuth(mcpName)
      if (!pending || pending.flowId !== flowId) {
        throw new Error(`OAuth authorization changed before waiting for MCP server: ${mcpName}`)
      }
      return current.promise
    }
    const started = authenticateFlow(mcpName, { openBrowser: false, expectedFlowId: flowId, create: false }).finally(
      () => {
        if (authenticationWaiters.get(mcpName)?.promise === started) authenticationWaiters.delete(mcpName)
      },
    )
    authenticationWaiters.set(mcpName, { flowId, promise: started })
    return started
  }

  export async function pendingAuth(
    mcpName: string,
  ): Promise<{ authorizationUrl: string; flowId: string } | undefined> {
    const flow = await McpAuth.pendingOAuthFlow(mcpName)
    if (!flow?.authorizationUrl) return undefined
    const config = (await Config.getExecution()).mcp?.[mcpName]
    if (!config || !isMcpConfigured(config) || !(await oauthFlowMatches(config, flow))) return undefined
    return { authorizationUrl: flow.authorizationUrl, flowId: await oauthFlowId(flow.state) }
  }

  /**
   * Complete OAuth authentication with the authorization code.
   */
  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    const configured = (await Config.getExecution()).mcp?.[mcpName]
    const timeout =
      configured && isMcpConfigured(configured) && configured.type === "remote"
        ? (configured.timeout ?? DEFAULT_TIMEOUT)
        : DEFAULT_TIMEOUT
    return withConnectorOperation(
      mcpName,
      () => finishAuthOperation(mcpName, authorizationCode),
      timeout + DEFAULT_TIMEOUT,
    )
  }

  async function finishAuthOperation(mcpName: string, authorizationCode: string): Promise<Status> {
    const observed = await McpAuth.pendingOAuthFlow(mcpName)
    if (!observed) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    const configured = (await Config.getExecution()).mcp?.[mcpName]
    const exchangeTimeout =
      configured && isMcpConfigured(configured) && configured.type === "remote"
        ? (configured.timeout ?? DEFAULT_TIMEOUT)
        : DEFAULT_TIMEOUT
    const digest = await McpSecretStorage.identifier("oauth-settlement-lock", `${mcpName}\0${observed.state}`)
    const lock = path.join(Global.Path.data, "mcp-oauth-settlement", `${digest}.lock`)
    await using lease = await FileLease.acquire(lock, exchangeTimeout + DEFAULT_TIMEOUT)
    return await lease.during(async () => {
      const currentFlow = await McpAuth.pendingOAuthFlow(mcpName)
      if (!currentFlow) {
        // Another process may have exchanged the single-use code while this
        // caller waited. Reuse only an exact durable success receipt for the
        // state this caller observed, never unrelated pre-existing tokens.
        const config = (await Config.getExecution()).mcp?.[mcpName]
        if (
          !config ||
          !isMcpConfigured(config) ||
          config.type !== "remote" ||
          !observed.serverUrl ||
          !observed.authorityFingerprint ||
          !(await oauthFlowMatches(config, observed)) ||
          !(await McpAuth.completedOAuthFlow(
            mcpName,
            observed.state,
            observed.serverUrl,
            observed.authorityFingerprint,
          ))
        ) {
          throw new Error(`OAuth flow for MCP server ${mcpName} settled without usable credentials`)
        }
        const status = await proveAuthenticatedConnection(mcpName, config)
        if (status.status === "connected") await McpAuth.finalizeOAuthCompletion(mcpName, observed.state)
        return status
      }
      if (currentFlow.state !== observed.state) {
        throw new Error(`OAuth flow changed before settlement for MCP server: ${mcpName}`)
      }
      return finishAuthLocked(mcpName, authorizationCode)
    })
  }

  async function finishAuthLocked(mcpName: string, authorizationCode: string): Promise<Status> {
    const flow = await McpAuth.pendingOAuthFlow(mcpName)
    if (!flow) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    const flowState = flow.state

    const cfg = await Config.getExecution()
    const current = cfg.mcp?.[mcpName]
    if (!current || !isMcpConfigured(current) || !(await oauthFlowMatches(current, flow))) {
      await closePendingOAuthTransport(mcpName, flowState).catch(() => undefined)
      await McpAuth.clearOAuthFlow(mcpName, flowState)
      throw new Error(`MCP server ${mcpName} changed after OAuth authorization started; authorization was cancelled`)
    }
    if (!(await McpAuth.claimOAuthSettlement(mcpName, flowState, authorizationCode))) {
      throw new Error(`OAuth authorization for MCP server ${mcpName} is no longer eligible for settlement`)
    }

    const pending = pendingOAuthTransports.get(mcpName)
    let transport = pending?.state === flowState ? pending.transport : undefined
    if (!transport) {
      // A callback may arrive through the callback server owned by another
      // OpenScience process, or after this process restarted. The OAuth SDK's
      // code exchange is reconstructible from the durably stored client info,
      // PKCE verifier, state, and exact configured headers.
      const config = current
      if (!config || !isMcpConfigured(config) || config.type !== "remote" || config.oauth === false) {
        throw new Error(`MCP server ${mcpName} no longer has a compatible OAuth configuration`)
      }
      const oauth = typeof config.oauth === "object" ? config.oauth : undefined
      const provider = new McpOAuthProvider(
        mcpName,
        config.url,
        { clientId: oauth?.clientId, clientSecret: oauth?.clientSecret, scope: oauth?.scope },
        { onRedirect: async () => undefined },
        {
          verify: () =>
            assertRemoteAuthority(mcpName, config, { allowDisabled: flow.allowDisabled === true }).then(
              () => undefined,
            ),
          flowState,
          authorityFingerprint: flow.authorityFingerprint,
          allowDisabled: flow.allowDisabled === true,
        },
      )
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: provider,
        requestInit: config.headers ? { headers: config.headers } : undefined,
        fetch: remoteCredentialFetch(mcpName, config, { allowDisabled: flow.allowDisabled === true }),
      })
      await replacePendingOAuthTransport(mcpName, { state: flowState, transport })
    }

    try {
      // Call finishAuth on the transport
      await withTimeout(transport.finishAuth(authorizationCode), current.timeout ?? DEFAULT_TIMEOUT)

      if (
        !flow.serverUrl ||
        !flow.authorityFingerprint ||
        !(await McpAuth.completedOAuthFlow(mcpName, flowState, flow.serverUrl, flow.authorityFingerprint))
      ) {
        throw new Error(`OAuth exchange for MCP server ${mcpName} did not produce an exact durable success receipt`)
      }

      // Now try to reconnect
      const cfg = await Config.getExecution()
      const mcpConfig = cfg.mcp?.[mcpName]

      if (!mcpConfig) {
        throw new Error(`MCP server not found: ${mcpName}`)
      }

      if (!isMcpConfigured(mcpConfig)) {
        throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
      }
      await closePendingOAuthTransport(mcpName, flowState)
      const status = await proveAuthenticatedConnection(mcpName, mcpConfig)
      if (status.status === "connected") await McpAuth.finalizeOAuthCompletion(mcpName, flowState)
      return status
    } catch (error) {
      log.error("failed to finish oauth", {
        mcpName,
        error: OpenScience.redactSecrets(error instanceof Error ? error.message : String(error)),
      })
      await closePendingOAuthTransport(mcpName, flowState).catch(() => undefined)
      const completion = await McpAuth.recentOAuthCompletion(mcpName).catch(() => undefined)
      if (completion?.state === flowState && !completion.finalized) {
        // Token persistence is the exchange commit point, but credentials are
        // not product-ready until a live MCP connection proves them. If that
        // proof fails, revoke the exact unfinalized grant instead of reporting
        // failure while silently retaining usable authority for next startup.
        await removeAuthLocked(mcpName, { reconnect: false }).catch((cleanup) => {
          throw new AggregateError([error, cleanup], "OAuth proof and fail-closed credential cleanup both failed")
        })
      } else {
        await McpAuth.clearOAuthFlow(mcpName, flowState).catch(() => undefined)
      }
      return {
        status: "failed",
        error: OpenScience.redactSecrets(error instanceof Error ? error.message : String(error)),
      }
    }
  }

  /**
   * Remove OAuth credentials for an MCP server.
   */
  export function removeAuth(mcpName: string, options: { reconnect?: boolean } = {}): Promise<void> {
    return withConnectorOperation(mcpName, () => removeAuthLocked(mcpName, options))
  }

  async function removeAuthLocked(mcpName: string, options: { reconnect?: boolean } = {}): Promise<void> {
    const flow = await McpAuth.pendingOAuthFlow(mcpName)
    if (flow) await McpOAuthCallback.cancelPending(mcpName, flow.state)
    await closePendingOAuthTransport(mcpName)
    // Close every project-scoped client before deleting durable authority. If
    // any close fails, retain both its reference and credentials so the
    // operation can be retried and cannot falsely report revocation.
    await Instance.disposeAll({ strict: true })
    // This mutation publishes the cross-process revocation before returning.
    await McpAuth.remove(mcpName)
    if (options.reconnect === false) return
    const cfg = await Config.getExecution()
    const entry = cfg.mcp?.[mcpName]
    if (entry && isMcpConfigured(entry)) await connect(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  export function cancelAuth(mcpName: string, flowId: string): Promise<void> {
    return withConnectorOperation(mcpName, () => cancelAuthLocked(mcpName, flowId))
  }

  async function cancelAuthLocked(mcpName: string, flowId: string): Promise<void> {
    const flow = await McpAuth.pendingOAuthFlow(mcpName)
    if (!flow) {
      // Token persistence is the OAuth exchange linearization point. If a
      // user cancellation races just after it, revoke that exact recent grant
      // instead of reporting Cancel while leaving credentials active.
      const completed = await McpAuth.recentOAuthCompletion(mcpName)
      if (!completed || completed.finalized || (await oauthFlowId(completed.state)) !== flowId) {
        throw new Error(`No matching pending OAuth authorization for MCP server: ${mcpName}`)
      }
      await removeAuthLocked(mcpName, { reconnect: false })
      return
    }
    if ((await oauthFlowId(flow.state)) !== flowId) {
      throw new Error(`OAuth authorization changed before cancellation for MCP server: ${mcpName}`)
    }
    const cancelled = await McpOAuthCallback.cancelPending(mcpName, flow.state)
    if (!cancelled) {
      const completed = await McpAuth.recentOAuthCompletion(mcpName)
      if (!completed || completed.finalized || (await oauthFlowId(completed.state)) !== flowId) {
        throw new Error(`OAuth authorization changed before cancellation for MCP server: ${mcpName}`)
      }
      await removeAuthLocked(mcpName, { reconnect: false })
      return
    }
    await closePendingOAuthTransport(mcpName, flow.state)
    const cleared = await McpAuth.clearOAuthFlowIfCurrent(mcpName, flow.state)
    if (!cleared) {
      const current = await McpAuth.pendingOAuthFlow(mcpName)
      if (current) throw new Error(`OAuth authorization changed before cancellation for MCP server: ${mcpName}`)
    }
  }

  /**
   * Check if an MCP server supports OAuth (remote servers support OAuth by default unless explicitly disabled).
   */
  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.getExecution()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) return false
    if (!isMcpConfigured(mcpConfig)) return false
    return mcpConfig.type === "remote" && mcpConfig.oauth !== false
  }

  /**
   * Check if an MCP server has stored OAuth tokens.
   */
  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const config = (await Config.getExecution()).mcp?.[mcpName]
    if (!config || !isMcpConfigured(config) || config.type !== "remote") return false
    const entry = await McpAuth.getForAuthority(mcpName, config.url, await oauthAuthorityFingerprint(config))
    return !!entry?.tokens
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  /**
   * Get the authentication status for an MCP server.
   */
  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const config = (await Config.getExecution()).mcp?.[mcpName]
    if (!config || !isMcpConfigured(config) || config.type !== "remote") return "not_authenticated"
    const entry = await McpAuth.getForAuthority(mcpName, config.url, await oauthAuthorityFingerprint(config))
    if (!entry?.tokens) return "not_authenticated"
    return entry.tokens.expiresAt !== undefined && entry.tokens.expiresAt < Date.now() / 1000
      ? "expired"
      : "authenticated"
  }
}
