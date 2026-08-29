import { Log } from "../util/log"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { ModelsDev } from "../provider/models"
import { mergeDeep, pipe, unique } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { NamedError } from "@synsci/util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../auth"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"
import { Instance } from "../project/instance"
import { LSPServer } from "../lsp/server"
import { ConfigMarkdown } from "./markdown"
import { existsSync } from "fs"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Event } from "../server/event"
import { ProjectTrust } from "../project/trust"
import { State } from "../project/state"
import { McpSecretStorage } from "../mcp/secret-storage"
import { McpRemoteUrl } from "../mcp/remote-url"
import { CredentialLifecycle } from "../credentials/lifecycle"

export namespace Config {
  const log = Log.create({ service: "config" })
  export const Scope = z.enum(["project", "global"])
  export type Scope = z.infer<typeof Scope>

  // Managed settings directory for enterprise deployments (highest priority, admin-controlled)
  // These settings override all user and project settings
  function getManagedConfigDir(): string {
    const dir = (() => {
      switch (process.platform) {
        case "darwin":
          return "/Library/Application Support/openscience"
        case "win32":
          return path.join(process.env.ProgramData || "C:\\ProgramData", "openscience")
        default:
          return "/etc/openscience"
      }
    })()
    // Enterprise machines provisioned before the OpenScience rename may still
    // use the legacy "synsc" directory; keep honoring it until re-provisioned.
    if (existsSync(dir)) return dir
    const old = dir.replace(/openscience$/, "synsc")
    return existsSync(old) ? old : dir
  }

  const managedConfigDir = process.env.OPENSCIENCE_TEST_MANAGED_CONFIG_DIR || getManagedConfigDir()

  // Config filenames, oldest first: later merges win, so the legacy names load
  // as the base and openscience.json(c) overrides them.
  const CONFIG_FILES = ["synsc.jsonc", "synsc.json", "openscience.jsonc", "openscience.json"]

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.plugin && source.plugin) {
      merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
    }
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    return merged
  }

  let globalRevision = 0

  const loadState = async () => {
    const revision = globalRevision
    const auth = await Auth.all()

    // Load remote/well-known config first as the base layer (lowest precedence)
    // This allows organizations to provide default configs that users can override
    let result: Info = {}
    let execution: Info = {}
    for (const [key, value] of Object.entries(auth)) {
      if (value.type === "wellknown") {
        process.env[value.key] = value.token
        log.debug("fetching remote config", { url: `${key}/.well-known/openscience` })
        // A transient outage/DNS failure on a well-known host must NOT reject
        // Config.get() and brick the whole CLI (it's only the lowest-precedence
        // base layer) — mirror the synced-config resilience: log and continue.
        try {
          const response = await fetch(`${key}/.well-known/openscience`)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const wellknown = (await response.json()) as any
          const remoteConfig = wellknown.config ?? {}
          // Add $schema to prevent load() from trying to write back to a non-existent file
          if (!remoteConfig.$schema) remoteConfig.$schema = "https://syntheticsciences.ai/config.json"
          const remote = await load(JSON.stringify(remoteConfig), `${key}/.well-known/openscience`)
          result = mergeConfigConcatArrays(result, remote)
          execution = mergeConfigConcatArrays(execution, remote)
          log.debug("loaded remote config from well-known", { url: key })
        } catch (e) {
          log.warn("failed to fetch remote config; continuing without it", {
            url: key,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }

    // Global user config overrides remote config
    const user = await global()
    result = mergeConfigConcatArrays(result, user)
    execution = mergeConfigConcatArrays(execution, user)

    // Custom config path overrides global
    if (Flag.OPENSCIENCE_CONFIG) {
      const custom = await loadFile(Flag.OPENSCIENCE_CONFIG)
      result = mergeConfigConcatArrays(result, custom)
      execution = mergeConfigConcatArrays(execution, custom)
      log.debug("loaded custom config", { path: Flag.OPENSCIENCE_CONFIG })
    }

    // Project config has highest precedence (overrides global and remote)
    if (!Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG) {
      for (const file of CONFIG_FILES) {
        const found = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        for (const resolved of found.toReversed()) {
          result = mergeConfigConcatArrays(result, await loadFile(resolved))
        }
      }
    }

    // Inline config content has highest precedence
    if (Flag.OPENSCIENCE_CONFIG_CONTENT) {
      const inline = JSON.parse(Flag.OPENSCIENCE_CONFIG_CONTENT)
      result = mergeConfigConcatArrays(result, inline)
      execution = mergeConfigConcatArrays(execution, inline)
      log.debug("loaded custom config from OPENSCIENCE_CONFIG_CONTENT")
    }

    result.agent = result.agent || {}
    result.mode = result.mode || {}
    result.plugin = result.plugin || []

    const projectDirectories = !Flag.OPENSCIENCE_DISABLE_PROJECT_CONFIG
      ? await Array.fromAsync(
          Filesystem.up({
            targets: [".openscience", ".synsc"],
            start: Instance.directory,
            stop: Instance.worktree,
          }),
        )
      : []
    const projectSet = new Set(projectDirectories.map((dir) => path.resolve(dir)))
    const homeDirectories = Flag.OPENSCIENCE_CONFIG_DIR
      ? []
      : await Array.fromAsync(
          Filesystem.up({
            targets: [".openscience", ".synsc"],
            start: Global.Path.home,
            stop: Global.Path.home,
          }),
        )
    const directories = [
      Global.Path.config,
      // Only scan project .openscience/ directories when project discovery is enabled
      // (".synsc" is the pre-rename name, still honored)
      ...projectDirectories,
      // An explicit config root is an isolation boundary. Do not also discover
      // legacy ~/.openscience configuration from the normal user home.
      ...homeDirectories,
    ]

    if (Flag.OPENSCIENCE_CONFIG_DIR) {
      directories.push(Flag.OPENSCIENCE_CONFIG_DIR)
      log.debug("loading config from OPENSCIENCE_CONFIG_DIR", { path: Flag.OPENSCIENCE_CONFIG_DIR })
    }

    for (const dir of unique(directories)) {
      const local = projectSet.has(path.resolve(dir))
      if (dir.endsWith(".openscience") || dir.endsWith(".synsc") || dir === Flag.OPENSCIENCE_CONFIG_DIR) {
        for (const file of CONFIG_FILES) {
          log.debug(`loading config from ${path.join(dir, file)}`)
          const config = await loadFile(path.join(dir, file))
          result = mergeConfigConcatArrays(result, config)
          if (!local) execution = mergeConfigConcatArrays(execution, config)
          // to satisfy the type checker
          result.agent ??= {}
          result.mode ??= {}
          result.plugin ??= []
        }
      }

      const commands = await loadCommand(dir)
      const agents = await loadAgent(dir)
      const modes = await loadMode(dir)
      const plugins = await loadPlugin(dir)
      result.command = mergeDeep(result.command ?? {}, commands)
      result.agent = mergeDeep(result.agent, agents)
      result.agent = mergeDeep(result.agent, modes)
      result.plugin.push(...plugins)
      if (!local) {
        execution.command = mergeDeep(execution.command ?? {}, commands)
        execution.agent = mergeDeep(execution.agent ?? {}, agents)
        execution.agent = mergeDeep(execution.agent, modes)
        execution.plugin = [...(execution.plugin ?? []), ...plugins]
      }
    }

    // Load synced config from dashboard (below the enterprise-managed layer).
    // Written by OpenScience.syncServices() to the user's XDG config dir. Tolerate
    // a corrupt file: it must never brick config load (and thus the whole CLI).
    // Atomic writes prevent torn files going forward; this covers external
    // corruption or a file written by an older, non-atomic version.
    const syncedConfig = path.join(Global.Path.config, "openscience-synced.json")
    try {
      // Atlas writes model-lockdown config (enabled_providers, per-provider
      // whitelists, default model) for the hosted web agents. On the CLI the
      // managed route is OpenRouter. Honour that managed catalog and the
      // recommended model; drop the rest
      // UNCONDITIONALLY — the
      // synced enabled_providers must never hide a locally-configured BYOK
      // provider, regardless of the billing toggle. An open-source CLI shouldn't
      // let a dashboard allowlist govern the user's own keys; enterprise lockdown
      // stays available via admin-controlled managed config + disabled_providers.
      // (A user's OWN enabled_providers in their config file still gates normally.)
      const synced = await loadFile(syncedConfig)
      const scoped: Partial<Config.Info> = {}
      const managedProviders = {
        ...(synced?.provider?.openrouter ? { openrouter: synced.provider.openrouter } : {}),
      }
      if (Object.keys(managedProviders).length) scoped.provider = managedProviders
      if (typeof synced?.model === "string" && synced.model.startsWith("openrouter/")) scoped.model = synced.model
      // Merge synced UNDERNEATH the user's own config, not on top: it is the
      // server's *recommendation* (default model, OpenRouter managed catalog),
      // not a lockdown, so the user's config must win — otherwise their chosen
      // default model and custom OpenRouter models are reverted on every sync
      // (#159). mergeConfigConcatArrays(base, override) lets `override` win, so
      // pass the user config (result) as the override. Model records still union,
      // so server-whitelisted models the user didn't declare stay available.
      // Enterprise lockdown is unaffected: the managed /etc layer merges LAST
      // below and still wins over both.
      result = mergeConfigConcatArrays(scoped as Config.Info, result)
      execution = mergeConfigConcatArrays(scoped as Config.Info, execution)
    } catch {
      // treat an unreadable synced config as absent
    }

    // Load managed config files LAST (highest priority) - enterprise admin-controlled.
    // Kept separate from directories array to avoid write operations when installing plugins
    // which would fail on system directories requiring elevated permissions
    // This way it only loads config file and not skills/plugins/commands.
    // Must merge AFTER the dashboard-synced config: an admin policy in
    // /etc (or /Library/...) must win over a per-user dashboard value, otherwise
    // the synced config silently overrode the admin's "overrides all" contract.
    if (existsSync(managedConfigDir)) {
      for (const file of CONFIG_FILES) {
        const managed = await loadFile(path.join(managedConfigDir, file))
        result = mergeConfigConcatArrays(result, managed)
        execution = mergeConfigConcatArrays(execution, managed)
      }
    }

    // Migrate deprecated mode field to agent field
    for (const [name, mode] of Object.entries(result.mode ?? {})) {
      result.agent = mergeDeep(result.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }
    for (const [name, mode] of Object.entries(execution.mode ?? {})) {
      execution.agent = mergeDeep(execution.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }

    if (Flag.OPENSCIENCE_PERMISSION) {
      result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENSCIENCE_PERMISSION))
      execution.permission = mergeDeep(execution.permission ?? {}, JSON.parse(Flag.OPENSCIENCE_PERMISSION))
    }

    // Backwards compatibility: legacy top-level `tools` config
    for (const target of [result, execution]) {
      if (!target.tools) continue
      const perms: Record<string, Config.PermissionAction> = {}
      for (const [tool, enabled] of Object.entries(target.tools)) {
        const action: Config.PermissionAction = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          perms.edit = action
          continue
        }
        perms[tool] = action
      }
      target.permission = mergeDeep(perms, target.permission ?? {})
    }

    if (!result.username) result.username = os.userInfo().username

    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    // Apply flag overrides for compaction settings
    if (Flag.OPENSCIENCE_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.OPENSCIENCE_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    result.plugin = deduplicatePlugins(result.plugin ?? [])
    execution.plugin = deduplicatePlugins(execution.plugin ?? [])

    return {
      config: result,
      execution,
      directories,
      executableDirectories: directories.filter((dir) => !projectSet.has(path.resolve(dir))),
      globalRevision: revision,
    }
  }

  const cachedState = Instance.state(loadState)

  export async function state() {
    while (true) {
      const current = await cachedState()
      if (current.globalRevision === globalRevision) return current
      State.clear(Instance.directory, loadState)
    }
  }

  function rel(item: string, patterns: string[]) {
    for (const pattern of patterns) {
      const index = item.indexOf(pattern)
      if (index === -1) continue
      return item.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse command ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = [
        "/.openscience/command/",
        "/.openscience/commands/",
        "/.synsc/command/",
        "/.synsc/commands/",
        "/command/",
        "/commands/",
      ]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse agent ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load agent", { agent: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = [
        "/.openscience/agent/",
        "/.openscience/agents/",
        "/.synsc/agent/",
        "/.synsc/agents/",
        "/agent/",
        "/agents/",
      ]
      const file = rel(item, patterns) ?? path.basename(item)
      const agentName = trim(file)

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const MODE_GLOB = new Bun.Glob("{mode,modes}/*.md")
  async function loadMode(dir: string) {
    const result: Record<string, Agent> = {}
    for await (const item of MODE_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse mode ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load mode", { mode: item, err })
        return undefined
      })
      if (!md) continue

      const config = {
        name: path.basename(item, ".md"),
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = {
          ...parsed.data,
          mode: "primary" as const,
        }
        continue
      }
    }
    return result
  }

  const PLUGIN_GLOB = new Bun.Glob("{plugin,plugins}/*.{ts,js}")
  async function loadPlugin(dir: string) {
    const plugins: string[] = []

    for await (const item of PLUGIN_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      plugins.push(pathToFileURL(item).href)
    }
    return plugins
  }

  /**
   * Extracts a canonical plugin name from a plugin specifier.
   * - For file:// URLs: extracts filename without extension
   * - For npm packages: extracts package name without version
   *
   * @example
   * getPluginName("file:///path/to/plugin/foo.js") // "foo"
   * getPluginName("oh-my-openscience@2.4.3") // "oh-my-openscience"
   * getPluginName("@scope/pkg@1.0.0") // "@scope/pkg"
   */
  export function getPluginName(plugin: string): string {
    if (plugin.startsWith("file://")) {
      return path.parse(new URL(plugin).pathname).name
    }
    const lastAt = plugin.lastIndexOf("@")
    if (lastAt > 0) {
      return plugin.substring(0, lastAt)
    }
    return plugin
  }

  /**
   * Deduplicates plugins by name, with later entries (higher priority) winning.
   * Priority order (highest to lowest):
   * 1. Local plugin/ directory
   * 2. Local openscience.json
   * 3. Global plugin/ directory
   * 4. Global openscience.json
   *
   * Since plugins are added in low-to-high priority order,
   * we reverse, deduplicate (keeping first occurrence), then restore order.
   */
  export function deduplicatePlugins(plugins: string[]): string[] {
    // seenNames: canonical plugin names for duplicate detection
    // e.g., "oh-my-openscience", "@scope/pkg"
    const seenNames = new Set<string>()

    // uniqueSpecifiers: full plugin specifiers to return
    // e.g., "oh-my-openscience@2.4.3", "file:///path/to/plugin.js"
    const uniqueSpecifiers: string[] = []

    for (const specifier of plugins.toReversed()) {
      const name = getPluginName(specifier)
      if (!seenNames.has(name)) {
        seenNames.add(name)
        uniqueSpecifiers.push(specifier)
      }
    }

    return uniqueSpecifiers.toReversed()
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z
        .string()
        .refine(McpRemoteUrl.validEndpoint, {
          message:
            "Remote MCP URLs require HTTPS (loopback HTTP allowed) and must not contain credentials or query data",
        })
        .describe("HTTPS URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>
  export const MCP_SECRET_MASK = "••••••••"

  function redactRecord(value: Record<string, string> | undefined) {
    if (!value) return undefined
    return Object.fromEntries(Object.keys(value).map((key) => [key, MCP_SECRET_MASK]))
  }

  function restoreRecord(
    value: Record<string, string> | undefined,
    previous: Record<string, string> | undefined,
    label: string,
  ) {
    if (!value) return undefined
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (entry !== MCP_SECRET_MASK) return [key, entry]
        const stored = previous?.[key]
        if (stored === undefined) throw new Error(`Replace the masked value for ${label}.${key} before saving`)
        return [key, stored]
      }),
    )
  }

  export function redactMcp(value: Mcp): Mcp {
    if (value.type === "local") {
      return {
        ...value,
        environment: redactRecord(value.environment),
      }
    }
    const oauth =
      value.oauth && typeof value.oauth === "object"
        ? {
            ...value.oauth,
            clientSecret: value.oauth.clientSecret ? MCP_SECRET_MASK : undefined,
          }
        : value.oauth
    return {
      ...value,
      headers: redactRecord(value.headers),
      oauth,
    }
  }

  export function restoreMcp(value: Mcp, previous?: Mcp): Mcp {
    if (value.type === "local") {
      const sameCommand =
        previous?.type === "local" && JSON.stringify(previous.command) === JSON.stringify(value.command)
      const stored = sameCommand ? previous.environment : undefined
      return {
        ...value,
        environment: restoreRecord(value.environment, stored, "environment"),
      }
    }
    const stored = (() => {
      if (previous?.type !== "remote") return undefined
      try {
        return McpRemoteUrl.endpoint(previous.url).toString() === McpRemoteUrl.endpoint(value.url).toString()
          ? previous
          : undefined
      } catch {
        return undefined
      }
    })()
    const oauth = (() => {
      if (!value.oauth || typeof value.oauth !== "object") return value.oauth
      if (value.oauth.clientSecret !== MCP_SECRET_MASK) return value.oauth
      const secret =
        stored?.oauth && typeof stored.oauth === "object" && stored.oauth.clientId === value.oauth.clientId
          ? stored.oauth.clientSecret
          : undefined
      if (!secret) throw new Error("Replace the masked value for oauth.clientSecret before saving")
      return {
        ...value.oauth,
        clientSecret: secret,
      }
    })()
    return {
      ...value,
      headers: restoreRecord(value.headers, stored?.headers, "headers"),
      oauth,
    }
  }

  export function redact(value: Info): Info {
    if (!value.mcp) return value
    return {
      ...value,
      mcp: Object.fromEntries(
        Object.entries(value.mcp).map(([name, entry]) => {
          const parsed = Mcp.safeParse(entry)
          return [name, parsed.success ? redactMcp(parsed.data) : entry]
        }),
      ),
    }
  }

  export function restore(value: Info, previous: Info): Info {
    if (!value.mcp) return value
    return {
      ...value,
      mcp: Object.fromEntries(
        Object.entries(value.mcp).map(([name, entry]) => {
          const parsed = Mcp.safeParse(entry)
          if (!parsed.success) return [name, entry]
          const stored = Mcp.safeParse(previous.mcp?.[name])
          return [name, restoreMcp(parsed.data, stored.success ? stored.data : undefined)]
        }),
      ),
    }
  }

  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          read: PermissionRule.optional(),
          edit: PermissionRule.optional(),
          glob: PermissionRule.optional(),
          grep: PermissionRule.optional(),
          list: PermissionRule.optional(),
          bash: PermissionRule.optional(),
          task: PermissionRule.optional(),
          external_directory: PermissionRule.optional(),
          todowrite: PermissionAction.optional(),
          todoread: PermissionAction.optional(),
          question: PermissionAction.optional(),
          webfetch: PermissionAction.optional(),
          websearch: PermissionAction.optional(),
          codesearch: PermissionAction.optional(),
          lsp: PermissionRule.optional(),
          doom_loop: PermissionAction.optional(),
          skill: PermissionRule.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .transform(permissionTransform)
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  export const Sandbox = z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe(
          "Run local terminals, kernels, and shell commands inside an OS sandbox (macOS Seatbelt / Linux bubblewrap) that confines writes to authorized project roots. Enabled by default; an explicit false selects full host access.",
        ),
      network: z
        .enum(["allow", "deny"])
        .optional()
        .describe("Whether sandboxed commands may reach the network. Default: deny."),
      allowWrite: z
        .array(z.string())
        .optional()
        .describe("Extra absolute paths — beyond the workspace and temp dirs — the sandbox may write to."),
      onUnavailable: z
        .enum(["warn", "error", "allow"])
        .optional()
        .describe(
          "Behaviour when no sandbox backend exists on this platform: 'error' (default) refuses to run, 'warn' runs unsandboxed with a notice, and 'allow' runs unsandboxed silently.",
        ),
      requireProjectTrust: z
        .boolean()
        .optional()
        .describe(
          "Require explicit project trust before any execution, even when a verified OS sandbox is available. Default: false.",
        ),
    })
    .meta({
      ref: "SandboxConfig",
    })
  export type Sandbox = z.infer<typeof Sandbox>

  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Skills = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
  })
  export type Skills = z.infer<typeof Skills>

  export const Agent = z
    .object({
      model: z.string().optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
        .optional()
        .describe("Hex color code for the agent (e.g., #FF5733)"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
      permission: Permission.optional(),
    })
    .catchall(z.any())
    .transform((agent, ctx) => {
      const knownKeys = new Set([
        "name",
        "model",
        "prompt",
        "description",
        "temperature",
        "top_p",
        "mode",
        "hidden",
        "color",
        "steps",
        "maxSteps",
        "options",
        "permission",
        "disable",
        "tools",
      ])

      // Extract unknown properties into options
      const options: Record<string, unknown> = { ...agent.options }
      for (const [key, value] of Object.entries(agent)) {
        if (!knownKeys.has(key)) options[key] = value
      }

      // Convert legacy tools config to permissions
      const permission: Permission = {}
      for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
        const action = enabled ? "allow" : "deny"
        // write, edit, patch, multiedit all map to edit permission
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          permission.edit = action
        } else {
          permission[tool] = action
        }
      }
      Object.assign(permission, agent.permission)

      // Convert legacy maxSteps to steps
      const steps = agent.steps ?? agent.maxSteps

      return { ...agent, options, permission, steps } as typeof agent & {
        options?: Record<string, unknown>
        permission?: Permission
        steps?: number
      }
    })
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("ctrl+r").describe("Rename session"),
      session_delete: z.string().optional().default("ctrl+d").describe("Delete session"),
      stash_delete: z.string().optional().default("ctrl+d").describe("Delete stash entry"),
      model_provider_list: z.string().optional().default("ctrl+a").describe("Open provider list from model dialog"),
      model_favorite_toggle: z.string().optional().default("ctrl+f").describe("Toggle model favorite status"),
      session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      messages_page_up: z.string().optional().default("pageup,ctrl+alt+b").describe("Scroll messages up by one page"),
      messages_page_down: z
        .string()
        .optional()
        .default("pagedown,ctrl+alt+f")
        .describe("Scroll messages down by one page"),
      messages_line_up: z.string().optional().default("ctrl+alt+y").describe("Scroll messages up by one line"),
      messages_line_down: z.string().optional().default("ctrl+alt+e").describe("Scroll messages down by one line"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
      variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
      research_cycle: z.string().optional().default("ctrl+r").describe("Cycle research depth"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,ctrl+return,alt+return,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
      input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      session_child_cycle: z.string().optional().default("<leader>right").describe("Next child session"),
      session_child_cycle_reverse: z.string().optional().default("<leader>left").describe("Previous child session"),
      session_parent: z.string().optional().default("<leader>up").describe("Go to parent session"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      theme_mode_toggle: z.string().optional().default("<leader>m").describe("Toggle dark/light mode"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Provider = ModelsDev.Provider.partial()
    .extend({
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z
        .record(
          z.string(),
          ModelsDev.Model.partial().extend({
            variants: z
              .record(
                z.string(),
                z
                  .object({
                    disabled: z.boolean().optional().describe("Disable this variant for the model"),
                  })
                  .catchall(z.any()),
              )
              .optional()
              .describe("Variant-specific configuration"),
          }),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          tokenCommand: z
            .string()
            .optional()
            .describe(
              "Shell command whose stdout is a short-lived bearer token. Sent as 'Authorization: Bearer <token>' on every request and re-minted automatically before the token's JWT exp (or every request for a non-JWT token). Use for providers behind rotating/SSO-minted credentials.",
            ),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .max(2_147_483_647)
                .describe(
                  "Optional total wall-clock timeout in milliseconds for a provider request. No total timeout is applied by default; active long-running generations are allowed to finish.",
                ),
              z.literal(false).describe("Explicitly disable the optional total wall-clock timeout."),
            ])
            .optional()
            .describe(
              "Optional total wall-clock timeout in milliseconds for a provider request. No total timeout is applied by default. Use idleTimeout to bound silent connections without cutting off active generations.",
            ),
          idleTimeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .max(2_147_483_647)
                .describe(
                  "Optional maximum provider inactivity in milliseconds while connecting or waiting for the next response-body chunk. Disabled by default and resets on every body chunk when configured.",
                ),
              z.literal(false).describe("Disable the provider inactivity watchdog."),
            ])
            .optional()
            .describe(
              "Optional maximum provider inactivity in milliseconds while connecting or waiting for the next response-body chunk. Disabled by default; when configured it resets on each body chunk and does not cap total generation time.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      theme: z.string().optional().describe("Theme name to use for the interface"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      server: Server.optional().describe("Server configuration for openscience serve and web commands"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://syntheticsciences.ai/docs/commands"),
      skills: Skills.optional().describe("Additional skill folder paths"),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      plugin: z.string().array().optional(),
      snapshot: z.boolean().optional(),
      autoupdate: z
        .union([z.boolean(), z.literal("notify")])
        .optional()
        .describe(
          "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
        ),
      disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
      enabled_providers: z
        .array(z.string())
        .optional()
        .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
      model: z.string().describe("Model to use in the format of provider/model, eg anthropic/claude-2").optional(),
      small_model: z
        .string()
        .describe("Small model to use for tasks like title generation in the format of provider/model")
        .optional(),
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Must be a primary agent. Falls back to 'research' if not set or if the specified agent is invalid.",
        ),
      billing: z
        .object({
          llm: z
            .enum(["managed", "byok"])
            .nullable()
            .optional()
            .describe(
              "How LLM inference is paid for. 'managed' uses Credits; 'byok' uses your own provider API keys or first-party OAuth (ChatGPT/Claude Pro/Copilot) and is never billed. Unset or null = auto-detect from the resolved credential.",
            ),
          compute: z
            .enum(["managed", "byok"])
            .optional()
            .describe(
              "@deprecated Retained only so existing 2.x config files keep parsing. Managed compute is retired; all compute uses user-owned routes regardless of this value.",
            ),
        })
        .optional()
        .describe("How LLM inference is paid for when using Ace or user-owned credentials. Legacy compute is ignored."),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      mode: z
        .object({
          build: Agent.optional(),
          plan: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("@deprecated Use `agent` field instead."),
      agent: z
        .object({
          // primary
          plan: Agent.optional(),
          build: Agent.optional(),
          write: Agent.optional(),
          // subagent
          explore: Agent.optional(),
          // specialized
          title: Agent.optional(),
          compaction: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("Agent configuration, see https://syntheticsciences.ai/docs/agents"),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z
        .record(
          z.string(),
          z.union([
            Mcp,
            z
              .object({
                enabled: z.boolean(),
              })
              .strict(),
          ]),
        )
        .optional()
        .describe("MCP (Model Context Protocol) server configurations"),
      formatter: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      lsp: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.union([
              z.object({
                disabled: z.literal(true),
              }),
              z.object({
                command: z.array(z.string()),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
                env: z.record(z.string(), z.string()).optional(),
                initialization: z.record(z.string(), z.any()).optional(),
              }),
            ]),
          ),
        ])
        .optional()
        .refine(
          (data) => {
            if (!data) return true
            if (typeof data === "boolean") return true
            const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

            return Object.entries(data).every(([id, config]) => {
              if (config.disabled) return true
              if (serverIds.has(id)) return true
              return Boolean(config.extensions)
            })
          },
          {
            error: "For custom LSP servers, 'extensions' array is required.",
          },
        ),
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: Permission.optional(),
      sandbox: Sandbox.optional().describe("OS-level execution sandbox for the agent's shell commands."),
      tools: z.record(z.string(), z.boolean()).optional(),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Compact when context exceeds this fraction of the model window (default: 0.75)"),
          fallbackContext: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Assumed context window (tokens) when a provider reports 0 (default: 128000)"),
          tailTurns: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Minimum recent turns kept verbatim during compaction (default: 2)"),
          tailTokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Token budget for the verbatim recent tail during compaction (default: clamp(0.20*usable, 8000, 32000))",
            ),
        })
        .optional(),
      experimental: z
        .object({
          hook: z
            .object({
              file_edited: z
                .record(
                  z.string(),
                  z
                    .object({
                      command: z.string().array(),
                      environment: z.record(z.string(), z.string()).optional(),
                    })
                    .array(),
                )
                .optional(),
              session_completed: z
                .object({
                  command: z.string().array(),
                  environment: z.record(z.string(), z.string()).optional(),
                })
                .array()
                .optional(),
            })
            .optional(),
          chatMaxRetries: z.number().optional().describe("Number of retries for chat completions on failure"),
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          plan_mode: z.boolean().optional().describe("Replace TodoWrite with PlanWrite and show plan panel in sidebar"),
          mcp_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  export const global = lazy(async () => {
    let result: Info = pipe(
      {},
      mergeDeep(await loadFile(path.join(Global.Path.config, "config.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "openscience.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "openscience.jsonc"))),
    )

    const legacy = path.join(Global.Path.config, "config")
    if (existsSync(legacy)) {
      await import(pathToFileURL(legacy).href, {
        with: {
          type: "toml",
        },
      })
        .then(async (mod) => {
          const { provider, model, ...rest } = mod.default
          const files = ["config.json", "openscience.json", "openscience.jsonc"].map((name) =>
            path.join(Global.Path.config, name),
          )
          await CredentialLifecycle.serialized(async () => {
            // Re-read every source under the shared config lease. The initial
            // lazy-load snapshot may be stale if another process wrote MCP
            // authority while the TOML module was loading.
            let current: Info = {}
            for (const file of files) {
              const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined
                throw error
              })
              if (!raw) continue
              const protectedText = await sealedConfigText(raw, file)
              if (protectedText !== raw) await durableConfigWrite(file, protectedText)
              current = mergeDeep(current, await McpSecretStorage.reveal(parseConfig(protectedText, file)))
            }
            if (provider && model) current.model = `${provider}/${model}`
            current["$schema"] = "https://syntheticsciences.ai/config.json"
            result = mergeDeep(current, rest)
            const target = path.join(Global.Path.config, "config.json")
            const protectedText = await sealedConfigText(JSON.stringify(result, null, 2), target)
            await durableConfigWrite(target, protectedText)
          })
          await fs.unlink(legacy)
        })
        .catch(() => {})
    }

    return result
  })

  async function loadFile(filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    text = await protectConfigText(text, filepath)
    if (!text) return {}
    return load(text, filepath)
  }

  async function loadFileWithoutMigration(filepath: string): Promise<Info> {
    const text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    return load(text, filepath)
  }

  async function sealedConfigText(text: string, filepath: string): Promise<string> {
    const errors: JsoncParseError[] = []
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) return text
    let result = text
    for (const item of McpSecretStorage.paths(value)) {
      const sealed = await McpSecretStorage.seal(item.value, item.context)
      if (sealed === item.value) continue
      result = applyEdits(
        result,
        modify(result, item.path, sealed, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
    }
    if (result === text) return text

    const checked = parseJsonc(result, [], { allowTrailingComma: true }) as unknown
    const revealed = await McpSecretStorage.reveal(checked)
    const expected = Object.fromEntries(
      await Promise.all(
        McpSecretStorage.paths(value).map(async (item) => [
          item.path.join("\u0000"),
          await McpSecretStorage.open(item.value, item.context),
        ]),
      ),
    )
    const actual = Object.fromEntries(
      McpSecretStorage.paths(revealed).map((item) => [item.path.join("\u0000"), item.value]),
    )
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new JsonError({ path: filepath, message: "Encrypted MCP fields did not round-trip exactly" })
    }
    return result
  }

  async function durableConfigWrite(filepath: string, text: string): Promise<void> {
    const parsed = parseConfig(text, filepath)
    await McpSecretStorage.reveal(parsed).catch((error) => {
      throw new JsonError({ path: filepath, message: "An encrypted MCP field could not be verified" }, { cause: error })
    })
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    const temporary = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, "wx", 0o600)
      await handle
        .writeFile(text, "utf8")
        .then(() => handle.chmod(0o600))
        .then(() => handle.sync())
        .finally(() => handle.close())
      const persisted = await fs.readFile(temporary, "utf8")
      if (persisted !== text) throw new Error("Config candidate changed before commit")
      await McpSecretStorage.reveal(parseConfig(persisted, filepath))
      await fs.rename(temporary, filepath)
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(filepath), "r")
        await directory.sync().finally(() => directory.close())
      }
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async function protectConfigText(text: string, filepath: string): Promise<string | undefined> {
    if ((await sealedConfigText(text, filepath)) === text) return text
    // Re-read under the same cross-process lease used by every config RMW.
    // Computing from the pre-lease snapshot could overwrite a sibling setMcp
    // that landed between read and migration.
    return CredentialLifecycle.serialized(async () => {
      const current = await fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (current === undefined) return undefined
      const protectedText = await sealedConfigText(current, filepath)
      if (protectedText !== current) await durableConfigWrite(filepath, protectedText)
      return protectedText
    })
  }

  async function ensureConfigSchema(filepath: string): Promise<void> {
    await CredentialLifecycle.serialized(async () => {
      const current = await fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!current) return
      const parsed = parseJsonc(current, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.$schema) return
      const updated = applyEdits(
        current,
        modify(current, ["$schema"], "https://syntheticsciences.ai/config.json", {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
      await durableConfigWrite(filepath, await sealedConfigText(updated, filepath))
    })
  }

  async function resolveReferences(value: unknown, configFilepath: string): Promise<unknown> {
    if (typeof value === "string") {
      let resolved = value.replace(/\{env:([^}]+)\}/g, (_, varName: string) => process.env[varName] || "")
      const matches = [...resolved.matchAll(/\{file:([^}]+)\}/g)]
      for (const match of matches) {
        const reference = match[0]
        let filePath = match[1]
        if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2))
        const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(path.dirname(configFilepath), filePath)
        const contents = await Bun.file(absolute)
          .text()
          .catch((error: NodeJS.ErrnoException) => {
            const message = `bad file reference: "${reference}"`
            if (error.code === "ENOENT") {
              throw new InvalidError(
                { path: configFilepath, message: `${message} ${absolute} does not exist` },
                { cause: error },
              )
            }
            throw new InvalidError({ path: configFilepath, message }, { cause: error })
          })
        resolved = resolved.replace(reference, contents.trim())
      }
      return resolved
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => resolveReferences(item, configFilepath)))
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, item]) => [key, await resolveReferences(item, configFilepath)]),
      ),
    )
  }

  async function load(text: string, configFilepath: string) {
    const errors: JsoncParseError[] = []
    const raw = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configFilepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    // Bound MCP envelopes intentionally use the literal, persisted authority
    // representation as associated data. Reveal them before expanding
    // `{env:...}` / `{file:...}` references so a legitimate reference-backed
    // URL, client ID, scope, or local command cannot change the seal context.
    const revealed = await McpSecretStorage.reveal(raw)
    const parsed = Info.safeParse(await resolveReferences(revealed, configFilepath))
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = "https://syntheticsciences.ai/config.json"
        // Patch the latest bytes under the same cross-process lease as every
        // config mutation. A read must never resurrect stale MCP authority.
        await ensureConfigSchema(configFilepath).catch(() => undefined)
      }
      const data = parsed.data
      if (data.plugin) {
        for (let i = 0; i < data.plugin.length; i++) {
          const plugin = data.plugin[i]
          try {
            data.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {}
        }
      }
      return data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function getExecution() {
    const current = await state()
    if (await ProjectTrust.allowed(Instance.project)) return current.config
    return {
      ...current.config,
      command: current.execution.command,
      agent: current.execution.agent,
      mode: current.execution.mode,
      default_agent: current.execution.default_agent,
      permission: current.execution.permission,
      tools: current.execution.tools,
      plugin: current.execution.plugin,
      mcp: current.execution.mcp,
      formatter: current.execution.formatter,
      lsp: current.execution.lsp,
      skills: current.execution.skills,
      provider: current.execution.provider,
    }
  }

  /**
   * Whether a named executable setting is supplied or changed by project
   * config. This provenance is kept separate from getExecution(): callers with
   * cached formatter/LSP definitions still need to re-check trust after a
   * project is revoked.
   */
  export async function projectControls(section: "formatter" | "lsp", name: string) {
    const current = await state()
    const value = (config: Info) => {
      const entries = config[section]
      if (entries === false) return false
      return entries?.[name]
    }
    return JSON.stringify(value(current.config)) !== JSON.stringify(value(current.execution))
  }

  /** Whether an exact provider token command entered through project-owned
   * config. Unlike getExecution(), the baseline remains project-free after a
   * project is trusted, so cached provider clients can keep enforcing trust at
   * every later mint boundary. */
  export async function projectControlsProviderToken(providerID: string, command: string) {
    const current = await state()
    const value = (config: Info) => config.provider?.[providerID]?.options?.tokenCommand
    return value(current.config) === command && value(current.execution) !== command
  }

  /** Whether this exact plugin entry entered through project-owned config or a
   * project-local plugin directory. The execution baseline contains only
   * remote, global, custom-CLI, synced, and managed sources, so comparing the
   * final deduplicated entries preserves provenance even when a local plugin
   * overrides a global plugin with the same package name. */
  export async function projectControlsPlugin(plugin: string) {
    const current = await state()
    const all = current.config.plugin ?? []
    const trusted = current.execution.plugin ?? []
    return all.includes(plugin) && !trusted.includes(plugin)
  }

  /** Whether an MCP definition entered through project-owned config. Kept as
   * provenance so a tool object retained across revocation can re-check trust
   * at its actual remote call boundary. */
  export async function projectControlsMcp(name: string) {
    const current = await state()
    return JSON.stringify(current.config.mcp?.[name]) !== JSON.stringify(current.execution.mcp?.[name])
  }

  export async function getGlobal() {
    return global()
  }

  export async function update(config: Info) {
    // Write to an actual project config READ path (openscience.json / .openscience/…)
    // — the previous `<Instance.directory>/config.json` is only read as the GLOBAL
    // config, never as project config, so PATCH /config appeared to save but the
    // change vanished on the next Instance reload.
    const filepath = projectConfigFile()
    // Read (and, for a legacy plaintext MCP config, migrate) before entering
    // the update mutation. protectConfigText owns the same cross-process
    // credential lease, so doing this inside `write` would self-deadlock.
    await loadFile(filepath)
    const write = async () => {
      const existing = await loadFileWithoutMigration(filepath)
      const protectedConfig = await McpSecretStorage.protect(mergeDeep(existing, config))
      await durableConfigWrite(filepath, JSON.stringify(protectedConfig, null, 2))
      await Instance.dispose({ strict: config.mcp !== undefined })
    }
    if (config.mcp === undefined) return CredentialLifecycle.serialized(write)
    return CredentialLifecycle.mutate("mcp-config.project-update", write)
  }

  function globalConfigFile() {
    const candidates = ["openscience.jsonc", "openscience.json", "config.json"].map((file) =>
      path.join(Global.Path.config, file),
    )
    for (const file of candidates) {
      if (existsSync(file)) return file
    }
    return candidates[0]
  }

  function projectConfigFile() {
    const candidates = [
      path.join(Instance.worktree, "openscience.jsonc"),
      path.join(Instance.worktree, "openscience.json"),
      path.join(Instance.worktree, ".openscience", "openscience.jsonc"),
      path.join(Instance.worktree, ".openscience", "openscience.json"),
      // legacy pre-rename names: keep writing to an existing project config
      path.join(Instance.worktree, "synsc.jsonc"),
      path.join(Instance.worktree, "synsc.json"),
      path.join(Instance.worktree, ".synsc", "synsc.jsonc"),
      path.join(Instance.worktree, ".synsc", "synsc.json"),
    ]
    for (const file of candidates) {
      if (existsSync(file)) return file
    }
    return candidates[0]
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
    if (!isRecord(patch)) {
      const edits = modify(input, path, patch, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      return applyEdits(input, edits)
    }

    return Object.entries(patch).reduce((result, [key, value]) => {
      if (value === undefined) return result
      return patchJsonc(result, value, [...path, key])
    }, input)
  }

  /**
   * Refresh per-project config after a GLOBAL write and announce it. Most
   * global settings still dispose open project instances because their MCP,
   * plugin, sandbox, formatter, or LSP state may need rebuilding. Narrow
   * routing-only writes can preserve those instances: the revision carried by
   * Config.state makes the new value visible to the next Config.get() without
   * interrupting an active turn.
   *
   * The provider cache is dropped here too, and specifically BEFORE the
   * announcement. Provider memoises the resolved provider/SDK map at module
   * scope keyed only by directory + trust, which Instance.disposeAll() does
   * not touch and this write does not change — so it outlives the write. The
   * SPA refetches GET /provider the instant it sees `global.disposed`, and a
   * refetch that lands in the gap re-memoises the PRE-write map (the key just
   * added still missing, billing still reading managed) with nothing left to
   * invalidate it afterwards. Announcing a disposal that the provider map has
   * not honoured yet is the bug; the two belong together.
   */
  async function disposeGlobalInstances(options: { preserveInstances?: boolean; strict?: boolean } = {}) {
    globalRevision++
    if (!options.preserveInstances) {
      if (options.strict) await Instance.disposeAll({ strict: true })
      else await Instance.disposeAll().catch(() => undefined)
    }
    // Lazy because provider.ts imports Config — the same cycle-break
    // provider/models.ts and openscience/index.ts already use to reach it.
    // Best-effort like the disposal above: the config file is already written
    // by the time this runs, so a throw here (e.g. provider module init
    // failing) must not turn a landed write into a rejected one.
    await import("../provider/provider")
      .then((m) => m.Provider.invalidate())
      .catch((e) =>
        log.warn("failed to invalidate provider cache", { error: e instanceof Error ? e.message : String(e) }),
      )
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Event.Disposed.type,
        properties: {},
      },
    })
  }

  /**
   * Config.updateGlobal is also the narrow write path for model selection and
   * billing-route changes. Those values are consumed through Config.state (and
   * Provider's separately invalidated memo), so the revision above is enough
   * to make them visible immediately. Tearing down every project for these
   * patches would interrupt active turns and reject unrelated approvals.
   *
   * Keep the allow-list deliberately small: MCP, provider definitions,
   * plugins, permissions, sandboxing, formatters, LSP, and other runtime
   * configuration still require the normal full instance rebuild.
   */
  function canPreserveInstances(config: Info) {
    const refreshOnly = new Set<keyof Info>(["billing", "model", "small_model"])
    return Object.keys(config).every((key) => refreshOnly.has(key as keyof Info))
  }

  async function patchConfigPath(scope: Scope, target: string[], value: unknown) {
    const write = async () => {
      const filepath = scope === "global" ? globalConfigFile() : projectConfigFile()
      const before = await Bun.file(filepath)
        .text()
        .catch((err) => {
          if (err.code === "ENOENT") return "{}"
          throw new JsonError({ path: filepath }, { cause: err })
        })
      const edits = modify(before, target, value, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      const updated = applyEdits(before, edits)
      const protectedText = await sealedConfigText(updated, filepath)
      await durableConfigWrite(filepath, protectedText)
      const parsed = parseConfig(protectedText, filepath)
      global.reset()
      if (scope === "global") {
        await disposeGlobalInstances({ strict: target[0] === "mcp" })
      } else {
        await Instance.dispose({ strict: target[0] === "mcp" })
      }
      return { config: parsed, path: filepath }
    }
    if (target[0] !== "mcp") return CredentialLifecycle.serialized(write)
    return CredentialLifecycle.mutate(`mcp-config.patch:${target[1] ?? "root"}`, write)
  }

  export async function setMcp(name: string, mcp: Mcp, scope: Scope = "global") {
    return patchConfigPath(scope, ["mcp", name], mcp)
  }

  export async function removeMcp(name: string, scope: Scope = "global") {
    return patchConfigPath(scope, ["mcp", name], undefined)
  }

  /** Register a custom provider block (e.g. a local Ollama / LM Studio /
   *  OpenAI-compatible endpoint) under `provider.<id>`, JSONC-preserving.
   *  Defaults to the GLOBAL config since a local endpoint is machine-wide, not
   *  per-project. Mirrors setMcp. */
  export async function setProvider(id: string, provider: Provider, scope: Scope = "global") {
    return patchConfigPath(scope, ["provider", id], provider)
  }

  /** Remove a custom provider block. */
  export async function removeProvider(id: string, scope: Scope = "global") {
    return patchConfigPath(scope, ["provider", id], undefined)
  }

  /**
   * Execution-sandbox policy resolved from GLOBAL + MANAGED (admin) config only.
   * Project config is deliberately excluded: the sandbox is a machine-wide safety
   * boundary, so an untrusted repo's `openscience.json` must not be able to weaken
   * or disable it. Managed (enterprise) config wins over the user's global config.
   */
  export async function trustedSandboxPolicy(): Promise<{
    config: Sandbox
    managed: Sandbox
  }> {
    const base = (await global()).sandbox
    let managed: Sandbox | undefined
    if (existsSync(managedConfigDir)) {
      let acc: Info = {}
      for (const file of CONFIG_FILES) acc = mergeDeep(acc, await loadFile(path.join(managedConfigDir, file)))
      managed = acc.sandbox
    }
    const policy = { ...(base ?? {}), ...(managed ?? {}) }
    return {
      managed: managed ?? {},
      config: {
        // New installations start in the low-friction contained mode. `false`
        // remains an explicit, durable Full access choice for existing users.
        enabled: policy.enabled ?? true,
        network: policy.network ?? "deny",
        allowWrite: policy.allowWrite ?? [],
        onUnavailable: policy.onUnavailable ?? "error",
        requireProjectTrust: policy.requireProjectTrust ?? false,
      },
    }
  }

  export async function trustedSandbox(): Promise<Sandbox> {
    return trustedSandboxPolicy().then((value) => value.config)
  }

  /** Merge a patch into the GLOBAL `sandbox` config block, JSONC-preserving. The
   *  execution sandbox is a machine-wide safety setting and is only ever read
   *  from global + managed config (see {@link trustedSandbox}), so it is always
   *  written globally — a project-scoped value would be silently ignored. */
  export async function setSandbox(patch: Partial<Sandbox>) {
    const current = (await getGlobal()).sandbox
    const next: Sandbox = { ...(current ?? {}), ...patch }
    return patchConfigPath("global", ["sandbox"], next)
  }

  /** Remove a key path from the global config (deep-merge can't unset). */
  export async function unsetGlobal(target: string[]) {
    return patchConfigPath("global", target, undefined)
  }

  /** Read the raw (verbatim) global config file for an advanced editor. */
  export async function getGlobalRaw() {
    const filepath = globalConfigFile()
    const content = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return "{}\n"
        throw new JsonError({ path: filepath }, { cause: err })
      })
    return { content, path: filepath }
  }

  /** Replace the entire global config with verbatim content (supports
   *  removing keys, unlike the deep-merging updateGlobal). Validates that the
   *  content parses and matches the schema before writing. */
  export async function replaceGlobal(content: string) {
    return CredentialLifecycle.mutate("mcp-config.replace-global", async () => {
      const filepath = globalConfigFile()
      const parsed = parseConfig(content, filepath)
      const protectedText = await sealedConfigText(content, filepath)
      await durableConfigWrite(filepath, protectedText)
      global.reset()
      await disposeGlobalInstances({ strict: true })
      return parsed
    })
  }

  function parseConfig(text: string, filepath: string): Info {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: filepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export async function updateGlobal(config: Info, options: { preserveInstances?: boolean } = {}) {
    const write = async () => {
      const filepath = globalConfigFile()
      const before = await Bun.file(filepath)
        .text()
        .catch((err) => {
          if (err.code === "ENOENT") return "{}"
          throw new JsonError({ path: filepath }, { cause: err })
        })

      const existingProtected = parseConfig(before, filepath)
      const existing = await McpSecretStorage.reveal(existingProtected)
      const protectedMerged = await McpSecretStorage.protect(mergeDeep(existing, config))
      const next = await (async () => {
        if (!filepath.endsWith(".jsonc")) {
          const protectedText = await sealedConfigText(JSON.stringify(protectedMerged, null, 2), filepath)
          await durableConfigWrite(filepath, protectedText)
          return parseConfig(protectedText, filepath)
        }

        const updated = patchJsonc(before, protectedMerged)
        const protectedText = await sealedConfigText(updated, filepath)
        const merged = parseConfig(protectedText, filepath)
        await durableConfigWrite(filepath, protectedText)
        return merged
      })()

      global.reset()
      await disposeGlobalInstances({
        preserveInstances: options.preserveInstances ?? canPreserveInstances(config),
        strict: config.mcp !== undefined,
      })

      return McpSecretStorage.reveal(next)
    }
    if (config.mcp === undefined) return CredentialLifecycle.serialized(write)
    return CredentialLifecycle.mutate("mcp-config.update-global", write)
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }

  export async function executableDirectories() {
    const current = await state()
    if (await ProjectTrust.allowed(Instance.project)) return current.directories
    return current.executableDirectories
  }
}
