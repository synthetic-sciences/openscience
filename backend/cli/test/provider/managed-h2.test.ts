import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import * as FetchUtil from "../../src/util/fetch"
import { ManagedH2 } from "../../src/provider/managed-h2"

// A local h2c "gateway" behind a TCP proxy that can silently drop traffic in
// both directions: the half-open connection (#584) the transport must detect.
type Seen = { path: string; key?: string; body: string }
const seen: Seen[] = []
const sessionsOpened: number[] = []
let behaviour: "normal" | "slow-headers" | "die-mid-stream" | "hang-mid-stream" = "normal"

const server = http2.createServer({ settings: { initialWindowSize: 1 << 20 } })
server.on("session", () => sessionsOpened.push(Date.now()))
server.on("stream", (stream, headers) => {
  let body = ""
  stream.on("data", (chunk) => (body += chunk))
  stream.on("end", async () => {
    seen.push({ path: String(headers[":path"]), key: headers["idempotency-key"] as string | undefined, body })
    if (headers[":path"] === "/api/health") {
      stream.respond({ ":status": 200 })
      return stream.end("ok")
    }
    if (behaviour === "slow-headers") await Bun.sleep(5_000)
    if (stream.destroyed) return
    stream.respond({ ":status": 200, "content-type": "text/event-stream" })
    stream.write("data: one\n\n")
    // The connection drops under the reply (no GOAWAY, no end of stream).
    if (behaviour === "die-mid-stream") return setTimeout(drop, 20)
    if (behaviour === "hang-mid-stream") return
    stream.write("data: two\n\n")
    stream.end("data: [DONE]\n\n")
  })
})

// Connections open at the moment of `silence()` go half-open for good: their
// bytes vanish in both directions, as on a dropped NAT mapping. Connections
// opened afterwards work normally. `drop()` closes open connections abruptly.
type Pair = { client: net.Socket; upstream: net.Socket; silent: boolean }
const pairs = new Set<Pair>()
const silence = () => {
  for (const pair of pairs) pair.silent = true
}
const drop = () => {
  for (const pair of pairs) {
    pair.client.destroy()
    pair.upstream.destroy()
  }
}
const proxy = net.createServer((client) => {
  const upstream = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1")
  const pair: Pair = { client, upstream, silent: false }
  pairs.add(pair)
  client.on("data", (chunk) => {
    if (!pair.silent) upstream.write(chunk)
  })
  upstream.on("data", (chunk) => {
    if (!pair.silent) client.write(chunk)
  })
  const close = () => {
    pairs.delete(pair)
    client.destroy()
    upstream.destroy()
  }
  client.on("error", close).on("close", close)
  upstream.on("error", close).on("close", close)
})

let origin = ""
let restoreTimings: () => void = () => {}
const previousFlag = process.env["OPENSCIENCE_MANAGED_H2"]

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()))
  origin = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
})

afterAll(async () => {
  drop()
  proxy.close()
  server.close()
})

beforeEach(async () => {
  process.env["OPENSCIENCE_MANAGED_H2"] = "1"
  restoreTimings = ManagedH2.configure({ pingIntervalMs: 200, pingTimeoutMs: 300, connectTimeoutMs: 1_000 })
  await ManagedH2.reset()
  seen.length = 0
  sessionsOpened.length = 0
  behaviour = "normal"
})

afterEach(async () => {
  drop()
  await ManagedH2.reset()
  restoreTimings()
  if (previousFlag === undefined) delete process.env["OPENSCIENCE_MANAGED_H2"]
  else process.env["OPENSCIENCE_MANAGED_H2"] = previousFlag
})

const post = (key?: string, signal?: AbortSignal) =>
  ManagedH2.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "fixture" }),
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    signal,
  })

test("consecutive managed calls share one HTTP/2 connection", async () => {
  for (const key of ["a", "b", "c"]) {
    const response = await post(key)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("[DONE]")
  }
  expect(sessionsOpened).toHaveLength(1)
  expect(ManagedH2.stats).toMatchObject({ connects: 1, reused: 2, retries: 0 })
  expect(seen.map((item) => item.key)).toEqual(["a", "b", "c"])
})

test("with the switch off, calls use the fresh connection exactly as before", async () => {
  delete process.env["OPENSCIENCE_MANAGED_H2"]
  const fresh = spyOn(FetchUtil, "fetchWithFreshConnection").mockResolvedValue(new Response("fresh"))
  try {
    expect(await (await post("k")).text()).toBe("fresh")
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(sessionsOpened).toHaveLength(0)
  } finally {
    fresh.mockRestore()
  }
})

test("a configured proxy turns reuse off", () => {
  expect(ManagedH2.enabled({ OPENSCIENCE_MANAGED_H2: "1" })).toBe(true)
  expect(ManagedH2.enabled({ OPENSCIENCE_MANAGED_H2: "1", HTTPS_PROXY: "http://proxy:3128" })).toBe(false)
  expect(ManagedH2.enabled({})).toBe(false)
})

test("a connection that went silent while idle is detected and the call is sent once on a new one", async () => {
  expect((await post("warm")).status).toBe(200)
  silence()
  const response = await post("after-silence")
  expect(await response.text()).toContain("[DONE]")
  expect(ManagedH2.stats.deadDetected).toBeGreaterThanOrEqual(1)
  expect(ManagedH2.stats.retries).toBe(1)
  // The black-holed attempt never reached the gateway: it saw the call once.
  expect(seen.filter((item) => item.key === "after-silence")).toHaveLength(1)
})

test("a connection that dies while waiting for headers is caught by the in-flight ping and resent with the same key", async () => {
  expect((await post("warm")).status).toBe(200)
  behaviour = "slow-headers"
  const sending = post("long-wait")
  await Bun.sleep(50)
  behaviour = "normal" // the resent copy is answered at once
  silence()
  const response = await sending
  expect(await response.text()).toContain("[DONE]")
  expect(ManagedH2.stats.retries).toBe(1)
  // Both copies carry the same key; the gateway answers a duplicate safely.
  expect(new Set(seen.filter((item) => item.key === "long-wait").map((item) => item.key)).size).toBe(1)
})

test("a call without an idempotency key is not resent after the connection dies", async () => {
  expect((await post("warm")).status).toBe(200)
  behaviour = "slow-headers"
  const sending = post()
  await Bun.sleep(50)
  silence()
  await expect(sending).rejects.toBeInstanceOf(ManagedH2.DeadConnection)
  expect(ManagedH2.stats.retries).toBe(0)
})

test("a stream that goes silent mid-reply errors instead of hanging, and is not resent", async () => {
  behaviour = "hang-mid-stream"
  const response = await post("mid")
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("one")
  silence()
  await expect(reader.read()).rejects.toBeInstanceOf(ManagedH2.DeadConnection)
  expect(ManagedH2.stats.retries).toBe(0)
})

test("a reply cut off by a dead connection is never reported as complete", async () => {
  behaviour = "die-mid-stream"
  const response = await post("cut")
  await expect(response.text()).rejects.toBeInstanceOf(ManagedH2.DeadConnection)
})

test("an aborted call is not resent", async () => {
  behaviour = "slow-headers"
  const controller = new AbortController()
  const sending = post("aborted", controller.signal)
  await Bun.sleep(50)
  controller.abort()
  await expect(sending).rejects.toThrow()
  expect(ManagedH2.stats.retries).toBe(0)
})

test("an origin that cannot be reached falls back to the fresh connection and is skipped for a while", async () => {
  const fresh = spyOn(FetchUtil, "fetchWithFreshConnection").mockImplementation(async () => new Response("fresh"))
  try {
    const closed = net.createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()))
    const port = (closed.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const url = `http://127.0.0.1:${port}/v1/chat/completions`
    expect(await (await ManagedH2.fetch(url, { method: "POST", body: "{}" })).text()).toBe("fresh")
    expect(await (await ManagedH2.fetch(url, { method: "POST", body: "{}" })).text()).toBe("fresh")
    expect(ManagedH2.stats.connects).toBe(1)
    expect(ManagedH2.stats.fallbacks).toBe(1)
  } finally {
    fresh.mockRestore()
  }
})

test("a gateway with a small upload window is not used", async () => {
  const small = http2.createServer()
  small.on("stream", (stream) => {
    stream.respond({ ":status": 200 })
    stream.end("h2")
  })
  await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", () => resolve()))
  const fresh = spyOn(FetchUtil, "fetchWithFreshConnection").mockImplementation(async () => new Response("fresh"))
  try {
    const url = `http://127.0.0.1:${(small.address() as net.AddressInfo).port}/v1/chat/completions`
    expect(await (await ManagedH2.fetch(url, { method: "POST", body: "{}" })).text()).toBe("fresh")
    expect(ManagedH2.stats.fallbacks).toBe(1)
  } finally {
    fresh.mockRestore()
    small.close()
  }
})

test("warming opens the connection with a request at once, and the model call reuses it", async () => {
  ManagedH2.warm(origin)
  const deadline = Date.now() + 2_000
  while (!seen.some((item) => item.path === "/api/health") && Date.now() < deadline) await Bun.sleep(10)
  expect(seen[0]?.path).toBe("/api/health")
  const response = await post("after-warm")
  expect(response.status).toBe(200)
  await response.text()
  expect(sessionsOpened).toHaveLength(1)
  expect(ManagedH2.stats).toMatchObject({ connects: 1, reused: 1 })
})
