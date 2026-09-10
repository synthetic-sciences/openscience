import { expect, test } from "bun:test"
import type { Socket } from "bun"
import { fetchWithFreshConnection } from "../../src/util/fetch"
import { Provider } from "../../src/provider/provider"

test("inference does not reuse an unresponsive pooled socket or resend its body", async () => {
  type State = { requests: number; buffer: string }
  const sockets = new Set<Socket<State>>()
  const requests: string[] = []
  const server = Bun.listen<State>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { requests: 0, buffer: "" }
        sockets.add(socket)
      },
      data(socket, data) {
        socket.data.buffer += data.toString()
        const end = socket.data.buffer.indexOf("\r\n\r\n")
        if (end < 0) return
        const length = Number(/content-length: (\d+)/i.exec(socket.data.buffer)?.[1] ?? 0)
        if (socket.data.buffer.length < end + 4 + length) return
        requests.push(socket.data.buffer)
        socket.data.buffer = ""
        // A middlebox silently forgets the established connection. Its next
        // request receives neither a response nor a TCP close/reset.
        if (++socket.data.requests > 1) return
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok")
      },
      close(socket) {
        sockets.delete(socket)
      },
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  try {
    expect(await (await fetch(url)).text()).toBe("ok")
    await Bun.sleep(10)
    const headers = new Headers({ authorization: "test-only", "Idempotency-Key": "logical-request" })
    for (const body of ["first", "second"]) {
      const response = await Provider.fetchWithIdleWatchdog(
        fetchWithFreshConnection,
        url,
        {
          method: "POST",
          headers,
          body,
        },
        { providerID: "fixture", modelID: "fixture", connectTimeout: 500, idleTimeout: 500 },
      )
      expect(await response.text()).toBe("ok")
      await Bun.sleep(10)
    }
    expect(headers.has("connection")).toBe(false)
    expect(requests).toHaveLength(3)
    for (const [index, body] of ["first", "second"].entries()) {
      expect(requests[index + 1]).toContain("Connection: close")
      expect(requests[index + 1]).toContain("Idempotency-Key: logical-request")
      expect(requests[index + 1]).toEndWith(body)
    }
  } finally {
    for (const socket of sockets) socket.end()
    server.stop(true)
  }
})

test("fresh streaming connections keep activity, Request headers and cancellation intact", async () => {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      calls++
      expect(request.headers.get("x-test")).toBe("preserved")
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (let i = 0; i < 5; i++) {
              controller.enqueue(new TextEncoder().encode(": keepalive\n\n"))
              await Bun.sleep(15)
            }
            controller.close()
          },
        }),
      )
    },
  })
  try {
    const input = new Request(server.url, { headers: { "x-test": "preserved" } })
    const signal = new AbortController()
    const response = await Provider.fetchWithIdleWatchdog(
      fetchWithFreshConnection,
      input,
      { signal: signal.signal },
      {
        providerID: "fixture",
        modelID: "fixture",
        connectTimeout: 500,
        idleTimeout: 50,
      },
    )
    expect((await response.text()).match(/keepalive/g)).toHaveLength(5)
    signal.abort()
    await expect(fetchWithFreshConnection(input, { signal: signal.signal })).rejects.toThrow()
    expect(calls).toBe(1)
    expect(input.headers.has("connection")).toBe(false)
  } finally {
    server.stop(true)
  }
})
