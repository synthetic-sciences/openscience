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

  type Pending = { buffer: string; upstream?: Socket<undefined>; connected: boolean }

  const state = new WeakMap<Socket<unknown>, Pending>()

  const deny = (reason: string) =>
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`

  /** Host side. Listens on a unix socket, proxies only allowlisted hosts. */
  export function serveProxy(input: { socket: string; rules: Rule[]; onEvent?: (line: string) => void }) {
    const log = input.onEvent ?? (() => {})

    return Bun.listen<undefined>({
      unix: input.socket,
      socket: {
        open(client) {
          state.set(client, { buffer: "", connected: false })
        },
        async data(client, chunk) {
          const held = state.get(client)
          if (!held) return
          if (held.connected) {
            held.upstream?.write(chunk)
            return
          }

          held.buffer += chunk.toString("latin1")
          const end = held.buffer.indexOf("\r\n\r\n")
          if (end === -1) return

          const head = held.buffer.slice(0, end)
          const rest = held.buffer.slice(end + 4)
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
            client.write(deny("Malformed proxy request"))
            client.end()
            return
          }

          if (!allowed(authority, input.rules)) {
            log(`DENY  ${authority}`)
            client.write(deny(`Host not on the sandbox allowlist: ${authority.split(":")[0]}`))
            client.end()
            return
          }

          const [hostname, port] = authority.split(":")
          const upstream = await Bun.connect<undefined>({
            hostname,
            port: Number(port ?? (method === "CONNECT" ? 443 : 80)),
            socket: {
              data(_sock, payload) {
                client.write(payload)
              },
              close() {
                client.end()
              },
              error() {
                client.end()
              },
            },
          }).catch(() => undefined)

          if (!upstream) {
            log(`FAIL  ${authority}`)
            client.write(deny(`Cannot reach ${authority}`))
            client.end()
            return
          }

          log(`ALLOW ${authority}`)
          held.upstream = upstream
          held.connected = true
          // CONNECT: acknowledge, then the client starts its TLS handshake.
          // Plain HTTP: replay the request head we already consumed.
          if (method === "CONNECT") {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            if (rest) upstream.write(Buffer.from(rest, "latin1"))
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
          upstream.write(Buffer.from(`${rewritten}\r\n\r\n${rest}`, "latin1"))
        },
        close(client) {
          state.get(client)?.upstream?.end()
          state.delete(client)
        },
        error(client) {
          state.get(client)?.upstream?.end()
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
    // `open` is async, so a client that writes immediately — curl sends CONNECT
    // the moment the TCP handshake completes — arrives before the upstream link
    // exists. Without this buffer those bytes are dropped and the connection
    // hangs: the listener accepts, nothing is ever forwarded, and the client
    // times out with the socket showing LISTEN the whole time.
    const links = new WeakMap<Socket<unknown>, { upstream?: Socket<undefined>; pending: Buffer[] }>()

    return Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: input.port,
      socket: {
        async open(client) {
          const held: { upstream?: Socket<undefined>; pending: Buffer[] } = { pending: [] }
          links.set(client, held)
          const upstream = await Bun.connect<undefined>({
            unix: input.socket,
            socket: {
              data(_sock, payload) {
                client.write(payload)
              },
              close() {
                client.end()
              },
              error() {
                client.end()
              },
            },
          }).catch(() => undefined)
          if (!upstream) {
            client.end()
            return
          }
          for (const chunk of held.pending) upstream.write(chunk)
          held.pending.length = 0
          held.upstream = upstream
        },
        data(client, chunk) {
          const held = links.get(client)
          if (!held) return
          if (held.upstream) return void held.upstream.write(chunk)
          held.pending.push(Buffer.from(chunk))
        },
        close(client) {
          links.get(client)?.upstream?.end()
        },
        error(client) {
          links.get(client)?.upstream?.end()
        },
      },
    })
  }
}
