import { afterEach, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import type { Socket } from "bun"
import { Egress } from "../../src/sandbox/egress"

test("an exact rule matches only that host", () => {
  expect(Egress.allowed("pypi.org", ["pypi.org"])).toBe(true)
  expect(Egress.allowed("evil-pypi.org", ["pypi.org"])).toBe(false)
})

test("a leading dot matches the domain and its subdomains", () => {
  expect(Egress.allowed("eutils.ncbi.nlm.nih.gov", [".ncbi.nlm.nih.gov"])).toBe(true)
  expect(Egress.allowed("ncbi.nlm.nih.gov", [".ncbi.nlm.nih.gov"])).toBe(true)
  expect(Egress.allowed("ncbi.nlm.nih.gov.evil.com", [".ncbi.nlm.nih.gov"])).toBe(false)
})

test("a port on the authority is ignored when matching", () => {
  expect(Egress.allowed("pypi.org:443", ["pypi.org"])).toBe(true)
})

test("matching is case-insensitive in both directions", () => {
  expect(Egress.allowed("PyPI.ORG", ["pypi.org"])).toBe(true)
  expect(Egress.allowed("pypi.org", ["PyPI.ORG"])).toBe(true)
})

test("an empty ruleset allows nothing", () => {
  expect(Egress.allowed("pypi.org", [])).toBe(false)
})

test("the shipped defaults cover the registries and scientific APIs the product needs", () => {
  for (const host of [
    "pypi.org",
    "files.pythonhosted.org",
    "cran.r-project.org",
    "eutils.ncbi.nlm.nih.gov",
    "rest.uniprot.org",
  ]) {
    expect(Egress.allowed(host, Egress.DEFAULT_RULES)).toBe(true)
  }
})

test("the shipped defaults do not permit general browsing", () => {
  for (const host of ["example.com", "www.google.com", "raw.githubusercontent.com"]) {
    expect(Egress.allowed(host, Egress.DEFAULT_RULES)).toBe(false)
  }
})

// ── volume ──────────────────────────────────────────────────────────────────
//
// Everything above, and every earlier test of the bridge itself, moves a few
// bytes. That is exactly the size at which a dropped-backpressure bug is
// invisible: one small write fits the send buffer whole, so the byte count
// `Socket.write` returns equals what was asked of it and discarding that count
// costs nothing. Past a send buffer it does not — before `pump` existed, 8 MB
// through the proxy arrived as ~2.6 MB, and `pip download numpy` inside a real
// sandbox died with `SSL: RECORD_LAYER_FAILURE` while an 11 KB package
// installed fine. So these transfer real volume, in both directions, and
// compare the bytes rather than counting them.

const VOLUME = 8 * 1024 * 1024

/** Not a constant fill: a repeated byte would pass even if the bridge
 *  duplicated or reordered a chunk, which is the other way a backpressure
 *  queue goes wrong. This makes position observable. */
const sample = Buffer.from(Uint8Array.from({ length: VOLUME }, (_, i) => (i * 31 + (i >> 13)) % 251))

const opened: { stop: () => void }[] = []

afterEach(() => {
  for (const it of opened.splice(0)) it.stop()
})

/** A raw TCP origin. Sends `sample` at whatever pace the peer accepts (so the
 *  test measures the bridge's backpressure, not the origin's), collects
 *  everything sent to it, and closes only once both halves are complete —
 *  which is also what makes an early `end()` on the bridge observable, since a
 *  close that jumps a queue truncates the tail rather than hanging. */
type Talker = { sent: number; got: number; head: number; received: Buffer[] }

function origin() {
  const uploads: Buffer[][] = []
  const talkers = new WeakMap<Socket<undefined>, Talker>()

  const push = (sock: Socket<undefined>, held: Talker) => {
    while (held.sent < VOLUME) {
      const wrote = sock.write(sample.subarray(held.sent))
      if (wrote <= 0) return
      held.sent += wrote
    }
    if (held.head >= 0 && held.got - held.head >= VOLUME) sock.end()
  }

  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        const held: Talker = { sent: 0, got: 0, head: -1, received: [] }
        uploads.push(held.received)
        talkers.set(sock, held)
      },
      data(sock, chunk) {
        const held = talkers.get(sock)
        if (!held) return
        held.received.push(Buffer.from(chunk))
        held.got += chunk.length
        // The request head is the cue to start sending, and its length is what
        // makes "the whole upload arrived" a byte count rather than a guess.
        if (held.head < 0) {
          const end = Buffer.concat(held.received).indexOf("\r\n\r\n")
          if (end < 0) return
          held.head = end + 4
        }
        push(sock, held)
      },
      drain(sock) {
        const held = talkers.get(sock)
        if (held) push(sock, held)
      },
      error() {},
    },
  })

  opened.push({ stop: () => server.stop(true) })
  return { port: server.port, uploads }
}

function proxy(rules: string[]) {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "egress-vol-")), "e.sock")
  const server = Egress.serveProxy({ socket, rules })
  opened.push({
    stop: () => {
      server.stop(true)
      fs.rmSync(path.dirname(socket), { recursive: true, force: true })
    },
  })
  return socket
}

function shim(socket: string) {
  // Port 0 lets the OS pick, so concurrent test files cannot collide the way a
  // fixed 3128 would. Inside a real sandbox the port is fixed instead, because
  // --unshare-net makes collision impossible there.
  const server = Egress.serveShim({ port: 0, socket })
  opened.push({ stop: () => server.stop(true) })
  return server.port
}

/** Speak CONNECT to the proxy, upload `send`, then read until close. */
function transfer(to: { unix: string } | { hostname: string; port: number }, authority: string, send: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("the transfer never completed")), 60_000)
    const chunks: Buffer[] = []
    const state = { established: false, at: 0 }
    const upload = (sock: Socket<undefined>) => {
      while (state.at < send.length) {
        const wrote = sock.write(send.subarray(state.at))
        if (wrote <= 0) return
        state.at += wrote
      }
    }
    const done = (result: Buffer) => {
      clearTimeout(timeout)
      resolve(result)
    }
    const handlers = {
      open(sock: Socket<undefined>) {
        sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
      },
      data(sock: Socket<undefined>, chunk: Buffer) {
        if (state.established) return void chunks.push(Buffer.from(chunk))
        const end = chunk.indexOf("\r\n\r\n")
        if (end === -1) return
        state.established = true
        chunks.push(Buffer.from(chunk.subarray(end + 4)))
        sock.write("GET / HTTP/1.0\r\n\r\n")
        upload(sock)
      },
      drain: upload,
      close: () => done(Buffer.concat(chunks)),
      error: () => done(Buffer.concat(chunks)),
    }
    // Branched rather than spread: Bun.connect is overloaded on unix vs
    // hostname/port, and a union spread into one object literal matches
    // neither overload.
    const dial =
      "unix" in to
        ? Bun.connect<undefined>({ unix: to.unix, socket: handlers })
        : Bun.connect<undefined>({ hostname: to.hostname, port: to.port, socket: handlers })
    dial.catch(reject)
  })
}

test("megabytes survive the proxy byte for byte, in both directions", async () => {
  const upstream = origin()
  const socket = proxy(["127.0.0.1"])

  const down = await transfer({ unix: socket }, `127.0.0.1:${upstream.port}`, sample)

  expect(down.length).toBe(VOLUME)
  expect(down.equals(sample)).toBe(true)
  // The uploaded copy arrives behind the "GET / HTTP/1.0" that cued the
  // download, so drop that prefix before comparing.
  const up = Buffer.concat(upstream.uploads[0]!)
  const body = up.subarray(up.indexOf("\r\n\r\n") + 4)
  expect(body.length).toBe(VOLUME)
  expect(body.equals(sample)).toBe(true)
}, 120_000)

test("megabytes survive the shim and the proxy together, in both directions", async () => {
  const upstream = origin()
  const socket = proxy(["127.0.0.1"])
  const port = shim(socket)

  const down = await transfer({ hostname: "127.0.0.1", port }, `127.0.0.1:${upstream.port}`, sample)

  expect(down.length).toBe(VOLUME)
  expect(down.equals(sample)).toBe(true)
  const up = Buffer.concat(upstream.uploads[0]!)
  const body = up.subarray(up.indexOf("\r\n\r\n") + 4)
  expect(body.length).toBe(VOLUME)
  expect(body.equals(sample)).toBe(true)
}, 120_000)
