import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"

const context = { sessionID: "ses_connect", messageID: "msg_connect", attempt: 0 }

function attempt(url: string, timings: Provider.RequestTiming[] = []) {
  return Provider.withRequestContext(context, () =>
    Provider.fetchWithIdleWatchdog(
      fetch,
      url,
      { method: "POST", body: "{}" },
      {
        providerID: "local-fixture",
        modelID: "fixture",
        connectTimeout: 5_000,
        idleTimeout: false,
        onTiming: (timing) => {
          timings.push(timing)
        },
      },
    ),
  ).catch((error: unknown) => error)
}

describe("connection-phase transport failures", () => {
  test("a refused connection is a connect-phase transport failure, not an unknown error", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
    const port = probe.port
    probe.stop(true)
    const timings: Provider.RequestTiming[] = []
    const error = await attempt(`http://127.0.0.1:${port}/v1/chat/completions`, timings)
    expect(error).toBeInstanceOf(Provider.TransportError)
    expect(error).toMatchObject({ phase: "connect", code: "ConnectionRefused" })
    expect(Provider.isRequestTimeoutError(error)).toBe(false)
    expect(Provider.transportCode((error as Error).cause)).toBe("ConnectionRefused")
    expect(timings).toMatchObject([{ outcome: "error", connectTimeoutMs: 5_000 }])
  })

  test("a socket closed before any header is a connect-phase transport failure", async () => {
    using peer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.end()
        },
        open() {},
        close() {},
        error() {},
      },
    })
    const error = await attempt(`http://127.0.0.1:${peer.port}/v1/chat/completions`)
    expect(error).toBeInstanceOf(Provider.TransportError)
    expect(error).toMatchObject({ phase: "connect", code: "ECONNRESET" })
  })

  test("a body that breaks after headers keeps its own identity", async () => {
    const partial = "data: {}\n\n"
    using peer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            [
              "HTTP/1.1 200 OK",
              "Content-Type: text/event-stream",
              `Content-Length: ${partial.length + 512}`,
              "Connection: close",
              "",
              partial,
            ].join("\r\n"),
          )
          // The client must have parsed the headers before the body breaks;
          // closing in the same packet fails the fetch itself.
          setTimeout(() => socket.end(), 100)
        },
        open() {},
        close() {},
        error() {},
      },
    })
    const response = await attempt(`http://127.0.0.1:${peer.port}/v1/chat/completions`)
    expect(response).toBeInstanceOf(Response)
    const failure = await (response as Response).text().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(Provider.TransportError)
  })

  test("aborts and deadlines are never reclassified as transport failures", async () => {
    const controller = new AbortController()
    const pending = Provider.withRequestContext(context, () =>
      Provider.fetchWithIdleWatchdog(
        () => new Promise<Response>(() => {}),
        "https://provider.test/v1",
        { signal: controller.signal },
        { providerID: "test", modelID: "test", connectTimeout: 5_000, idleTimeout: false },
      ),
    ).catch((error: unknown) => error)
    controller.abort(new Error("socket connection was closed"))
    const error = await pending
    expect(error).not.toBeInstanceOf(Provider.TransportError)
    expect(error).toMatchObject({ message: "socket connection was closed" })
  })

  test("recognizes Bun, Node and undici transport codes and messages", () => {
    expect(Provider.transportCode(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED")
    expect(Provider.transportCode(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe("ENOTFOUND")
    expect(Provider.transportCode(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }))).toBe("EAI_AGAIN")
    expect(Provider.transportCode(Object.assign(new Error("tcp"), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT")
    expect(Provider.transportCode(new TypeError("fetch failed"))).toBe("transport")
    expect(Provider.transportCode(new Error("terminated"))).toBe("transport")
    expect(Provider.transportCode(new Error("The socket connection was closed unexpectedly"))).toBe("transport")
    expect(
      Provider.transportCode(
        new Error("Cannot connect", { cause: Object.assign(new Error("refused"), { code: "ConnectionRefused" }) }),
      ),
    ).toBe("ConnectionRefused")
    expect(Provider.transportCode(new Error("Invalid JSON response"))).toBeUndefined()
    expect(
      Provider.transportCode(Object.assign(new Error("policy"), { code: "invalid_request_error" })),
    ).toBeUndefined()
  })
})

describe("connect deadline defaults", () => {
  test("waits five minutes for headers on hosted providers", () => {
    expect(Provider.DEFAULT_CONNECT_TIMEOUT_MS).toBe(300_000)
    expect(Provider.defaultConnectTimeout({ providerID: "anthropic" })).toBe(300_000)
    expect(Provider.defaultConnectTimeout({ providerID: "openai", baseURL: "https://api.openai.com/v1" })).toBe(300_000)
    expect(Provider.defaultConnectTimeout({ providerID: "synsci" })).toBe(300_000)
  })

  test.each([
    ["ollama", undefined],
    ["lmstudio", undefined],
    ["llamacpp", undefined],
    ["vllm", undefined],
    ["jan", undefined],
    ["custom", "http://127.0.0.1:8080/v1"],
    ["custom", "http://localhost:11434/v1"],
    ["custom", "http://[::1]:8000/v1"],
    ["custom", "http://0.0.0.0:8000/v1"],
    ["custom", "http://gpu-box.local:8000/v1"],
    ["custom", "https://Workstation.LOCAL/v1"],
  ])("disables the header deadline for the local endpoint %s %s", (providerID, baseURL) => {
    expect(Provider.localEndpoint({ providerID, baseURL })).toBe(true)
    expect(Provider.defaultConnectTimeout({ providerID, baseURL })).toBe(false)
  })

  test.each([
    ["custom", "https://api.example.com/v1"],
    ["custom", "http://192.168.1.20:8000/v1"],
    ["custom", "not a url"],
    ["custom", ""],
    ["custom", 42],
  ])("keeps the deadline for the remote endpoint %s %s", (providerID, baseURL) => {
    expect(Provider.localEndpoint({ providerID, baseURL })).toBe(false)
    expect(Provider.defaultConnectTimeout({ providerID, baseURL })).toBe(300_000)
  })
})
