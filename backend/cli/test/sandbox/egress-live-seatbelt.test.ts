import { describe, expect, test } from "bun:test"
import crypto from "crypto"
import { Egress } from "../../src/sandbox/egress"
import { Sandbox } from "../../src/sandbox/sandbox"
import { tmpdir } from "../fixture/fixture"

/**
 * The seatbelt counterpart to egress-live.test.ts: a real `sandbox-exec`, a
 * real TCP-loopback `Egress.serveProxy`, and a real remote host, wired
 * together exactly the way `Sandbox.plan` composes them in production. Task
 * 7 (see `.superpowers/sdd/2026-08-09-sandbox-network-policy/task-7-report.md`)
 * built the seatbelt profile and the authenticated loopback proxy entirely
 * from Linux, with `platform: "darwin"` injected on every assertion — nobody
 * on the project has a Mac, so none of it had ever reached a real
 * `sandbox-exec`. This file is what runs when a Mac finally does.
 *
 * `platform` is deliberately never passed to `Sandbox.plan` below. Every
 * seatbelt-specific test elsewhere in `test/sandbox/` injects `"darwin"` to
 * exercise the branch from Linux; this file's whole reason to exist is to
 * let `Sandbox.backend()`/`decide()` resolve for real, from a real
 * `Bun.which("sandbox-exec")` probe, on a machine where that probe can
 * actually succeed.
 *
 * Two open questions from the Task 7 report are what a red run here would
 * mean, and this file is written so a reader can tell which:
 *
 *   1. Whether `network-bind`/`network-inbound` are needed at all for the
 *      implicit local bind a TCP `connect()` performs, or whether
 *      `(deny network*)` blocks it regardless of the three narrow allows —
 *      in which case the sandboxed process never reaches the proxy at all.
 *      A failure here shows up as the FIRST test below failing to reach
 *      "200" for the allowlisted host (the process can't dial the proxy
 *      port in the first place), typically with curl reporting a connection
 *      error in `stderr` rather than any HTTP status.
 *   2. Whether the filter spelling seatbeltProfile emits — `(remote tcp
 *      "localhost:PORT")` — is what a real `sandbox-exec` expects, versus
 *      the `(remote ip ...)` this function used before Task 7's fix round 1.
 *      A failure here shows up the same way as (1) — a wrong filter keyword
 *      either fails `sandbox-exec -p` outright (a syntax/parse error in
 *      `stderr`, non-zero exit before the script's own commands ever run)
 *      or silently fails to match any traffic, which reads identically to
 *      (1) from this test's vantage point. Either way "the proxy is
 *      unreachable" is the shared symptom; telling the two apart needs a
 *      human reading `stderr` for a `sandbox-exec` parse error specifically
 *      — present means (2), absent means (1) or a genuine enforcement gap.
 *
 * Everything downstream of that — denied host refused, direct egress with
 * the proxy env unset failing, DNS resolving nothing inside the sandbox,
 * and volume surviving byte-for-byte through the seatbelt-side proxy path —
 * is new coverage of its own kind, not a restatement of the Linux file:
 * `Egress.serveProxy`'s TCP/authenticated branch (used only by seatbelt) has
 * never taken a live client through a real OS network boundary before this.
 *
 * Gated on `Sandbox.backend() === "seatbelt"`, real and non-injected — this
 * skips on Linux (where it stays exercised by the darwin-injected unit tests
 * elsewhere in this directory) and runs, unskipped, on the one machine that
 * can: a broken profile on that machine must fail this test, not quietly
 * skip it.
 */

const curl = Bun.which("curl")
const python = Bun.which("python3")

/**
 * A direct, un-sandboxed HEAD against a host the shipped default allowlist
 * already permits, run once at collection time — same purpose as
 * egress-live.test.ts's `reachable()`: without it, a macOS runner with no
 * route to the internet would see the checks below fail exactly the way a
 * broken profile would, which is not the defect this file exists to catch.
 */
function reachable() {
  if (!curl) return false
  const probe = Bun.spawnSync([
    curl,
    "-sS",
    "-I",
    "-m",
    "5",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "https://pypi.org/simple/",
  ])
  return probe.exitCode === 0 && probe.stdout.toString().trim() === "200"
}

const skip = Sandbox.backend() !== "seatbelt" || !curl || !python || !reachable()

/** A real host-side allowlist proxy on an OS-assigned loopback port, fed the
 *  real shipped `DEFAULT_RULES` — same shape as egress-live.test.ts's
 *  `proxy()`, but the seatbelt/TCP overload of `Egress.serveProxy` (a fresh
 *  `crypto.randomUUID()` secret per call, matching what `EgressRuntime`'s
 *  `startSeatbelt` does for a real proxy start) rather than a unix socket. */
function proxy(rules: Egress.Rule[]) {
  const secret = crypto.randomUUID()
  const server = Egress.serveProxy({ hostname: "127.0.0.1", port: 0, secret, rules })
  return {
    port: server.port,
    secret,
    stop: () => server.stop(true),
  }
}

/** Run `script` the way a sandboxed shell command actually runs in
 *  production — through `Sandbox.plan`, a real `sandbox-exec`-wrapped shell,
 *  and the real per-connection proxy allowlist check. `egress` is
 *  `"<port>:<secret>"`, the exact shape `EgressRuntime.egressFor` produces
 *  for seatbelt; `buildPolicy` splits it back into `Policy.port`/
 *  `Policy.secret`. No `platform` override — see the file doc comment. */
async function run(script: string, work: string, egress: string) {
  const spec = Sandbox.plan({
    command: script,
    shell: "/bin/sh",
    cwd: work,
    workspace: [work],
    options: { enabled: true, network: "allowlist", egress },
  })
  const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
    cwd: work,
    env: { ...process.env, ...spec.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { stdout, stderr }
}

describe.skipIf(skip)("egress: a real seatbelt sandbox, a real proxy, a real remote host", () => {
  test("an allowlisted host reaches 200, a denied one does not, and neither a direct connection nor DNS works outside the shim", async () => {
    await using work = await tmpdir()
    const host = proxy(Egress.DEFAULT_RULES)
    try {
      const egress = `${host.port}:${host.secret}`
      const script = [
        `pypi=$(curl -sS -I -m 30 -o /dev/null -w '%{http_code}' https://pypi.org/simple/)`,
        `eutils=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi')`,
        `example=$(curl -sS -I -m 15 -o /dev/null -w '%{http_code}' https://example.com/)`,
        // Same load-bearing pair as egress-live.test.ts, and the same
        // reasoning: `unset` inside a subshell strips every proxy var for
        // this one curl only, so a 200 here would mean the loopback port is
        // a convenience rather than the only way out.
        `direct=$(unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy; curl -sS -I -m 10 -o /dev/null -w '%{http_code}' https://pypi.org/)`,
        // No `getent` on macOS. `python3 -c` resolves the same host and this
        // captures only its exit status: 0 if `gethostbyname` returned an
        // address (DNS worked, which it must not, inside the sandbox), a
        // Python traceback's exit code (1, unhandled `socket.gaierror`)
        // otherwise. Output is discarded either way — only the exit code
        // is load-bearing, so nothing here depends on Python's traceback
        // format.
        `dns=$(python3 -c "import socket; socket.gethostbyname('pypi.org')" >/dev/null 2>&1; printf '%s' "$?")`,
        `printf 'PYPI=%s\\nEUTILS=%s\\nEXAMPLE=%s\\nDIRECT=%s\\nDNS=%s\\n' "$pypi" "$eutils" "$example" "$direct" "$dns"`,
      ].join("\n")

      const { stdout, stderr } = await run(script, work.path, egress)
      const field = (name: string) => stdout.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      const detail = `stdout=${stdout} stderr=${stderr}`

      // Guarded with a shape check first on every field, matching
      // egress-live.test.ts's convention: without it, a parsing regression
      // that made `field()` return undefined would still satisfy
      // `not.toBe(...)` and pass with nothing actually verified.
      expect(field("PYPI"), detail).toBe("200")
      expect(field("EUTILS"), detail).toBe("200")
      expect(field("EXAMPLE"), detail).toMatch(/^\d{3}$/)
      expect(field("EXAMPLE"), detail).not.toBe("200")
      expect(field("DIRECT"), detail).toMatch(/^\d{3}$/)
      expect(field("DIRECT"), detail).not.toBe("200")
      expect(field("DNS"), detail).toMatch(/^\d+$/)
      expect(field("DNS"), detail).not.toBe("0")
    } finally {
      host.stop()
    }
  }, 120_000)

  // Same file, same size, same hash as egress-live.test.ts's wheel test —
  // deliberately not re-derived, so a divergence between the two backends'
  // handling of the exact same bytes would show up as one green and one red
  // rather than two different payloads that happen to both pass. `pump`
  // (egress.ts) is shared code between the unix-socket and TCP/loopback
  // listeners; this is the first time its TCP branch has moved anything
  // this large through a real OS network boundary rather than a stubbed one.
  const WHEEL_URL =
    "https://files.pythonhosted.org/packages/3a/d0/edc009c27b406c4f9cbc79274d6e46d634d139075492ad055e3d68445925/numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
  const WHEEL_SIZE = 18_252_005
  const WHEEL_SHA256 = "666dbfb6ec68962c033a450943ded891bed2d54e6755e35e5835d63f4f6931d5"

  test("megabytes through a real proxy and a real host arrive byte-for-byte", async () => {
    await using work = await tmpdir()
    const host = proxy(Egress.DEFAULT_RULES)
    try {
      const egress = `${host.port}:${host.secret}`
      const out = `${work.path}/numpy.whl`
      // Same budget reasoning as egress-live.test.ts: curl's own timeout
      // stays comfortably inside the outer 120_000ms so a genuinely slow
      // download fails with a legible `curl: (28)` rather than racing the
      // outer bun:test timeout and losing the diagnostic.
      const script = `curl -sS -m 90 -o ${JSON.stringify(out)} -w '%{http_code} %{size_download}' ${JSON.stringify(WHEEL_URL)}`

      const { stdout, stderr } = await run(script, work.path, egress)
      expect(stdout.trim(), `stderr=${stderr}`).toBe(`200 ${WHEEL_SIZE}`)

      const bytes = await Bun.file(out).arrayBuffer()
      expect(bytes.byteLength).toBe(WHEEL_SIZE)
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(WHEEL_SHA256)
    } finally {
      host.stop()
    }
  }, 120_000)
})
