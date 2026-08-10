import type { Socket } from "bun"

/**
 * Allowlist egress proxy for sandboxed kernels.
 *
 * `sandbox.network` is otherwise binary: deny (`--unshare-net`) locks out
 * NCBI, UniProt, PDB and PyPI, which is most of the product's purpose; allow
 * is unrestricted egress. This gives a middle: an allowlist proxy, with no
 * direct DNS inside the sandbox — name resolution happens at the proxy.
 *
 * A bind-mounted unix socket still crosses `--unshare-net`'s network
 * namespace, so it is the only route out, and the proxy on the other end
 * decides what is reachable. No pasta, no nftables, no root.
 *
 * Two roles:
 *   serveProxy — runs on the HOST, listens on a unix socket, speaks HTTP proxy
 *   serveShim  — runs INSIDE the sandbox, TCP on loopback → the unix socket,
 *                because pip/requests/curl take a host:port proxy, not a
 *                unix path
 *
 * Ported from the feasibility spike on `proto/sandbox-allowlist-proxy`
 * (`src/sandbox/prototype/proxy.ts`); see that branch's README for the
 * measurements behind the design.
 */
export namespace Egress {
  export type Rule = string

  /** Exact host, or a leading dot for suffix match: ".ncbi.nlm.nih.gov". */
  export function allowed(host: string, rules: Rule[]): boolean {
    const name = host.toLowerCase().split(":")[0]
    return rules.some((rule) => {
      const value = rule.toLowerCase()
      if (value.startsWith(".")) return name === value.slice(1) || name.endsWith(value)
      return name === value
    })
  }

  export const DEFAULT_RULES: Rule[] = [
    // package registries
    "pypi.org",
    ".pypi.org",
    "files.pythonhosted.org",
    ".pythonhosted.org",
    "cran.r-project.org",
    ".bioconductor.org",
    // scientific APIs
    ".ncbi.nlm.nih.gov",
    ".uniprot.org",
    ".rcsb.org",
    ".ebi.ac.uk",
    ".ensembl.org",
    "arxiv.org",
    ".arxiv.org",
  ]

  /**
   * One direction of a bridged pair, with backpressure.
   *
   * `Socket.write` returns how many bytes the socket actually accepted, and
   * that is fewer than the whole chunk the moment the kernel send buffer
   * fills. Writing and discarding the count silently drops the remainder:
   * measured on this proxy before this existed, a 40 MB transfer arrived as
   * 2.6 MB through the proxy alone and 11.9 MB through shim + proxy, while
   * the same origin read directly delivered all 40 MB. Small responses fit in
   * one buffer and never show it, which is why every test that pushed
   * `hello` through passed.
   *
   * So: queue whatever the destination refused, flush it from the
   * destination's own `drain`, and pause the *source* while a backlog exists
   * so the queue tracks the slower end's pace instead of growing to the size
   * of the transfer. `end()` is deferred until the queue has actually gone
   * out — an upstream that closes right after a large body must not truncate
   * what is still in flight to the client.
   */
  function pump(target: Socket<unknown>) {
    const queue: Buffer[] = []
    const hold = (chunk: Buffer) => {
      // Copied, not retained: the buffer handed to a `data` callback belongs
      // to the caller for the duration of that call, and this outlives it.
      queue.push(Buffer.from(chunk))
      held.source?.pause()
    }
    const held = {
      /** The socket feeding this direction; paused while a backlog exists. */
      source: undefined as Socket<unknown> | undefined,
      ending: false,
      send(chunk: Buffer) {
        if (queue.length > 0) return hold(chunk)
        const wrote = target.write(chunk)
        if (wrote >= chunk.length) return
        hold(chunk.subarray(Math.max(wrote, 0)))
      },
      /** Drive from the target socket's `drain` handler, nowhere else. */
      flush() {
        while (queue.length > 0) {
          const head = queue[0]!
          const wrote = target.write(head)
          if (wrote < head.length) {
            if (wrote > 0) queue[0] = head.subarray(wrote)
            return
          }
          queue.shift()
        }
        held.source?.resume()
        if (held.ending) target.end()
      },
      end() {
        held.ending = true
        if (queue.length === 0) target.end()
      },
    }
    return held
  }

  type Pump = ReturnType<typeof pump>

  /**
   * A client connection's progress through the proxy, tracked explicitly
   * because `data` is async and Bun does not serialize its handlers: a second
   * chunk re-enters `data` while the first is parked on `await Bun.connect`.
   * Without a state set *before* that await, the re-entrant call finds no
   * link yet, re-parses the same still-buffered head, and dials the origin a
   * second time — measured: one client POST whose body followed the head by
   * 1/5/10ms produced 2 upstream connections to a local origin and 4 to a
   * real remote one, each carrying a duplicate of a non-idempotent request,
   * with `toUpstream` left pointing at whichever dial resolved last.
   *
   *   head    — still reading the request head
   *   dialing — head parsed and allowed, upstream connect in flight
   *   linked  — bytes flow both ways
   *   closed  — denied, unreachable, or the client went away
   *
   * `closed` is what a dial in flight checks when it resolves, so a client
   * that aborts mid-dial cannot strand an upstream socket nobody will ever
   * close.
   */
  type Phase = "head" | "dialing" | "linked" | "closed"

  /** What both bridges track per client connection. The shim has no head to
   *  read, so it simply starts at `dialing`. */
  type Link = { phase: Phase; toClient: Pump; toUpstream?: Pump }

  type Pending = Link & { buffer: string }

  const state = new WeakMap<Socket<unknown>, Pending>()

  /** Mark a client gone and release whatever it owns. Setting the phase is
   *  what a dial still in flight sees when it resolves; without it, the
   *  socket that dial produces is owned by nobody — `close` has already run
   *  and found no link to tear down. */
  function shut(held?: Link) {
    if (!held) return
    held.phase = "closed"
    held.toUpstream?.end()
  }

  /** Read the phase through a call, not a comparison in place: assigning
   *  `dialing` earlier in the same scope narrows the property to that literal,
   *  and the compiler has no way to know `shut` can change it while an
   *  `await` is parked — which is the entire point of asking. */
  const gone = (held: Link) => held.phase === "closed"

  const deny = (reason: string) =>
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`

  const latin1 = (text: string) => Buffer.from(text, "latin1")

  /** Host side. Listens on a unix socket, proxies only allowlisted hosts. */
  export function serveProxy(input: { socket: string; rules: Rule[]; onEvent?: (line: string) => void }) {
    const log = input.onEvent ?? (() => {})

    return Bun.listen<undefined>({
      unix: input.socket,
      socket: {
        open(client) {
          state.set(client, { buffer: "", phase: "head", toClient: pump(client) })
        },
        async data(client, chunk) {
          const held = state.get(client)
          if (!held) return
          if (held.phase === "linked") {
            held.toUpstream?.send(chunk)
            return
          }
          if (held.phase === "closed") return

          // Everything before the link is one buffer, so body bytes that land
          // while the dial is in flight are simply still here when it
          // resolves — `rest` is sliced after the await, not before it.
          held.buffer += chunk.toString("latin1")
          if (held.phase === "dialing") return
          const end = held.buffer.indexOf("\r\n\r\n")
          if (end === -1) return

          const head = held.buffer.slice(0, end)
          const lines = head.split("\r\n")
          const request = lines[0] ?? ""
          const [method, target, version = "HTTP/1.1"] = request.split(" ")

          // CONNECT host:443 for TLS; absolute-form GET http://host/path for plain.
          const url =
            method === "CONNECT"
              ? undefined
              : (() => {
                  try {
                    return new URL(target)
                  } catch {
                    return undefined
                  }
                })()
          const authority = method === "CONNECT" ? target : url?.host

          if (!authority) {
            log(`malformed ${request.slice(0, 60)}`)
            held.phase = "closed"
            held.toClient.send(latin1(deny("Malformed proxy request")))
            held.toClient.end()
            return
          }

          if (!allowed(authority, input.rules)) {
            log(`DENY  ${authority}`)
            held.phase = "closed"
            held.toClient.send(latin1(deny(`Host not on the sandbox allowlist: ${authority.split(":")[0]}`)))
            held.toClient.end()
            return
          }

          const [hostname, port] = authority.split(":")
          // Claim the dial before yielding. Everything above this line is
          // synchronous, so no second chunk can be part-way through the same
          // parse when it runs.
          held.phase = "dialing"
          const upstream = await Bun.connect<undefined>({
            hostname,
            port: Number(port ?? (method === "CONNECT" ? 443 : 80)),
            socket: {
              data(_sock, payload) {
                held.toClient.send(payload)
              },
              drain() {
                held.toUpstream?.flush()
              },
              close() {
                held.toClient.end()
              },
              error() {
                held.toClient.end()
              },
            },
          }).catch(() => undefined)

          // The client can have gone away while the dial was in flight, in
          // which case this is the only place that can release the socket it
          // just produced.
          if (gone(held)) {
            upstream?.end()
            return
          }

          if (!upstream) {
            log(`FAIL  ${authority}`)
            held.phase = "closed"
            held.toClient.send(latin1(deny(`Cannot reach ${authority}`)))
            held.toClient.end()
            return
          }

          log(`ALLOW ${authority}`)
          const toUpstream = pump(upstream)
          toUpstream.source = client
          held.toClient.source = upstream
          held.toUpstream = toUpstream
          held.phase = "linked"
          // Sliced now rather than before the dial, so anything the client
          // sent while it was in flight goes upstream in arrival order.
          const rest = held.buffer.slice(end + 4)
          held.buffer = ""
          // CONNECT: acknowledge, then the client starts its TLS handshake.
          // Plain HTTP: replay the request head we already consumed.
          if (method === "CONNECT") {
            held.toClient.send(latin1("HTTP/1.1 200 Connection Established\r\n\r\n"))
            if (rest) toUpstream.send(latin1(rest))
            return
          }

          // A proxy must rewrite absolute-form to origin-form. Forwarding
          // `GET http://pypi.org/simple/ HTTP/1.1` verbatim is legal per RFC 7230
          // §5.3.2 but origin servers routinely reject it — measured: 403 from
          // pypi.org on the plain-HTTP path while CONNECT to the same host
          // returned 200. Also drop hop-by-hop `Proxy-*` headers, which are for
          // us and must not travel upstream.
          const origin = `${url!.pathname}${url!.search}` || "/"
          const headers = lines
            .slice(1)
            .filter((line) => !/^proxy-/i.test(line))
            .filter((line) => !/^host:/i.test(line))
          const rewritten = [`${method} ${origin} ${version}`, `Host: ${url!.host}`, ...headers].join("\r\n")
          toUpstream.send(latin1(`${rewritten}\r\n\r\n${rest}`))
        },
        drain(client) {
          state.get(client)?.toClient.flush()
        },
        close(client) {
          shut(state.get(client))
          state.delete(client)
        },
        error(client) {
          shut(state.get(client))
          state.delete(client)
        },
      },
    })
  }

  /**
   * Sandbox side. pip, requests and curl take `http://host:port` from
   * HTTP_PROXY — none of them speak unix-socket proxies — so a loopback
   * listener inside the namespace forwards raw bytes to the bind-mounted
   * socket.
   */
  export function serveShim(input: { port: number; socket: string }) {
    // `pending` is for the window *before* the link exists — distinct from the
    // backpressure queue inside `pump`, which is for after it does. `open` is
    // async, so a client that writes immediately — curl sends CONNECT the
    // moment the TCP handshake completes — arrives before the upstream link
    // exists. Without this buffer those bytes are dropped and the connection
    // hangs: the listener accepts, nothing is ever forwarded, and the client
    // times out with the socket showing LISTEN the whole time.
    //
    // The `closed` phase covers the mirror image: a client that goes away
    // *during* that same window. Its `close` runs while `toUpstream` is still
    // undefined, so it has nothing to tear down, and the socket the dial then
    // produces is owned by nobody. Measured on 300 connect-then-immediately-
    // close connections, that stranded one fd per connection in this process
    // and one in the host proxy on the other end of it — and a kernel or a
    // terminal is a sandbox that lives for hours.
    type Bridge = Link & { pending: Buffer[] }
    const links = new WeakMap<Socket<unknown>, Bridge>()

    return Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: input.port,
      socket: {
        async open(client) {
          const held: Bridge = { pending: [], phase: "dialing", toClient: pump(client) }
          links.set(client, held)
          const upstream = await Bun.connect<undefined>({
            unix: input.socket,
            socket: {
              data(_sock, payload) {
                held.toClient.send(payload)
              },
              drain() {
                held.toUpstream?.flush()
              },
              close() {
                held.toClient.end()
              },
              error() {
                held.toClient.end()
              },
            },
          }).catch(() => undefined)
          if (gone(held)) {
            upstream?.end()
            held.pending.length = 0
            return
          }
          if (!upstream) {
            held.toClient.end()
            return
          }
          const toUpstream = pump(upstream)
          toUpstream.source = client
          held.toClient.source = upstream
          held.toUpstream = toUpstream
          held.phase = "linked"
          for (const chunk of held.pending) toUpstream.send(chunk)
          held.pending.length = 0
        },
        data(client, chunk) {
          const held = links.get(client)
          if (!held || gone(held)) return
          if (held.toUpstream) return void held.toUpstream.send(chunk)
          held.pending.push(Buffer.from(chunk))
        },
        drain(client) {
          links.get(client)?.toClient.flush()
        },
        close(client) {
          shut(links.get(client))
        },
        error(client) {
          shut(links.get(client))
        },
      },
    })
  }
}
