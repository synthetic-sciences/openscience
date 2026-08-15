import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { EgressRuntime } from "../../src/sandbox/egress-runtime"
import { Sandbox } from "../../src/sandbox/sandbox"

// A global config write is process-wide and outlives any one test, so every
// test that touches sandbox config must undo it — otherwise it leaks into
// whichever test file bun happens to run next in this process.
async function cleanGlobalSandboxConfig() {
  for (const name of ["openscience.jsonc", "openscience.json", "config.json"]) {
    await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
  }
  Config.global.reset()
}

afterEach(async () => {
  await EgressRuntime.stop()
  await cleanGlobalSandboxConfig()
})

test("ensure is idempotent and returns a stable address", async () => {
  const first = await EgressRuntime.ensure()
  const second = await EgressRuntime.ensure()
  expect(second.socket).toBe(first.socket)
  expect(second.port).toBe(first.port)
  await EgressRuntime.stop()
})

test("a failed start does not latch — the next call really retries", async () => {
  // Making the state directory unwritable is the cheapest real way to make
  // the bind fail; every other route (a port already taken, a path too long)
  // is either not applicable to a unix socket or harder to arrange
  // deterministically. Global.Path.state is a per-test-process tmpdir (see
  // test/preload.ts), so this cannot touch a developer's real state dir —
  // but it is still restored in `finally`, because leaving it read-only
  // would break every later test in this process rather than just this one.
  const dir = Global.Path.state
  await fs.mkdir(dir, { recursive: true })
  const mode = (await fs.stat(dir)).mode & 0o7777

  const failure = await (async () => {
    try {
      await fs.chmod(dir, 0o500)
      // platform "linux", not the ambient one: an unwritable state directory
      // only fails the bubblewrap listener, which is the one that binds a
      // unix socket there. The darwin listener binds a loopback port and
      // would have started happily, leaving `failure` undefined.
      return await EgressRuntime.ensure("linux").then(
        () => undefined,
        (error) => error as Error,
      )
    } finally {
      await fs.chmod(dir, mode)
    }
  })()

  // Loud: the message has to name the thing that broke and what depends on
  // it, since the caller is an unrelated-looking bash/kernel/job spawn.
  expect(failure?.message).toContain("sandbox allowlist proxy")

  // Recoverable: the rejected promise must not have been cached. Caching it
  // would make one transient failure permanent for the process — and under
  // the "allowlist" default that is every bash command, terminal, kernel and
  // compute job failing until restart.
  const recovered = await EgressRuntime.ensure("linux")
  // Non-null: the bubblewrap listener always carries a socket —
  // `egress-runtime.ts`'s `Running` type makes the field optional only
  // because the darwin branch (added by Task 7) carries a TCP endpoint
  // instead.
  await expect(fs.stat(recovered.socket!)).resolves.toBeDefined()
})

test("stop is safe after a start that failed", async () => {
  const dir = Global.Path.state
  await fs.mkdir(dir, { recursive: true })
  const mode = (await fs.stat(dir)).mode & 0o7777
  try {
    await fs.chmod(dir, 0o500)
    // platform "linux": same reason as the test above — only the bubblewrap
    // listener fails on an unwritable state directory, and a start that
    // succeeded would not exercise the escape hatch this test is about.
    await EgressRuntime.ensure("linux").catch(() => {})
  } finally {
    await fs.chmod(dir, mode)
  }
  // The escape hatch must not hand back the same failure it exists to clear.
  await expect(EgressRuntime.stop()).resolves.toBeUndefined()
})

test("the socket is created under the state directory, not the workspace", async () => {
  // platform "linux": there is no socket to place at all on darwin, which
  // listens on a loopback port instead.
  const { socket } = await EgressRuntime.ensure("linux")
  // Non-null: the bubblewrap listener always carries a socket.
  // Not Bun.file(socket).exists(): Bun.file() only recognizes regular files,
  // and a unix socket is a distinct inode type (S_IFSOCK) — verified with an
  // isolated Bun.listen({ unix }) that Bun.file(...).exists() reports false
  // for it while fs.stat sees it fine. fs.stat is the correct check here.
  await expect(fs.stat(socket!)).resolves.toBeDefined()
  expect(socket).not.toContain(process.cwd())
  await EgressRuntime.stop()
})

/** Speaks the proxy's wire format directly (see egress.ts) rather than going
 *  through the sandbox/shim, so this stays a test of EgressRuntime's rule
 *  freshness and not of the loopback bridge. CONNECT is used because its
 *  authority is the raw request target — no URL parsing to get right — and
 *  because both outcomes under test (denied vs. attempted-and-unreachable)
 *  answer with a 403 whose body text is the only thing distinguishing them. */
function proxyRequest(socket: string, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no response from the proxy for ${authority}`)), 2_000)
    let body = ""
    Bun.connect({
      unix: socket,
      socket: {
        open(client) {
          client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
        },
        data(_client, chunk) {
          body += chunk.toString()
        },
        close() {
          clearTimeout(timeout)
          resolve(body)
        },
        error(_client, error) {
          clearTimeout(timeout)
          reject(error)
        },
      },
    }).catch(reject)
  })
}

test("an allowlist edit reaches a running proxy without restarting it", async () => {
  // Nothing listens on loopback:1 (a privileged, essentially never-bound
  // port), so a request that clears the allowlist check still gets a 403 —
  // "cannot reach", not "not on the allowlist". That distinction is what
  // proves the check ran, without needing a real upstream.
  const authority = "127.0.0.1:1"
  // platform "linux": `proxyRequest` speaks to a unix socket, which only the
  // bubblewrap listener has. The freshness behaviour under test is the
  // proxy's, not the listener's, so pinning the transport keeps this one
  // test meaningful on either kind of machine.
  const first = await EgressRuntime.ensure("linux")

  // Non-null: the bubblewrap listener always carries a socket.
  const before = await proxyRequest(first.socket!, authority)
  expect(before).toContain("not on the sandbox allowlist")

  await Config.setSandbox({ allowHosts: ["127.0.0.1"] })

  // The proxy was never restarted — the same server, on the same socket,
  // now answers differently because it re-reads the allowlist per
  // connection rather than the snapshot it was born with. Retried rather
  // than asserted on the first attempt: the update reaches the running
  // proxy through a reactive config-change listener, not synchronously
  // with Config.setSandbox's own return.
  const deadline = Date.now() + 2_000
  let after = before
  while (Date.now() < deadline && after.includes("not on the sandbox allowlist")) {
    after = await proxyRequest(first.socket!, authority)
  }
  expect(after).not.toContain("not on the sandbox allowlist")
  expect(after).toContain("Cannot reach")

  const second = await EgressRuntime.ensure("linux")
  expect(second.socket).toBe(first.socket) // same proxy the whole time, not a restart
})

/**
 * `egressFor` has to answer, ahead of time, the same "would this actually be
 * sandboxed with an allowlist" question that `Sandbox.plan()`/`wrapArgv()`
 * answer for real via `decide()` + `buildPolicy()` — its socket becomes their
 * `options.egress`. The two used to default the unset cases in opposite
 * directions from each other on both fields, invisibly, because production's
 * five callers always pass an already-fully-resolved policy. These pin the
 * shared default (`Sandbox.resolved`) so a future edit that reintroduces a
 * hand-rolled check in just one of the two places fails here instead of
 * shipping.
 */
test("egressFor treats a missing enabled the same way decide() does: off", async () => {
  // Old behaviour: only an explicit `enabled: false` opted out, so this
  // started a real proxy nothing could ever reach — decide() never wraps a
  // command whose `options.enabled` isn't literally `true`.
  const egress = await EgressRuntime.egressFor({ network: "allowlist" })
  expect(egress).toBeUndefined()
})

test.skipIf(Sandbox.backend() !== "bubblewrap")(
  "egressFor and buildPolicy() agree on what a missing network means",
  async () => {
    // The property, not the value. These two read the same `Options` moments
    // apart — egressFor decides whether to stand a proxy up, buildPolicy decides
    // whether to demand one — so a disagreement between their defaults is a
    // crash: "sandbox network 'allowlist' requires an egress socket path", from
    // a caller that never mentioned the network at all.
    //
    // It has now been wrong in both directions. It read "not allowlist" here
    // while buildPolicy defaulted to allowlist; then, after this branch aligned
    // the config default to main's "deny", it read allowlist here while
    // buildPolicy had moved to deny. The assertion is agreement, so it holds
    // whichever value the default becomes next.
    const egress = await EgressRuntime.egressFor({ enabled: true })
    expect(egress).toBeUndefined()
    expect(() =>
      Sandbox.plan({
        command: "true",
        shell: "/bin/sh",
        cwd: "/tmp",
        workspace: ["/tmp"],
        options: { enabled: true, egress },
      }),
    ).not.toThrow()
  },
)

/**
 * Same wire technique as `proxyRequest` above, but dialed over TCP loopback
 * rather than the unix socket — what a seatbelt-sandboxed process reaches
 * directly, since seatbelt has no namespace to bind a unix socket into and
 * `Egress.serveProxy` listens on that loopback port itself (decision 1 of
 * the Task 7 brief: no host-side bridge). `auth`, when given, is sent as the
 * `Proxy-Authorization` secret the TCP listener requires (decision 2) —
 * omitted or wrong, the request must never reach the allowlist check at all.
 *
 * This is the one seatbelt-specific piece of Task 7 that genuinely runs,
 * without a Mac: everything here is a plain `Bun.connect`/`Bun.listen` pair
 * with nothing namespace- or platform-specific about it, so starting
 * `EgressRuntime` with `platform: "darwin"` injected and dialing it for real
 * proves the proxy → auth → allowlist path actually runs. What it cannot
 * prove is whether a real `sandbox-exec` restricts a sandboxed process to
 * dialing only this one port in the first place — see the Task 7 report for
 * exactly what a Mac owner still needs to run.
 */
function tcpProxyRequest(port: number, authority: string, auth?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no response from the proxy for ${authority}`)), 2_000)
    let body = ""
    const header = auth ? `\r\nProxy-Authorization: Basic ${Buffer.from(`os:${auth}`).toString("base64")}` : ""
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(client) {
          client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}${header}\r\n\r\n`)
        },
        data(_client, chunk) {
          body += chunk.toString()
        },
        close() {
          clearTimeout(timeout)
          resolve(body)
        },
        error(_client, error) {
          clearTimeout(timeout)
          reject(error)
        },
      },
    }).catch(reject)
  })
}

test("ensure with platform darwin listens on a loopback TCP port, not a unix socket", async () => {
  const running = await EgressRuntime.ensure("darwin")
  expect(running.hostname).toBe("127.0.0.1")
  // Ephemeral, not the bwrap shim's fixed SHIM_PORT: seatbelt has no
  // namespace to keep a fixed port private across concurrently sandboxed
  // processes the way --unshare-net does for bubblewrap.
  expect(running.port).not.toBe(Sandbox.SHIM_PORT)
  expect(running.port).toBeGreaterThan(0)
  // A secret was generated for this start — required to reach the proxy at
  // all, since a loopback port (unlike a unix socket) carries no filesystem
  // permissions of its own.
  expect(running.secret).toBeTruthy()
  // And no unix socket on this path at all — decision 1 of the Task 7
  // brief: serveProxy listens on TCP directly, no host-side bridge to one.
  expect(running.socket).toBeUndefined()
})

test("the darwin proxy forwards a correctly-authenticated request past both auth and the allowlist check, live", async () => {
  // 127.0.0.1 is not in Egress.DEFAULT_RULES, so it has to be added
  // explicitly here — otherwise a request to 127.0.0.1:1 is denied at the
  // allowlist check before the auth → dial chain this test exists to prove
  // is ever reached at all. (Task 7 fix round 1, I2: the unfixed version of
  // this test asserted "not on the sandbox allowlist" — the denial text —
  // while its own comment claimed the opposite outcome. Both the comment
  // and the assertion described a dial that never actually happened;
  // measured by the reviewer, confirmed here by fixing it forward instead
  // of just correcting the prose.)
  await Config.setSandbox({ allowHosts: ["127.0.0.1"] })
  const running = await EgressRuntime.ensure("darwin")
  // Nothing listens on loopback:1 (a privileged, essentially never-bound
  // port), so a request that clears BOTH the auth check and the allowlist
  // check still gets a 403 "Cannot reach" — not "not on the sandbox
  // allowlist" and not 407 — which is what proves the whole
  // auth → allowlist → dial chain actually ran end to end.
  const body = await tcpProxyRequest(running.port, "127.0.0.1:1", running.secret)
  expect(body).toContain("Cannot reach")
  expect(body).not.toContain("not on the sandbox allowlist")
  expect(body).not.toContain("407")
})

test("the darwin proxy refuses a request with no Proxy-Authorization, and never forwards it", async () => {
  const running = await EgressRuntime.ensure("darwin")
  const body = await tcpProxyRequest(running.port, "127.0.0.1:1")
  expect(body).toContain("407 Proxy Authentication Required")
  // Neither downstream outcome appears — the request was refused before the
  // allowlist check or the dial ever ran.
  expect(body).not.toContain("not on the sandbox allowlist")
  expect(body).not.toContain("Cannot reach")
})

test("the darwin proxy refuses a request with the wrong secret", async () => {
  const running = await EgressRuntime.ensure("darwin")
  const body = await tcpProxyRequest(running.port, "127.0.0.1:1", `${running.secret}-wrong`)
  expect(body).toContain("407 Proxy Authentication Required")
})

test('egressFor on darwin returns "port:secret", not a socket path', async () => {
  const egress = await EgressRuntime.egressFor({ enabled: true, network: "allowlist" }, "darwin")
  expect(egress).toBeDefined()
  const [portPart, secretPart] = egress!.split(":")
  expect(Number.isInteger(Number(portPart))).toBe(true)
  // Shape-checked against crypto.randomUUID()'s actual format, not just
  // toBeTruthy(): the string "undefined" — what a missing `secret` coerces
  // to inside a template literal — is itself truthy, so a bare truthiness
  // check structurally cannot catch the I1 defect the next test reproduces.
  expect(secretPart).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(egress).not.toContain("/")
  expect(egress).not.toContain(".sock")
})

// Task 7 fix round 1, I1: egressFor's seatbelt branch used to interpolate
// `running.secret` with no guard. ensure()/start() cache ONE proxy for the
// process lifetime (see ensure()'s doc comment); `platform` only decides
// what starts when nothing is running yet. Asking for "darwin" after a
// bubblewrap proxy is already cached — impossible for a real caller, since
// process.platform never changes mid-process, but reachable here because
// platform is deliberately injectable for testing — used to silently reuse
// that cached listener and return the literal string "3128:undefined"
// (Buffer-safe, syntactically valid, and — per the test above — exactly
// what a bare `toBeTruthy()` on the secret half cannot distinguish from a
// real one). Confirmed by execution before the fix; asserts the fail-closed
// replacement here.
test("egressFor on darwin fails closed rather than composing an undefined secret when a differently-platformed proxy is already cached", async () => {
  // Force the FIRST proxy to be the bubblewrap (unix-socket) shape,
  // deterministically regardless of what machine actually runs this test —
  // the same platform-injection seam every darwin test in this file uses,
  // just pointed at the other platform.
  await EgressRuntime.ensure("linux")
  await expect(EgressRuntime.egressFor({ enabled: true, network: "allowlist" }, "darwin")).rejects.toThrow(
    /already running as the bubblewrap/,
  )
})

test("egressFor with network deny or allow never starts a proxy on darwin", async () => {
  const deny = await EgressRuntime.egressFor({ enabled: true, network: "deny" }, "darwin")
  expect(deny).toBeUndefined()
  const allow = await EgressRuntime.egressFor({ enabled: true, network: "allow" }, "darwin")
  expect(allow).toBeUndefined()
})

test("egressFor on linux/bubblewrap keeps returning the unix socket path, unaffected by the darwin branch", async () => {
  if (Sandbox.backend() !== "bubblewrap") return
  const egress = await EgressRuntime.egressFor({ enabled: true, network: "allowlist" })
  expect(egress).toContain(".sock")
})

/**
 * Task 7 fix round 1, I4: every auth test above hand-builds the
 * `Proxy-Authorization` header itself, which leaves the seam joining
 * `sandbox.ts`'s `proxyUrl()` (`http://os:<secret>@host:port`) to
 * `egress.ts`'s own parser of that header unpinned in-suite — a rename of
 * the userinfo user ("os") in one place only would still pass every other
 * test here. These drive a real `curl`, an independent HTTP client
 * implementation, at the *exact* URL `Sandbox.plan()` composes, covering
 * both wire forms curl uses to talk to a proxy: an absolute-form GET (its
 * default for a plain `http://` target) and a CONNECT tunnel (forced with
 * `--proxytunnel`, and also what curl uses unprompted for an `https://`
 * target — see `egress-live.test.ts` for that shape against a real host).
 * A third, with Python's `urllib`, covers a second independent client
 * library — the same proxy-auth mechanism pip itself relies on.
 */
function planProxyUrl(egress: string): string {
  const plan = Sandbox.plan({
    command: "true",
    shell: "/bin/sh",
    cwd: "/tmp",
    workspace: ["/tmp"],
    options: { enabled: true, network: "allowlist", egress },
    platform: "darwin",
  })
  const proxy = plan.env?.HTTP_PROXY
  expect(proxy).toMatch(/^http:\/\/os:.+@127\.0\.0\.1:\d+$/)
  return proxy!
}

/** `Bun.spawn`, never `Bun.spawnSync`: the origin and the proxy both reply
 *  from `Bun.listen`/`Bun.serve` callbacks on this same event loop, so a
 *  *synchronous* spawn would block that loop for as long as the child runs
 *  — the child blocks on recv() waiting for a reply the loop can't yet
 *  deliver, deadlocking both sides until the test times out. Reproduced
 *  while writing these three tests (all three hung at 5s with empty stdout)
 *  — the same defect class `sandbox.test.ts`'s own "Bun.spawn, not
 *  spawnSync" comment documents for an identical reason. */
async function runCapture(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { stdout, stderr }
}

test.skipIf(!Bun.which("curl"))(
  "a real curl (absolute-form GET) using the exact URL Sandbox.plan() emits authenticates and is forwarded",
  async () => {
    const origin = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    try {
      await Config.setSandbox({ allowHosts: ["127.0.0.1"] })
      const running = await EgressRuntime.ensure("darwin")
      const proxy = planProxyUrl(`${running.port}:${running.secret}`)
      const { stdout, stderr } = await runCapture([
        "curl",
        "-sS",
        "-m",
        "5",
        "-x",
        proxy,
        `http://127.0.0.1:${origin.port}/`,
      ])
      expect(stdout, stderr).toBe("ok")
    } finally {
      origin.stop(true)
    }
  },
)

test.skipIf(!Bun.which("curl"))(
  "a real curl --proxytunnel (forced CONNECT) using the exact URL Sandbox.plan() emits authenticates and is forwarded",
  async () => {
    const origin = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    try {
      await Config.setSandbox({ allowHosts: ["127.0.0.1"] })
      const running = await EgressRuntime.ensure("darwin")
      const proxy = planProxyUrl(`${running.port}:${running.secret}`)
      const { stdout, stderr } = await runCapture([
        "curl",
        "-sS",
        "-m",
        "5",
        "--proxytunnel",
        "-x",
        proxy,
        `http://127.0.0.1:${origin.port}/`,
      ])
      expect(stdout, stderr).toBe("ok")
    } finally {
      origin.stop(true)
    }
  },
)

test.skipIf(!Bun.which("python3"))(
  "a real Python urllib request using the exact URL Sandbox.plan() emits authenticates and is forwarded",
  async () => {
    const origin = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    try {
      await Config.setSandbox({ allowHosts: ["127.0.0.1"] })
      const running = await EgressRuntime.ensure("darwin")
      const proxy = planProxyUrl(`${running.port}:${running.secret}`)
      const target = `http://127.0.0.1:${origin.port}/`
      const script = [
        "import urllib.request",
        `handler = urllib.request.ProxyHandler({"http": ${JSON.stringify(proxy)}})`,
        "opener = urllib.request.build_opener(handler)",
        `print(opener.open(${JSON.stringify(target)}, timeout=5).read().decode(), end="")`,
      ].join("\n")
      const { stdout, stderr } = await runCapture(["python3", "-c", script])
      expect(stdout, stderr).toBe("ok")
    } finally {
      origin.stop(true)
    }
  },
)
