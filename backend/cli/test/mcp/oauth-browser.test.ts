import { test, expect, mock, beforeEach } from "bun:test"
import { EventEmitter } from "events"

const auth = await import("@modelcontextprotocol/sdk/client/auth.js")

// Track open() calls and control failure behavior
let openShouldFail = false
let openCalledWith: string | undefined
let browserOpened = Promise.withResolvers<string>()
let finishAuthCalls = 0
let connectWithoutAuthorization = false
let authorizationDelay = 0

mock.module("open", () => ({
  default: async (url: string) => {
    openCalledWith = url
    browserOpened.resolve(url)
    // Return a mock subprocess that emits an error if openShouldFail is true
    const subprocess = new EventEmitter()
    if (openShouldFail) {
      // Emit error asynchronously like a real subprocess would
      setTimeout(() => {
        subprocess.emit("error", new Error("spawn xdg-open ENOENT"))
      }, 10)
    }
    return subprocess
  },
}))

// Mock UnauthorizedError
class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: { headers?: Record<string, string> } }
}> = []

type MockAuthProvider = {
  redirectToAuthorization?: (url: URL) => Promise<void>
  saveTokens?: (tokens: { access_token: string; token_type: string }) => Promise<void>
}

// Mock the transport constructors
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    url: string
    authProvider: MockAuthProvider | undefined
    constructor(
      url: URL,
      options?: {
        authProvider?: MockAuthProvider
        requestInit?: { headers?: Record<string, string> }
      },
    ) {
      this.url = url.toString()
      this.authProvider = options?.authProvider
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      const delay = authorizationDelay
      authorizationDelay = 0
      if (delay) await Bun.sleep(delay)
      if (connectWithoutAuthorization) return
      // Simulate OAuth redirect by calling the authProvider's redirectToAuthorization
      if (this.authProvider?.redirectToAuthorization) {
        await this.authProvider.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=test"))
      }
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {
      // Mock successful auth completion
      finishAuthCalls++
      if (connectWithoutAuthorization) {
        await this.authProvider?.saveTokens?.({ access_token: "browser-test-token", token_type: "Bearer" })
      }
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock the MCP SDK Client to trigger OAuth flow
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
    setNotificationHandler() {}
    async listTools() {
      return { tools: [] }
    }
    async close() {}
  },
}))

// Mock UnauthorizedError in the auth module
mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  ...auth,
  UnauthorizedError: MockUnauthorizedError,
}))

beforeEach(() => {
  openShouldFail = false
  openCalledWith = undefined
  browserOpened = Promise.withResolvers<string>()
  transportCalls.length = 0
  finishAuthCalls = 0
  connectWithoutAuthorization = false
  authorizationDelay = 0
})

// Import modules after mocking
const { MCP } = await import("../../src/mcp/index")
const { Bus } = await import("../../src/bus")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { Instance } = await import("../../src/project/instance")
const { ProjectTrust } = await import("../../src/project/trust")
const { tmpdir } = await import("../fixture/fixture")
const { Config } = await import("../../src/config/config")
const { McpAuth } = await import("../../src/mcp/auth")
const { Log } = await import("../../src/util/log")
const { withTimeout } = await import("../../src/util/timeout")

async function authorizeBrowser(name: string, authentication: Promise<unknown>) {
  // Observe the browser call rather than guessing when cold config, trust and
  // durable OAuth preparation have finished. Surface early auth failures too.
  const url = await withTimeout(
    Promise.race([
      browserOpened.promise,
      authentication.then(() => {
        throw new Error("Authentication settled without opening the browser")
      }),
    ]),
    10_000,
  )
  const pending = await McpAuth.pendingOAuthFlow(name)
  expect(pending?.authorizationUrl).toBe(url)
  expect(pending?.state).toBeDefined()
  connectWithoutAuthorization = true
  const callback = await fetch(
    `http://127.0.0.1:19876/mcp/oauth/callback?state=${encodeURIComponent(pending!.state)}&code=browser-test-code`,
    { keepalive: false, signal: AbortSignal.timeout(5_000) },
  )
  const page = await callback.text()
  expect(callback.status).toBe(200)
  expect(page).toContain("Authorization Successful")
  // Completing the flow also waits through the real browser error-detection
  // window. Stopping the listener immediately after open() would reject its
  // callback promise while that window is still running.
  expect(await authentication).toEqual({ status: "connected" })
  expect(finishAuthCalls).toBe(1)
  expect(await McpAuth.pendingOAuthFlow(name)).toBeUndefined()
  return url
}

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, {
    trusted: true,
    root: status.root,
  })
}

test("BrowserOpenFailed event is published when open() throws", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: {
            "test-oauth-server": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      openShouldFail = true

      const events: Array<{ mcpName: string; url: string }> = []
      const opened = Promise.withResolvers<void>()
      const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
        opened.resolve()
      })

      // Install the rejection handler before stop() rejects the callback waiter.
      // Deferring the catch until after stop creates a transient unhandled
      // rejection under a busy full-suite run even though the rejection is expected.
      const authPromise = MCP.authenticate("test-oauth-server").catch(() => undefined)

      // The callback waiter is registered before this event is published. Waiting
      // for the event avoids stopping the server while a cold auth flow is still
      // loading its config and has not installed that waiter yet.
      await opened.promise

      // Stop the callback server and cancel any pending auth
      await McpOAuthCallback.stop()

      await authPromise

      unsubscribe()

      // Verify the BrowserOpenFailed event was published
      expect(events.length).toBe(1)
      expect(events[0].mcpName).toBe("test-oauth-server")
      expect(events[0].url).toContain("https://")
    },
  })
})

test("BrowserOpenFailed event is NOT published when open() succeeds", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: {
            "test-oauth-server-2": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      openShouldFail = false
      // Model a cold preparation that exceeds the former 700 ms test sleep.
      // This is fixture latency, not the synchronization condition.
      authorizationDelay = 800

      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      const authPromise = MCP.authenticate("test-oauth-server-2")
      void authPromise.catch(() => undefined)
      try {
        await authorizeBrowser("test-oauth-server-2", authPromise)
        // A successful browser launch and callback must not emit a fallback URL.
        expect(events.length).toBe(0)
        expect(openCalledWith).toBeDefined()
      } finally {
        await McpOAuthCallback.stop()
        await authPromise.catch(() => undefined)
        unsubscribe()
      }
    },
  })
})

test("open() is called with the authorization URL", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: {
            "test-oauth-server-3": {
              type: "remote",
              url: "https://example.com/mcp",
              headers: { "X-Tenant": "tenant-123" },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      openShouldFail = false
      authorizationDelay = 800

      const authPromise = MCP.authenticate("test-oauth-server-3")
      void authPromise.catch(() => undefined)
      try {
        const url = await authorizeBrowser("test-oauth-server-3", authPromise)
        expect(url).toBe("https://auth.example.com/authorize?client_id=test")
        expect(typeof url).toBe("string")
        expect(transportCalls.find((call) => call.type === "streamable")?.options.requestInit?.headers).toEqual({
          "X-Tenant": "tenant-123",
        })
      } finally {
        await McpOAuthCallback.stop()
        await authPromise.catch(() => undefined)
      }
    },
  })
})

test("a restarted OAuth flow cannot exchange its code after connector authority changes", async () => {
  const name = "restart-authority-change"
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: { [name]: { type: "remote", url: "https://original.example/mcp" } },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      await MCP.startAuth(name)
      expect(await McpAuth.pendingOAuthFlow(name)).toMatchObject({ serverUrl: "https://original.example/mcp" })

      await Config.setMcp(name, { type: "remote", url: "https://replacement.example/mcp" }, "project")
      const error = await MCP.finishAuth(name, "old-authorization-code").then(
        () => undefined,
        (cause) => cause,
      )
      expect(String(error)).toContain("changed after OAuth")
      expect(finishAuthCalls).toBe(0)
      expect(await McpAuth.pendingOAuthFlow(name)).toBeUndefined()
    },
  })
})

test("a resumed exact flow restarts its callback listener without creating a replacement", async () => {
  const name = "restart-callback-listener"
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: { [name]: { type: "remote", url: "https://example.com/mcp" } },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const started = await MCP.startAuth(name)
      expect(started.state).toBe("pending")
      if (started.state !== "pending") throw new Error("Expected pending OAuth authorization")
      const pending = await McpAuth.pendingOAuthFlow(name)
      expect(pending?.authorizationUrl).toBe(started.authorizationUrl)
      await McpOAuthCallback.stop()

      const waiting = MCP.waitForAuth(name, started.flowId).catch(() => undefined)
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch("http://127.0.0.1:19876/mcp/oauth/callback/health").catch(() => undefined)
        if (response?.ok) break
        await Bun.sleep(10)
      }
      const callback = await fetch(
        `http://127.0.0.1:19876/mcp/oauth/callback?state=${encodeURIComponent(pending!.state)}&code=resumed-code`,
      )
      expect(callback.status).toBe(200)
      await waiting
      expect(finishAuthCalls).toBe(1)
    },
  })
})

test("a provider callback error followed by wait settles as a fixed failure without leaking provider text", async () => {
  const name = "provider-callback-failure"
  const errorMarker = `provider-error-${crypto.randomUUID()}`
  const descriptionMarker = `provider-description-${crypto.randomUUID()}`
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: { [name]: { type: "remote", url: "https://example.com/mcp" } },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const started = await MCP.startAuth(name)
      expect(started.state).toBe("pending")
      if (started.state !== "pending") throw new Error("Expected pending OAuth authorization")
      const pending = await McpAuth.pendingOAuthFlow(name)
      expect(pending).toBeDefined()

      await Log.flush()
      const before = await Bun.file(Log.file()).text()
      const callback = await fetch(
        `http://127.0.0.1:19876/mcp/oauth/callback?state=${encodeURIComponent(pending!.state)}` +
          `&error=${encodeURIComponent(errorMarker)}` +
          `&error_description=${encodeURIComponent(descriptionMarker)}`,
      )

      expect(callback.status).toBe(400)
      const callbackPage = await callback.text()
      expect(callbackPage).not.toContain(errorMarker)
      expect(callbackPage).not.toContain(descriptionMarker)
      expect((await McpAuth.pendingOAuthFlow(name))?.callback).toEqual({
        type: "error",
        value: "OAuth authorization did not complete. Review access with the provider, then try Connect again.",
      })
      expect(await MCP.waitForAuth(name, started.flowId)).toEqual({
        status: "failed",
        error: "OAuth authorization did not complete. Review access with the provider, then try Connect again.",
      })
      expect(await McpAuth.pendingOAuthFlow(name)).toBeUndefined()

      await Log.flush()
      const appended = (await Bun.file(Log.file()).text()).slice(before.length)
      expect(appended).not.toContain(errorMarker)
      expect(appended).not.toContain(descriptionMarker)
    },
  })
})

test("waiting on a settled flow ID never creates a replacement operation", async () => {
  const name = "stale-wait"
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: { [name]: { type: "remote", url: "https://example.com/mcp" } },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const started = await MCP.startAuth(name)
      expect(started.state).toBe("pending")
      if (started.state !== "pending") throw new Error("Expected pending OAuth authorization")
      await MCP.cancelAuth(name, started.flowId)

      await expect(MCP.waitForAuth(name, started.flowId)).rejects.toThrow(/No matching pending|changed before waiting/)
      expect(await MCP.pendingAuth(name)).toBeUndefined()
      expect(await McpAuth.pendingOAuthFlow(name)).toBeUndefined()
    },
  })
})

test("an already-authorized start returns a settled result and leaves no dead browser flow", async () => {
  const name = "already-authorized-start"
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/openscience.json`,
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          mcp: { [name]: { type: "remote", url: "https://example.com/mcp" } },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      connectWithoutAuthorization = true

      const started = await MCP.startAuth(name)

      expect(started).toEqual({ state: "settled", result: { status: "connected" } })
      expect(await MCP.pendingAuth(name)).toBeUndefined()
      expect(await McpAuth.pendingOAuthFlow(name)).toBeUndefined()
      expect((await MCP.status())[name]).toEqual({ status: "connected" })
    },
  })
})
