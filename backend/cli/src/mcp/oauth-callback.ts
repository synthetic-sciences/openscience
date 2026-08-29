import { Log } from "../util/log"
import { escapeHtml, htmlResponse } from "../util/html"
import { Global } from "../global"
import { McpAuth } from "./auth"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import crypto from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"

const log = Log.create({ service: "mcp.oauth-callback" })

export const OAUTH_AUTHORIZATION_FAILED_MESSAGE =
  "OAuth authorization did not complete. Review access with the provider, then try Connect again."

export class OAuthAuthorizationFailedError extends Error {
  constructor() {
    super(OAUTH_AUTHORIZATION_FAILED_MESSAGE)
    this.name = "OAuthAuthorizationFailedError"
  }
}

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>OpenScience - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to OpenScience.</p>
  </div>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>OpenScience - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`

interface PendingAuth {
  mcpName: string
  state: string
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  poll: ReturnType<typeof setInterval>
  checking: boolean
}

export namespace McpOAuthCallback {
  let server: ReturnType<typeof Bun.serve> | undefined
  const pendingAuths = new Map<string, PendingAuth>()

  const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
  const rootIdentity = fs
    .realpath(Global.Path.data)
    .catch(() => path.resolve(Global.Path.data))
    .then((physicalRoot) => crypto.createHash("sha256").update(physicalRoot).digest("hex"))

  export async function ensureRunning(): Promise<void> {
    if (server) return
    const expectedRoot = await rootIdentity

    const owner = await callbackServerOwner(expectedRoot)
    if (owner === "same") {
      log.info("oauth callback server already running on another instance", { port: OAUTH_CALLBACK_PORT })
      return
    }
    if (owner === "different") {
      throw new Error(
        `OAuth callback port ${OAUTH_CALLBACK_PORT} belongs to another OpenScience data profile; close that profile or finish its authentication first`,
      )
    }
    if (await isPortInUse()) throw new Error(`OAuth callback port ${OAUTH_CALLBACK_PORT} is owned by another service`)

    try {
      server = Bun.serve({
        port: OAUTH_CALLBACK_PORT,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url)

          if (url.pathname === `${OAUTH_CALLBACK_PATH}/health`) {
            return Response.json({ service: "openscience-mcp-oauth-callback", version: 1, root: expectedRoot })
          }

          if (url.pathname !== OAUTH_CALLBACK_PATH) {
            return new Response("Not found", { status: 404 })
          }

          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
          const hasError = url.searchParams.has("error")

          // Query values come from the OAuth provider. Record only presence:
          // error/error_description may contain provider-controlled secrets.
          log.info("received oauth callback", { hasCode: !!code, hasState: !!state, hasError })

          // Enforce state parameter presence
          if (!state) {
            const errorMsg = "Missing required state parameter - potential CSRF attack"
            log.error("oauth callback missing state parameter")
            return htmlResponse(HTML_ERROR(errorMsg), {
              status: 400,
            })
          }

          const owner = await McpAuth.findByOAuthState(state)
          if (!owner) {
            const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
            log.error("oauth callback with invalid state")
            return htmlResponse(HTML_ERROR(errorMsg), {
              status: 400,
            })
          }

          const callback: McpAuth.OAuthCallback = hasError
            ? { type: "error", value: OAUTH_AUTHORIZATION_FAILED_MESSAGE }
            : code
              ? { type: "code", value: code }
              : { type: "error", value: OAUTH_AUTHORIZATION_FAILED_MESSAGE }
          try {
            await McpAuth.recordOAuthCallback(state, callback)
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
            return htmlResponse(HTML_ERROR(message), { status: 400 })
          }
          settleLocal(state, callback)

          return callback.type === "code"
            ? htmlResponse(HTML_SUCCESS)
            : htmlResponse(HTML_ERROR(callback.type === "error" ? callback.value : "Authorization cancelled"), {
                status: 400,
              })
        },
      })
    } catch (error) {
      // Two compatible processes can both observe the port as free. If the
      // winner belongs to this exact physical data root, share it; never turn
      // that harmless bind race into a failed OAuth flow.
      for (let attempt = 0; attempt < 20; attempt++) {
        const raced = await callbackServerOwner(expectedRoot)
        if (raced === "same") return
        if (raced === "different") {
          throw new Error(
            `OAuth callback port ${OAUTH_CALLBACK_PORT} belongs to another OpenScience data profile; close that profile or finish its authentication first`,
          )
        }
        await Bun.sleep(10)
      }
      throw error
    }

    log.info("oauth callback server started", { port: OAUTH_CALLBACK_PORT })
  }

  function finish(state: string, pending: PendingAuth) {
    clearTimeout(pending.timeout)
    clearInterval(pending.poll)
    if (pendingAuths.get(state) === pending) pendingAuths.delete(state)
  }

  function settleLocal(state: string, callback: McpAuth.OAuthCallback) {
    const pending = pendingAuths.get(state)
    if (!pending) return
    finish(state, pending)
    if (callback.type === "code") pending.resolve(callback.value)
    else if (callback.type === "error") pending.reject(new OAuthAuthorizationFailedError())
    else pending.reject(new Error("Authorization cancelled"))
  }

  export function waitForCallback(mcpName: string, oauthState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingAuths.get(oauthState)
        if (pending) {
          finish(oauthState, pending)
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      }, CALLBACK_TIMEOUT_MS)
      const pending: PendingAuth = {
        mcpName,
        state: oauthState,
        resolve,
        reject,
        timeout,
        poll: undefined as unknown as ReturnType<typeof setInterval>,
        checking: false,
      }
      pending.poll = setInterval(() => {
        if (pending.checking) return
        pending.checking = true
        void McpAuth.callback(mcpName, oauthState)
          .then((callback) => {
            if (callback) settleLocal(oauthState, callback)
          })
          .catch((error) => {
            const current = pendingAuths.get(oauthState)
            if (!current) return
            finish(oauthState, current)
            reject(error instanceof Error ? error : new Error(String(error)))
          })
          .finally(() => {
            pending.checking = false
          })
      }, 50)
      pending.poll.unref()
      pendingAuths.set(oauthState, pending)
      void McpAuth.callback(mcpName, oauthState)
        .then((callback) => {
          if (callback) settleLocal(oauthState, callback)
        })
        .catch((error) => {
          const current = pendingAuths.get(oauthState)
          if (!current) return
          finish(oauthState, current)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  export async function cancelPending(mcpName: string, expectedState: string): Promise<boolean> {
    const cancelled = await McpAuth.cancelOAuthFlow(mcpName, expectedState)
    if (!cancelled) return false
    for (const [state, pending] of pendingAuths) {
      if (pending.mcpName !== mcpName || state !== expectedState) continue
      finish(state, pending)
      pending.reject(new Error("Authorization cancelled"))
    }
    return true
  }

  async function callbackServerOwner(expectedRoot: string): Promise<"same" | "different" | "none"> {
    const response = await fetch(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}/health`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined)
    if (!response?.ok) return "none"
    const body = (await response.json().catch(() => undefined)) as
      | { service?: unknown; version?: unknown; root?: unknown }
      | undefined
    if (body?.service !== "openscience-mcp-oauth-callback" || body.version !== 1) return "none"
    return body.root === expectedRoot ? "same" : "different"
  }

  export async function isPortInUse(): Promise<boolean> {
    return new Promise((resolve) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: OAUTH_CALLBACK_PORT,
        socket: {
          open(socket) {
            socket.end()
            resolve(true)
          },
          error() {
            resolve(false)
          },
          data() {},
          close() {},
        },
      }).catch(() => {
        resolve(false)
      })
    })
  }

  export async function stop(): Promise<void> {
    if (server) {
      server.stop()
      server = undefined
      log.info("oauth callback server stopped")
    }

    for (const [, pending] of pendingAuths) {
      finish(pending.state, pending)
      pending.reject(new Error("OAuth callback server stopped"))
    }
    pendingAuths.clear()
  }

  export function isRunning(): boolean {
    return server !== undefined
  }
}
