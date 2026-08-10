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

// ── one client, one upstream ────────────────────────────────────────────────
//
// Both bridges dial their upstream from inside an `async` handler, and Bun does
// not serialize those handlers — a second chunk, or a client's FIN, re-enters
// while the first call is parked on `await Bun.connect`. Two distinct defects
// live in that window, and neither is visible to a test that moves bytes
// through a connection that behaves politely from start to finish.

/** Handlers for an upstream that counts connections and, crucially, whether
 *  each one was ever closed. Counting sockets rather than file descriptors
 *  keeps this honest on platforms without /proc, and measures the actual
 *  invariant: nothing a bridge dials may be left with no owner. Each
 *  connection's bytes accumulate in their own entry, so a concurrent second
 *  connection cannot have its bytes attributed to the first. */
function counter() {
  const seen: { text: string }[] = []
  const counts = { opened: 0, closed: 0 }
  const entries = new WeakMap<Socket<undefined>, { text: string }>()
  const socket = {
    open(sock: Socket<undefined>) {
      counts.opened++
      const entry = { text: "" }
      seen.push(entry)
      entries.set(sock, entry)
    },
    data(sock: Socket<undefined>, chunk: Buffer) {
      const entry = entries.get(sock)
      if (entry) entry.text += chunk.toString()
    },
    close() {
      counts.closed++
    },
    error() {},
  }
  return { counts, seen, socket }
}

function unixCounter(at: string) {
  const held = counter()
  const server = Bun.listen<undefined>({ unix: at, socket: held.socket })
  opened.push({ stop: () => server.stop(true) })
  return held
}

function tcpCounter() {
  const held = counter()
  const server = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: held.socket })
  opened.push({ stop: () => server.stop(true) })
  return { ...held, port: server.port }
}

function scratch(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-abort-"))
  opened.push({ stop: () => fs.rmSync(dir, { recursive: true, force: true }) })
  return path.join(dir, name)
}

/** Wait for the counts to stop moving rather than guessing at the race. */
async function settle(counts: { opened: number; closed: number }) {
  for (let i = 0; i < 40 && counts.closed < counts.opened; i++) await Bun.sleep(50)
}

/** connect(), then FIN in the same turn, with nothing sent. */
function abort(port: number) {
  return Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(sock) {
        sock.end()
      },
      data() {},
      close() {},
      error() {},
    },
  })
}

test("a client that aborts mid-dial does not strand the shim's upstream", async () => {
  const socket = scratch("u.sock")
  const upstream = unixCounter(socket)
  const port = shim(socket)

  const N = 60
  for (let i = 0; i < N; i++) await abort(port)
  await settle(upstream.counts)

  // The dial really happened — otherwise this would pass trivially.
  expect(upstream.counts.opened).toBeGreaterThan(0)
  // And every one of them was closed. Before the shim tracked the client's
  // departure, `close` ran while `toUpstream` was still undefined, so it had
  // nothing to tear down: measured at 300 aborts across separate processes,
  // 0.897 fd/conn stranded in the shim and the same in the host proxy, held
  // for as long as the sandbox lives — hours, for a kernel or a terminal.
  expect(upstream.counts.closed).toBe(upstream.counts.opened)
}, 60_000)

test("a client that aborts mid-dial does not strand the proxy's upstream", async () => {
  const socket = scratch("p.sock")
  // "localhost" rather than 127.0.0.1: the dial then includes a name lookup,
  // which is what holds the window open long enough to observe any of this.
  // Resolved from /etc/hosts, so no network is involved.
  const upstream = tcpCounter()
  const server = Egress.serveProxy({ socket, rules: ["localhost"] })
  opened.push({ stop: () => server.stop(true) })

  const N = 40
  for (let i = 0; i < N; i++) {
    const client = await Bun.connect<undefined>({
      unix: socket,
      socket: {
        open(sock) {
          // A complete head, so the proxy commits to dialling, then leave.
          sock.write(`CONNECT localhost:${upstream.port} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
          sock.end()
        },
        data() {},
        close() {},
        error() {},
      },
    })
    client.end()
  }
  await settle(upstream.counts)

  expect(upstream.counts.opened).toBeGreaterThan(0)
  expect(upstream.counts.closed).toBe(upstream.counts.opened)
}, 60_000)

test("a body that arrives after its head still produces exactly one upstream", async () => {
  const pieces = ["id=1", "&id=2", "&x"]
  const body = pieces.join("")
  const socket = scratch("d.sock")
  const upstream = tcpCounter()
  const server = Egress.serveProxy({ socket, rules: ["localhost"] })
  opened.push({ stop: () => server.stop(true) })

  // The shape NCBI E-utilities recommends for a large id list, and the shape
  // `HTTP_PROXY` routes through this branch: a plain-http POST whose body
  // follows the head across separate segments. Each of those segments used to
  // re-enter `data`, find no link yet, re-parse the same buffered head and
  // dial again — 2 upstream connections against a local origin, 4 against a
  // real remote one, every one of them carrying a duplicate of a
  // non-idempotent request.
  // Run in parallel, and not as a nod to realism: the dial has to still be in
  // flight when the next segment lands, and on loopback with a warm resolver a
  // single dial finishes inside the 1ms gap. Concurrency is what holds the
  // window open — enough simultaneous name lookups to queue behind the
  // resolver — and it is the only trigger measured here that survives a warm
  // cache. Against the unfixed proxy this produced 200 upstream connections
  // for these 100 clients, three runs out of three; at 25 clients it was one
  // run in three, and sequentially it needed a cold cache to reproduce at all.
  const target = `localhost:${upstream.port}`
  const clients = 100
  const socks = await Promise.all(
    Array.from({ length: clients }, async () => {
      const client = await Bun.connect<undefined>({
        unix: socket,
        socket: { data() {}, close() {}, error() {} },
      })
      client.write(`POST http://${target}/eutils HTTP/1.1\r\nHost: ${target}\r\nContent-Length: ${body.length}\r\n\r\n`)
      for (const [i, gap] of [1, 5, 10].entries()) {
        await Bun.sleep(gap)
        client.write(pieces[i]!)
      }
      return client
    }),
  )
  await Bun.sleep(1_000)

  expect(upstream.counts.opened).toBe(clients)
  // And each one carries a whole request, rather than the head being
  // duplicated onto a second connection with the body split between them.
  expect(upstream.seen.length).toBe(clients)
  for (const entry of upstream.seen) {
    expect(entry.text).toContain("POST /eutils")
    expect(entry.text).toContain(body)
  }
  for (const s of socks) s.end()
}, 60_000)
