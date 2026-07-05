import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { McpAuth } from "./auth"
import { Log } from "../util/log"

const log = Log.create({ service: "mcp.oauth" })

// Single-flight token refresh per server. Servers that rotate the refresh
// token invalidate the old one on every refresh, so two concurrent refreshes
// in this process would leave one caller holding a revoked token. Mirrors the
// codex recovery pattern in plugin/codex.ts.
const refreshing = new Map<string, Promise<McpAuth.Tokens | undefined>>()

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenScience",
      client_uri: "https://syntheticsciences.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await McpAuth.updateClientInfo(
      this.mcpName,
      {
        clientId: info.client_id,
        clientSecret: info.client_secret,
        clientIdIssuedAt: info.client_id_issued_at,
        clientSecretExpiresAt: info.client_secret_expires_at,
      },
      this.serverUrl,
    )
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (!entry?.tokens) return undefined

    const expired = entry.tokens.expiresAt !== undefined && entry.tokens.expiresAt < Date.now() / 1000
    if (!expired || !entry.tokens.refreshToken) return this.format(entry.tokens)

    const refreshed = await this.single(entry.tokens.refreshToken)
    if (refreshed) return this.format(refreshed)

    // Refresh failed even after recovery — hand back the stored tokens so
    // the SDK's own auth flow surfaces re-authentication.
    return this.format(entry.tokens)
  }

  private format(tokens: McpAuth.Tokens): OAuthTokens {
    return {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresAt ? Math.max(0, Math.floor(tokens.expiresAt - Date.now() / 1000)) : undefined,
      scope: tokens.scope,
    }
  }

  /** Single-flight wrapper: concurrent callers share one refresh round-trip. */
  private single(refreshToken: string): Promise<McpAuth.Tokens | undefined> {
    const inflight = refreshing.get(this.mcpName)
    if (inflight) return inflight
    const started = this.recover(refreshToken).finally(() => {
      refreshing.delete(this.mcpName)
    })
    refreshing.set(this.mcpName, started)
    return started
  }

  /** Refresh with cross-process recovery. The single-flight guard only
   *  covers this process; when another openscience process wins a refresh
   *  race against a rotating-refresh server, it has already persisted the
   *  rotated pair. Re-read the store before surfacing re-auth, and retry
   *  once with the rotated token. */
  private async recover(refreshToken: string): Promise<McpAuth.Tokens | undefined> {
    try {
      return await this.refresh(refreshToken)
    } catch (error) {
      const latest = (await McpAuth.getForUrl(this.mcpName, this.serverUrl))?.tokens
      const valid = latest?.expiresAt === undefined || latest.expiresAt > Date.now() / 1000
      if (latest?.accessToken && valid) return latest
      if (latest?.refreshToken && latest.refreshToken !== refreshToken) {
        const retried = await this.refresh(latest.refreshToken).catch(() => undefined)
        if (retried) return retried
      }
      log.warn("token refresh failed", {
        mcpName: this.mcpName,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** One refresh round-trip via the SDK helpers, persisted on success. */
  private async refresh(refreshToken: string): Promise<McpAuth.Tokens> {
    const client = await this.clientInformation()
    if (!client) throw new Error(`no OAuth client information for MCP server: ${this.mcpName}`)
    const metadata = await discoverOAuthProtectedResourceMetadata(this.serverUrl).catch(() => undefined)
    const issuer = metadata?.authorization_servers?.[0] ?? new URL("/", this.serverUrl)
    const server = await discoverAuthorizationServerMetadata(issuer)
    const resource = await selectResourceURL(this.serverUrl, this, metadata)
    const tokens = await refreshAuthorization(issuer, {
      metadata: server,
      clientInformation: client,
      refreshToken,
      resource,
    })
    await this.saveTokens(tokens)
    log.info("refreshed oauth tokens", { mcpName: this.mcpName })
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
      scope: tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await McpAuth.updateTokens(
      this.mcpName,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
        scope: tokens.scope,
      },
      this.serverUrl,
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await McpAuth.updateCodeVerifier(this.mcpName, codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await McpAuth.updateOAuthState(this.mcpName, state)
  }

  async state(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.oauthState) {
      throw new Error(`No OAuth state saved for MCP server: ${this.mcpName}`)
    }
    return entry.oauthState
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
