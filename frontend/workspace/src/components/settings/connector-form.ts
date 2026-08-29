import type { Config } from "@synsci/sdk/v2/client"
import { formatConnectorCommand, parseConnectorCommand } from "./connector-command"

type McpConfig = NonNullable<Config["mcp"]>[string]
export type McpType = "local" | "remote"
export type OAuthMode = "off" | "auto" | "client"
export type ConfiguredMcp = Extract<McpConfig, { type: McpType }>
export type ConnectorIdentityIcon = "cloud" | "console" | "discord" | "folder" | "github" | "server"

export interface ConnectorIdentity {
  icon: ConnectorIdentityIcon
  label: string
}

const MASK = "••••••••"

export interface ConnectorFormState {
  name: string
  type: McpType
  command: string
  url: string
  env: string
  headers: string
  oauth: OAuthMode
  clientId: string
  clientSecret: string
  scope: string
  timeout: string
  initiallyDisabled: boolean
  requireClientSecret: boolean
  previous?: ConfiguredMcp
}

export function blankConnectorForm(type: McpType): ConnectorFormState {
  return {
    name: "",
    type,
    command: "",
    url: "",
    env: "",
    headers: "",
    oauth: "auto",
    clientId: "",
    clientSecret: "",
    scope: "",
    timeout: "",
    initiallyDisabled: false,
    requireClientSecret: false,
  }
}

export function connectorFormFromCatalog(setup: {
  type: "remote"
  name: string
  url: string
  oauth: "auto" | "client"
  scope?: string
  confidential_client?: boolean
}): ConnectorFormState {
  return {
    ...blankConnectorForm("remote"),
    name: setup.name,
    url: setup.url,
    oauth: setup.oauth,
    scope: setup.scope ?? "",
    initiallyDisabled: true,
    requireClientSecret: setup.confidential_client === true,
  }
}

export function connectorMatchesCatalogSetup(
  config: ConfiguredMcp | undefined,
  setup: {
    type: "remote"
    url: string
    oauth: "auto" | "client"
    scope?: string
    confidential_client?: boolean
  },
) {
  if (config?.type !== "remote") return false
  try {
    if (new URL(config.url).href !== new URL(setup.url).href) return false
    if (setup.oauth === "auto") {
      return config.oauth !== false && (!config.oauth || !("clientId" in config.oauth))
    }
    if (!config.oauth || !("clientId" in config.oauth) || !config.oauth.clientId) return false
    if (setup.confidential_client && !config.oauth.clientSecret) return false
    return setup.scope === undefined || config.oauth.scope === setup.scope
  } catch {
    return false
  }
}

/**
 * Gives common connectors a recognizable identity without pretending every
 * MCP server has a bespoke brand asset. Unknown entries fall back to their
 * transport, so a hosted server never looks identical to a local process.
 */
export function connectorIdentity(name: string, config: ConfiguredMcp): ConnectorIdentity {
  const target = config.type === "remote" ? config.url : [name, ...config.command].join(" ")
  const haystack = `${name} ${target}`.toLowerCase()

  if (haystack.includes("github")) return { icon: "github", label: "GitHub" }
  if (haystack.includes("discord")) return { icon: "discord", label: "Discord" }
  if (/file[ -]?system|local[ -]?files|workspace[ -]?files/u.test(haystack)) {
    return { icon: "folder", label: "Filesystem" }
  }
  if (/postgres|database|supabase|sqlite/u.test(haystack)) {
    return { icon: "server", label: "Database server" }
  }
  if (config.type === "remote") return { icon: "cloud", label: "Hosted server" }
  return { icon: "console", label: "Local process" }
}

export function connectorFormFromConfig(name: string, config: ConfiguredMcp): ConnectorFormState {
  const base = blankConnectorForm(config.type)
  base.name = name
  base.previous = config
  base.timeout = config.timeout ? String(config.timeout) : ""
  if (config.type === "local") {
    base.command = formatConnectorCommand(config.command)
    base.env = config.environment ? JSON.stringify(maskRecord(config.environment), null, 2) : ""
    return base
  }
  base.url = config.url
  base.headers = config.headers ? JSON.stringify(maskRecord(config.headers), null, 2) : ""
  if (config.oauth === false) base.oauth = "off"
  else if (config.oauth && "clientId" in config.oauth && config.oauth.clientId) {
    base.oauth = "client"
    base.clientId = config.oauth.clientId
    base.clientSecret = config.oauth.clientSecret ? MASK : ""
    base.scope = config.oauth.scope ?? ""
  } else base.oauth = "auto"
  return base
}

function maskRecord(value: Record<string, string>) {
  return Object.fromEntries(Object.keys(value).map((key) => [key, MASK]))
}

export function maskConnectorConfig(value: ConfiguredMcp): ConfiguredMcp {
  if (value.type === "local") {
    return {
      ...value,
      environment: value.environment ? maskRecord(value.environment) : undefined,
    }
  }
  return {
    ...value,
    headers: value.headers ? maskRecord(value.headers) : undefined,
    oauth:
      value.oauth && typeof value.oauth === "object"
        ? {
            ...value.oauth,
            clientSecret: value.oauth.clientSecret ? MASK : undefined,
          }
        : value.oauth,
  }
}

function restoreRecord(value: Record<string, string> | undefined, previous: Record<string, string> | undefined) {
  if (!value) return undefined
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (entry !== MASK) return [key, entry]
      const stored = previous?.[key]
      if (stored === undefined) throw new Error(`Replace the masked value for ${key} before saving`)
      return [key, stored]
    }),
  )
}

function parseRecord(text: string, label: string) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const parsed = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`)
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`)
  }
  return parsed as Record<string, string>
}

export function buildConnectorConfig(state: ConnectorFormState): ConfiguredMcp {
  const timeout = state.timeout.trim() ? Number(state.timeout) : undefined
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error("Timeout must be a positive whole number of milliseconds")
  }
  const enabled = state.previous?.enabled ?? (state.initiallyDisabled ? false : undefined)
  if (state.type === "local") {
    const command = parseConnectorCommand(state.command)
    if (command.length === 0) throw new Error("Command is required")
    const previous = state.previous?.type === "local" ? state.previous : undefined
    const environment = restoreRecord(parseRecord(state.env, "Environment"), previous?.environment)
    return {
      type: "local",
      command,
      ...(environment ? { environment } : {}),
      ...(enabled === false ? { enabled } : {}),
      ...(timeout ? { timeout } : {}),
    }
  }
  if (!URL.canParse(state.url.trim())) throw new Error("Remote URL is invalid")
  const previous = state.previous?.type === "remote" ? state.previous : undefined
  const headers = restoreRecord(parseRecord(state.headers, "Headers"), previous?.headers)
  const oauth = typeof previous?.oauth === "object" ? previous.oauth : undefined
  const secret = state.clientSecret.trim() === MASK ? oauth?.clientSecret : state.clientSecret.trim()
  if (state.oauth === "client" && !state.clientId.trim()) throw new Error("OAuth client ID is required")
  if (state.oauth === "client" && state.requireClientSecret && !secret)
    throw new Error("OAuth client secret is required")
  return {
    type: "remote",
    url: state.url.trim(),
    ...(headers ? { headers } : {}),
    ...(enabled === false ? { enabled } : {}),
    ...(timeout ? { timeout } : {}),
    ...(state.oauth === "off"
      ? { oauth: false }
      : state.oauth === "client"
        ? {
            oauth: {
              clientId: state.clientId.trim(),
              ...(secret ? { clientSecret: secret } : {}),
              ...(state.scope.trim() ? { scope: state.scope.trim() } : {}),
            },
          }
        : { oauth: {} }),
  }
}
