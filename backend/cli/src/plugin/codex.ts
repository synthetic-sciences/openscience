import type { Hooks, PluginInput } from "@synsci/plugin"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { Auth, OAUTH_DUMMY_KEY } from "../auth"
import { OpenScience } from "../openscience"
import { managedApiBase } from "../endpoints"
import os from "os"

const log = Log.create({ service: "plugin.codex" })

export async function pushTokensToBackend(
  thesisBaseUrl: string,
  thkToken: string,
  payload: {
    access_token: string
    refresh_token: string
    expires_in: number
    account_id?: string
    id_token_claims?: Record<string, unknown>
  },
): Promise<void> {
  try {
    const res = await fetch(`${thesisBaseUrl}/api/keys/openai-codex`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${thkToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      log.warn("codex backend push failed", { status: res.status })
      return
    }
    log.info("codex tokens pushed to thesis backend")
  } catch (e) {
    log.warn("codex backend push errored", { error: String(e) })
  }
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "synsci",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenScience - Codex Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenScience.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenScience - Codex Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

// Single-flight refresh: two concurrent AI-SDK calls arriving after
// access-token expiry must share one /oauth/token round-trip. OpenAI
// rotates refresh_token on every refresh, so racing requests would
// otherwise persist a stale refresh value.
let refreshInflight: Promise<TokenResponse> | undefined

async function refreshAccessTokenSingleFlight(refreshToken: string): Promise<TokenResponse> {
  if (refreshInflight) return refreshInflight
  refreshInflight = refreshAccessToken(refreshToken).finally(() => {
    refreshInflight = undefined
  })
  return refreshInflight
}

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          const errorMsg = "Missing authorization code"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  log.info("codex oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
    log.info("codex oauth server stopped")
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function CodexAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai-codex",
      async loader(getAuth, _provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Provider models + cost-zeroing are handled at database
        // synthesis time in provider/provider.ts. By the time the
        // loader runs, database["openai-codex"] already has the
        // 5 Codex-routable models with zero cost.

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Cast to include accountId field
            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            // Check if token needs refresh
            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              log.info("refreshing codex access token")
              let tokens: TokenResponse | undefined
              try {
                tokens = await refreshAccessTokenSingleFlight(currentAuth.refresh)
              } catch (e) {
                // ChatGPT rotates the refresh token on every refresh, and the
                // single-flight guard only covers this process. When two
                // openscience processes (CLI + workspace server) race a
                // refresh — common while requests are being retried against an
                // exhausted usage limit — the loser is left holding a revoked
                // token and every later refresh fails, even after the limit
                // resets. The winner has already persisted the rotated pair,
                // so re-read auth before giving up.
                const latest = (await getAuth()) as typeof currentAuth & { accountId?: string }
                if (latest.type === "oauth" && latest.access && latest.expires > Date.now()) {
                  currentAuth.access = latest.access
                  authWithAccount.accountId = latest.accountId ?? authWithAccount.accountId
                } else {
                  if (latest.type === "oauth" && latest.refresh && latest.refresh !== currentAuth.refresh) {
                    tokens = await refreshAccessTokenSingleFlight(latest.refresh).catch(() => undefined)
                  }
                  if (!tokens) {
                    log.warn("codex token refresh failed", { error: String(e) })
                    throw new Error(
                      "Codex sign-in expired. Reconnect it with `openscience auth login` and choose Codex — Sign in with ChatGPT.",
                    )
                  }
                }
              }
              if (tokens) {
                const newAccountId = extractAccountId(tokens) || authWithAccount.accountId
                await input.client.auth.set({
                  path: { id: "openai-codex" },
                  body: {
                    type: "oauth",
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    ...(newAccountId && { accountId: newAccountId }),
                  },
                })
                currentAuth.access = tokens.access_token
                authWithAccount.accountId = newAccountId
              }
            }

            // Build headers
            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            // Set authorization header with access token
            headers.set("authorization", `Bearer ${currentAuth.access}`)

            // Set ChatGPT-Account-Id header for organization subscriptions
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            // Rewrite URL to Codex endpoint
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const isCodexRoute =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
            const url = isCodexRoute ? new URL(CODEX_API_ENDPOINT) : parsed

            // The chatgpt.com Codex endpoint accepts a strict subset of the
            // standard OpenAI Responses API: it requires `instructions` and
            // `store: false`, and rejects params like `max_output_tokens`.
            // Normalize the AI-SDK payload before forwarding.
            let bodyForRequest = init?.body
            if (isCodexRoute && typeof bodyForRequest === "string") {
              try {
                const parsedBody = JSON.parse(bodyForRequest)
                let mutated = false
                if (parsedBody.instructions === undefined) {
                  parsedBody.instructions = ""
                  mutated = true
                }
                if (parsedBody.store === undefined) {
                  parsedBody.store = false
                  mutated = true
                }
                // chatgpt.com Codex endpoint rejects these as unsupported.
                for (const k of ["max_output_tokens", "max_tokens", "temperature", "top_p"]) {
                  if (k in parsedBody) {
                    delete parsedBody[k]
                    mutated = true
                  }
                }
                if (mutated) bodyForRequest = JSON.stringify(parsedBody)
              } catch {
                // body wasn't JSON — leave it alone
              }
            }

            const response = await fetch(url, {
              ...init,
              headers,
              body: bodyForRequest,
            })

            // Fallback to shared key if OAuth quota exceeded
            if (response.status === 429 || response.status === 403) {
              const body = await response.clone().text().catch(() => "")
              const isQuotaExceeded =
                body.includes("quota") ||
                body.includes("rate_limit") ||
                body.includes("usage_limit") ||
                body.includes("capacity")
              if (isQuotaExceeded) {
                const sharedKey = process.env.OPENAI_API_KEY
                if (
                  sharedKey &&
                  sharedKey !== OAUTH_DUMMY_KEY &&
                  !sharedKey.startsWith("thk_")
                ) {
                  log.warn("codex oauth quota exceeded, falling back to shared key")
                  headers.set("authorization", `Bearer ${sharedKey}`)
                  headers.delete("ChatGPT-Account-Id")
                  // Route to standard OpenAI API instead of Codex endpoint
                  const fallbackUrl = new URL("https://api.openai.com/v1/responses")
                  return fetch(fallbackUrl, { ...init, headers })
                }
              }
            }

            return response
          },
        }
      },
      methods: [
        {
          label: "Codex — Sign in with ChatGPT (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            // Fetch the Atlas session once at authorize time so the callback
            // closure can reuse it without a second async call.
            const session = await OpenScience.getSession?.()
            const thkToken = session?.api_key

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)

                // Fire-and-forget: push tokens to thesis backend so the
                // dashboard + managed-mode proxy can use them. Local login
                // succeeds regardless of whether this call succeeds.
                const thesisBase = managedApiBase()
                if (thkToken) {
                  await pushTokensToBackend(thesisBase, thkToken, {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    expires_in: tokens.expires_in ?? 3600,
                    account_id: accountId,
                    id_token_claims: tokens.id_token ? parseJwtClaims(tokens.id_token) as Record<string, unknown> | undefined : undefined,
                  })
                  // Re-sync after backend now knows about the new codex
                  // credential, so `openai-codex` shows up in the local
                  // provider list without a separate `openscience connect sync`.
                  await OpenScience.syncServices?.().catch((e: unknown) => {
                    log.warn("post-codex-login sync failed", { error: String(e) })
                  })
                }

                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                }
              },
            }
          },
        },
        {
          label: "Codex — Sign in with ChatGPT (device code)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `openscience/${Installation.VERSION}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            // Fetch the Atlas session once at authorize time so the polling
            // callback closure can reuse it without a repeated async call.
            const session = await OpenScience.getSession?.()
            const thkToken = session?.api_key

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `openscience/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()
                    const accountId = extractAccountId(tokens)

                    // Fire-and-forget: push tokens to thesis backend.
                    const thesisBase = managedApiBase()
                    if (thkToken) {
                      await pushTokensToBackend(thesisBase, thkToken, {
                        access_token: tokens.access_token,
                        refresh_token: tokens.refresh_token,
                        expires_in: tokens.expires_in ?? 3600,
                        account_id: accountId,
                        id_token_claims: tokens.id_token ? parseJwtClaims(tokens.id_token) as Record<string, unknown> | undefined : undefined,
                      })
                      await OpenScience.syncServices?.().catch((e: unknown) => {
                        log.warn("post-codex-login sync failed", { error: String(e) })
                      })
                    }

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId,
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await Bun.sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        // No API-key method on this slot: the openai-codex provider only
        // accepts ChatGPT OAuth. BYOK belongs on the separate ``openai``
        // provider slot.
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai-codex") return
      output.headers.originator = "synsci"
      output.headers["User-Agent"] = `openscience/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
  }
}
