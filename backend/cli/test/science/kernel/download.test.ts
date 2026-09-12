import { describe, expect, test } from "bun:test"
import net from "node:net"
import { download } from "../../../src/science/kernel/download"

describe("managed environment downloads", () => {
  test("recovers from a temporary upstream failure", async () => {
    let requests = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return requests === 1 ? new Response("unavailable", { status: 503 }) : new Response("locked archive")
      },
    })
    expect(new TextDecoder().decode(await download(server.url.href, 5_000))).toBe("locked archive")
    expect(requests).toBe(2)
  })

  test("restarts a truncated response without returning partial archive bytes", async () => {
    let requests = 0
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        requests++
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\n" +
            (requests === 1 ? "cut" : "locked archive"),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing fixture address")
      expect(new TextDecoder().decode(await download(`http://127.0.0.1:${address.port}/archive`, 5_000))).toBe(
        "locked archive",
      )
      expect(requests).toBe(2)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("does not retry permanent HTTP failures", async () => {
    let requests = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("missing", { status: 404 })
      },
    })
    await expect(download(server.url.href, 5_000)).rejects.toThrow("HTTP 404")
    expect(requests).toBe(1)
  })

  test("bounds attempts and identifies the failed archive without its query", async () => {
    let requests = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("unavailable", { status: 502 })
      },
    })
    const error = await download(new URL("/archive?token=fixture-secret", server.url).href, 5_000).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("/archive")
    expect((error as Error).message).toContain("3 attempts")
    expect((error as Error).message).toContain("HTTP 502")
    expect((error as Error).message).not.toContain("fixture-secret")
    expect(requests).toBe(3)
  })

  test("keeps retries inside the original timeout budget", async () => {
    let requests = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("busy", { status: 503 })
      },
    })
    const started = performance.now()
    await expect(download(server.url.href, 100)).rejects.toThrow("HTTP 503")
    expect(performance.now() - started).toBeLessThan(500)
    expect(requests).toBe(1)
  })

  test("does not retry earlier than the upstream Retry-After deadline", async () => {
    let requests = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } })
      },
    })
    await expect(download(server.url.href, 1_000)).rejects.toThrow("HTTP 429")
    expect(requests).toBe(1)
  })
})
