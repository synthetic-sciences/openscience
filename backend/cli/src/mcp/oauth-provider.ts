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
import { CredentialLifecycle } from "../credentials/lifecycle"
import { FileLease } from "../util/file-lease"
import { Global } from "../global"
import crypto from "node:crypto"
import path from "node:path"
import { McpRemoteUrl } from "./remote-url"

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

export interface McpOAuthAuthority {
  verify: () => Promise<void>
  flowState?: string
  authorityFingerprint?: string
  allowDisabled?: boolean
}

export class McpOAuthProvider implements OAuthClientProvider {
  private refreshCandidate?: string

  private async boundEntry(): Promise<McpAuth.Entry | undefined> {
    const fingerprint = this.authority?.authorityFingerprint
    if (!fingerprint) throw new Error(`MCP OAuth authority binding is missing for: ${this.mcpName}`)
    return McpAuth.getForAuthority(this.mcpName, this.serverUrl, fingerprint)
  }

  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private authority?: McpOAuthAuthority,
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
    const entry = await this.boundEntry()
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
    const clientInfo = {
      clientId: info.client_id,
      clientSecret: info.client_secret,
      clientIdIssuedAt: info.client_id_issued_at,
      clientSecretExpiresAt: info.client_secret_expires_at,
    }
    const flowState = this.authority?.flowState
    const fingerprint = this.authority?.authorityFingerprint
    if (!fingerprint) throw new Error(`MCP OAuth authority binding is missing for: ${this.mcpName}`)
    if (!flowState) {
      throw new Error(`Passive MCP OAuth cannot register a client for: ${this.mcpName}`)
    }
    await CredentialLifecycle.serialized(async () => {
      await this.authority?.verify()
      const applied = await McpAuth.updateClientInfoIfOAuthFlow(
        this.mcpName,
        flowState,
        this.serverUrl,
        fingerprint,
        clientInfo,
      )
      if (!applied) throw new Error(`OAuth authority changed before client registration for: ${this.mcpName}`)
    })
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await this.boundEntry()
    if (!entry?.tokens) return undefined

    const expired = entry.tokens.expiresAt !== undefined && entry.tokens.expiresAt < Date.now() / 1000
    if (!expired || !entry.tokens.refreshToken) {
      this.refreshCandidate = entry.tokens.refreshToken
      return this.format(entry.tokens)
    }

    this.refreshCandidate = entry.tokens.refreshToken
    const refreshed = await this.single(entry.tokens.refreshToken)
    if (refreshed) {
      // The MCP SDK may perform its own refresh after reading these tokens.
      // Bind that later save/invalidation to this exact returned generation.
      this.refreshCandidate = refreshed.refreshToken
      return this.format(refreshed)
    }

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
    const key = `${this.mcpName}\0${this.serverUrl}`
    const inflight = refreshing.get(key)
    if (inflight) return inflight
    const started = this.serializedRefresh(refreshToken).finally(() => {
      if (refreshing.get(key) === started) refreshing.delete(key)
    })
    refreshing.set(key, started)
    return started
  }

  private async serializedRefresh(initialRefreshToken: string): Promise<McpAuth.Tokens | undefined> {
    const digest = crypto.createHash("sha256").update(`${this.mcpName}\0${this.serverUrl}`).digest("hex")
    const lock = path.join(Global.Path.data, "mcp-oauth-refresh", `${digest}.lock`)
    await using lease = await FileLease.acquire(lock, 30_000)
    return await lease.during(async () => {
      // Another process may have refreshed while this caller waited for the
      // connector-scoped lease. Re-read before any provider request.
      const latest = (await this.boundEntry())?.tokens
      const valid = latest?.expiresAt === undefined || latest.expiresAt > Date.now() / 1000
      if (latest?.accessToken && valid) return latest
      const refreshToken = latest?.refreshToken ?? initialRefreshToken
      return this.recover(refreshToken)
    })
  }

  /** Refresh with cross-process recovery. The single-flight guard only
   *  covers this process; when another openscience process wins a refresh
   *  race against a rotating-refresh server, it has already persisted the
   *  rotated pair. Re-read the store before surfacing re-auth, and retry
   *  once with the rotated token. */
  private async recover(refreshToken: string): Promise<McpAuth.Tokens | undefined> {
    try {
      return await this.refresh(refreshToken)
    } catch {
      const latest = (await this.boundEntry())?.tokens
      const valid = latest?.expiresAt === undefined || latest.expiresAt > Date.now() / 1000
      if (latest?.accessToken && valid) return latest
      if (latest?.refreshToken && latest.refreshToken !== refreshToken) {
        const retried = await this.refresh(latest.refreshToken).catch(() => undefined)
        if (retried) return retried
      }
      // OAuth error bodies are controlled by the provider and can echo token
      // material or other tenant secrets. Keep the operational signal while
      // deliberately omitting the provider-supplied exception text.
      log.warn("token refresh failed; re-authentication may be required", {
        mcpName: this.mcpName,
      })
      return undefined
    }
  }

  /** One refresh round-trip via the SDK helpers, persisted on success. */
  private async refresh(refreshToken: string): Promise<McpAuth.Tokens> {
    const guardedFetch = (url: string | URL, init?: RequestInit) => {
      McpRemoteUrl.discovered(url, this.serverUrl, "OAuth metadata or token URL")
      return CredentialLifecycle.dispatch(
        async () => {
          await this.authority?.verify()
          const current = (await this.boundEntry())?.tokens
          if (current?.refreshToken !== refreshToken) {
            throw new Error(`OAuth authority changed before refresh dispatch for MCP server: ${this.mcpName}`)
          }
        },
        () => McpRemoteUrl.fetchNoRedirect(url, init),
      )
    }
    const client = await this.clientInformation()
    if (!client) throw new Error(`no OAuth client information for MCP server: ${this.mcpName}`)
    const metadata = await discoverOAuthProtectedResourceMetadata(this.serverUrl, undefined, guardedFetch).catch(
      () => undefined,
    )
    const issuer = metadata?.authorization_servers?.[0] ?? new URL("/", this.serverUrl)
    const server = await discoverAuthorizationServerMetadata(issuer, { fetchFn: guardedFetch })
    const resource = await selectResourceURL(this.serverUrl, this, metadata)
    const tokens = await refreshAuthorization(issuer, {
      metadata: server,
      clientInformation: client,
      refreshToken,
      resource,
      fetchFn: guardedFetch,
    })
    const previous = (await this.boundEntry())?.tokens
    const saved: McpAuth.Tokens = {
      accessToken: tokens.access_token,
      // RFC-compliant refresh responses may omit a replacement token/scope;
      // retain the exact currently-authorized values in that case.
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
      scope: tokens.scope ?? previous?.scope,
    }
    const fingerprint = this.authority?.authorityFingerprint
    if (!fingerprint) throw new Error(`MCP OAuth authority binding is missing for: ${this.mcpName}`)
    const applied = await McpAuth.updateTokensIfRefreshToken(
      this.mcpName,
      refreshToken,
      saved,
      this.serverUrl,
      fingerprint,
    )
    if (!applied) {
      const winner = (await this.boundEntry())?.tokens
      if (!winner) throw new Error(`OAuth authority changed during refresh for MCP server: ${this.mcpName}`)
      return winner
    }
    log.info("refreshed oauth tokens", { mcpName: this.mcpName })
    return saved
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const next = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
      scope: tokens.scope,
    }
    const flowState = this.authority?.flowState
    const fingerprint = this.authority?.authorityFingerprint
    if (!fingerprint) throw new Error(`MCP OAuth authority binding is missing for: ${this.mcpName}`)
    await CredentialLifecycle.serialized(async () => {
      await this.authority?.verify()
      if (this.refreshCandidate) {
        const expected = this.refreshCandidate
        const applied = await McpAuth.updateTokensIfRefreshToken(
          this.mcpName,
          expected,
          { ...next, refreshToken: next.refreshToken ?? expected },
          this.serverUrl,
          fingerprint,
        )
        if (!applied) throw new Error(`OAuth authority changed before refresh persistence for: ${this.mcpName}`)
      } else if (flowState && fingerprint) {
        const applied = await McpAuth.updateTokensIfOAuthFlow(
          this.mcpName,
          flowState,
          this.serverUrl,
          fingerprint,
          next,
        )
        if (!applied) throw new Error(`OAuth authority changed before token persistence for: ${this.mcpName}`)
      } else {
        throw new Error(`Passive MCP OAuth cannot persist unbound tokens for: ${this.mcpName}`)
      }
    })
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if ((scope === "all" || scope === "client") && this.config.clientId) {
      throw new Error(
        `OAuth client ${this.config.clientId} was rejected for MCP server ${this.mcpName}; review the configured client credentials`,
      )
    }
    const state = this.authority?.flowState
    const fingerprint = this.authority?.authorityFingerprint
    if (!fingerprint) throw new Error(`MCP OAuth authority binding is missing for: ${this.mcpName}`)
    await CredentialLifecycle.serialized(async () => {
      await this.authority?.verify()
      if (scope === "tokens" && this.refreshCandidate) {
        const rejected = this.refreshCandidate
        const applied = await McpAuth.invalidateTokensIfRefreshToken(
          this.mcpName,
          this.serverUrl,
          fingerprint,
          rejected,
        )
        if (!applied) {
          const winner = await this.boundEntry()
          if (winner?.tokens && winner.tokens.refreshToken !== rejected) return
          throw new Error(`OAuth authority changed before token invalidation for: ${this.mcpName}`)
        }
        return
      }
      const applied =
        state && fingerprint
          ? await McpAuth.invalidateIfOAuthFlow(this.mcpName, state, this.serverUrl, fingerprint, scope)
          : await McpAuth.invalidateForAuthority(this.mcpName, this.serverUrl, fingerprint, scope)
      if (!applied) throw new Error(`OAuth authority changed before invalidation for: ${this.mcpName}`)
    })
    this.refreshCandidate = undefined
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.authority?.flowState || !this.authority.authorityFingerprint) {
      throw new Error(`Passive MCP OAuth cannot start browser authorization for: ${this.mcpName}`)
    }
    McpRemoteUrl.discovered(authorizationUrl, this.serverUrl, "OAuth authorization URL")
    this.refreshCandidate = undefined
    log.info("redirecting to authorization", { mcpName: this.mcpName, origin: authorizationUrl.origin })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = this.authority?.flowState
    const fingerprint = this.authority?.authorityFingerprint
    if (!state || !fingerprint) {
      throw new Error(`Passive MCP OAuth cannot persist a PKCE verifier for: ${this.mcpName}`)
    }
    await CredentialLifecycle.serialized(async () => {
      await this.authority?.verify()
      const applied = await McpAuth.updateCodeVerifierIfOAuthFlow(
        this.mcpName,
        state,
        this.serverUrl,
        fingerprint,
        codeVerifier,
      )
      if (!applied) throw new Error(`OAuth flow changed before PKCE verifier persistence for: ${this.mcpName}`)
    })
  }

  async codeVerifier(): Promise<string> {
    const state = this.authority?.flowState
    const fingerprint = this.authority?.authorityFingerprint
    if (!state || !fingerprint) {
      throw new Error(`Passive MCP OAuth cannot read browser-flow PKCE state for: ${this.mcpName}`)
    }
    const verifier = await McpAuth.codeVerifierForOAuthFlow(this.mcpName, state, this.serverUrl, fingerprint)
    if (!verifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return verifier
  }

  async saveState(state: string): Promise<void> {
    if (!this.authority?.authorityFingerprint || !this.authority.flowState) {
      throw new Error(`Passive MCP OAuth cannot create an authorization state for: ${this.mcpName}`)
    }
    await McpAuth.updateOAuthState(
      this.mcpName,
      state,
      this.authority?.authorityFingerprint
        ? {
            serverUrl: this.serverUrl,
            authorityFingerprint: this.authority.authorityFingerprint,
            allowDisabled: this.authority.allowDisabled === true,
          }
        : undefined,
    )
  }

  async state(): Promise<string> {
    if (!this.authority?.flowState) {
      throw new Error(`Passive MCP OAuth has no browser authorization state for: ${this.mcpName}`)
    }
    const entry = await McpAuth.get(this.mcpName)
    if (entry?.oauthState !== this.authority.flowState) {
      throw new Error(`No OAuth state saved for MCP server: ${this.mcpName}`)
    }
    return entry.oauthState
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
