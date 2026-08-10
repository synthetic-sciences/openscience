import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Egress } from "../../src/sandbox/egress"
import { Sandbox } from "../../src/sandbox/sandbox"
import { tmpdir } from "../fixture/fixture"

/**
 * The composition nobody had committed: a real `bwrap --unshare-net`, a
 * real `Egress.serveProxy` on the host, and a real remote host, wired
 * together exactly the way `Sandbox.plan`/`wrapArgv` wire them in
 * production. Every live test elsewhere in `test/sandbox/` stops short of
 * this — `sandbox.test.ts`'s shim tests terminate at a stub `Bun.listen`
 * standing in for the proxy, and `egress.test.ts`'s volume tests dial the
 * proxy directly, never through a sandboxed process. Neither proves a
 * sandboxed command can actually reach pypi.org, and that gap is exactly
 * why the proxy shipped silently truncating every transfer above a few KB
 * for four review rounds: every test that pushed a few bytes through
 * passed.
 *
 * Two things this file asserts and nothing else does:
 *   - the socket is the ONLY route out (a denied host gets refused by the
 *     proxy, AND a direct connection with the proxy variables unset fails,
 *     AND DNS itself resolves nothing inside the namespace) — without that
 *     trio this would prove the proxy works, not that it is the only way
 *     out, which is the actual security claim
 *   - real volume survives byte-for-byte, not just "curl exited 0"
 */

const curl = Bun.which("curl")

/**
 * A direct, un-sandboxed HEAD against a host the shipped default allowlist
 * already permits, run once at collection time. Without this, a machine
 * with no route to the internet would see the PYPI/EUTILS checks below come
 * back non-200 — which reads exactly like the policy defect this file
 * exists to catch, when it is really just an unplugged network. Synchronous
 * because bun:test needs the skip condition before any test body runs.
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

// bubblewrap, curl, getent and timeout are all load-bearing below — getent
// proves DNS resolves nothing inside the namespace, timeout bounds it in
// case that ever changes. Absent any of them, or with no network, this
// skips rather than fails: a red run here should mean the egress boundary
// broke, not that the host running the suite is a Mac or is offline.
const skip =
  Sandbox.backend() !== "bubblewrap" || !curl || !Bun.which("getent") || !Bun.which("timeout") || !reachable()

/** A real host-side allowlist proxy on a scratch unix socket — same shape
 *  as egress.test.ts's `proxy()`, but fed the real shipped `DEFAULT_RULES`
 *  rather than a synthetic rule, so pypi.org and the NCBI eutils subdomain
 *  are allowed and example.com is not, exactly as they are for a real user. */
function proxy(rules: Egress.Rule[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-live-"))
  const socket = path.join(dir, "e.sock")
  const server = Egress.serveProxy({ socket, rules })
  return {
    socket,
    stop: () => {
      server.stop(true)
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Run `script` the way a sandboxed shell command actually runs in
 *  production — through `Sandbox.plan`, a real `bwrap --unshare-net`, the
 *  real composed shim script, and the real per-connection proxy allowlist
 *  check. Nothing here is stubbed. */
async function run(script: string, work: string, socket: string) {
  const spec = Sandbox.plan({
    command: script,
    shell: "/bin/sh",
    cwd: work,
    workspace: [work],
    options: { enabled: true, network: "allowlist", egress: socket },
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

describe.skipIf(skip)("egress: a real sandbox, a real proxy, a real remote host", () => {
  test("an allowlisted host reaches 200, a denied one does not, and neither a direct connection nor DNS works outside the shim", async () => {
    await using work = await tmpdir()
    const host = proxy(Egress.DEFAULT_RULES)
    try {
      const script = [
        `pypi=$(curl -sS -I -m 30 -o /dev/null -w '%{http_code}' https://pypi.org/simple/)`,
        `eutils=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi')`,
        `example=$(curl -sS -I -m 15 -o /dev/null -w '%{http_code}' https://example.com/)`,
        // The load-bearing pair. `unset` inside a subshell strips every proxy
        // var — including `ALL_PROXY`, curl's protocol-agnostic fallback,
        // which a host could export even with `HTTPS_PROXY` unset — for this
        // one curl only; the checks above still route through the shim. So a
        // 200 here would mean the socket is a convenience rather than the
        // only way out, which is the entire claim this file exists to prove.
        `direct=$(unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy; curl -sS -I -m 10 -o /dev/null -w '%{http_code}' https://pypi.org/)`,
        `resolved=$(timeout 10 getent hosts pypi.org)`,
        `printf 'PYPI=%s\\nEUTILS=%s\\nEXAMPLE=%s\\nDIRECT=%s\\nGETENT=[%s]\\n' "$pypi" "$eutils" "$example" "$direct" "$resolved"`,
      ].join("\n")

      const { stdout, stderr } = await run(script, work.path, host.socket)
      const field = (name: string) => stdout.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      const detail = `stdout=${stdout} stderr=${stderr}`

      expect(field("PYPI"), detail).toBe("200")
      expect(field("EUTILS"), detail).toBe("200")
      // Guarded with a shape check first: without it, a parsing regression
      // that made `field()` return undefined would still satisfy
      // `not.toBe("200")` and pass with nothing actually verified.
      expect(field("EXAMPLE"), detail).toMatch(/^\d{3}$/)
      expect(field("EXAMPLE"), detail).not.toBe("200")
      expect(field("DIRECT"), detail).toMatch(/^\d{3}$/)
      expect(field("DIRECT"), detail).not.toBe("200")
      expect(field("GETENT"), detail).toBe("[]")
    } finally {
      host.stop()
    }
  }, 120_000)

  // Not pypi.org/simple/ itself: that index's byte length changes as
  // packages are published, so only a content-addressed release file has a
  // size and sha256 that stay true forever. This is numpy 1.26.4's
  // manylinux cp311 wheel from files.pythonhosted.org — re-hashed directly
  // against pypi.org while writing this test — chosen for size (18 MB,
  // comfortably past the send-buffer boundary where the historical
  // truncation bug was invisible) over the alternative of re-fetching
  // pypi.org/simple/ (~45 MB) and asserting only its size, which drifts.
  const WHEEL_URL =
    "https://files.pythonhosted.org/packages/3a/d0/edc009c27b406c4f9cbc79274d6e46d634d139075492ad055e3d68445925/numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
  const WHEEL_SIZE = 18_252_005
  const WHEEL_SHA256 = "666dbfb6ec68962c033a450943ded891bed2d54e6755e35e5835d63f4f6931d5"

  test("megabytes through a real proxy and a real host arrive byte-for-byte", async () => {
    await using work = await tmpdir()
    const host = proxy(Egress.DEFAULT_RULES)
    try {
      const out = path.join(work.path, "numpy.whl")
      // curl's own budget stays comfortably inside the outer 120_000ms: the
      // bwrap spawn and shim-readiness wait run before curl even starts, and
      // `finally`'s cleanup runs after it ends. Matching the two would let a
      // download that genuinely needs close to 120s race the outer bun:test
      // timeout instead of curl's own — trading a diagnostic
      // `curl: (28) Operation timed out` for a generic "test timed out" and
      // deferring `host.stop()` until the abandoned promise chain resolves.
      const script = `curl -sS -m 90 -o ${JSON.stringify(out)} -w '%{http_code} %{size_download}' ${JSON.stringify(WHEEL_URL)}`

      const { stdout, stderr } = await run(script, work.path, host.socket)
      expect(stdout.trim(), `stderr=${stderr}`).toBe(`200 ${WHEEL_SIZE}`)

      // The status code and curl's own byte count are what a truncation
      // bug can still get right — the response frame ends early but
      // cleanly. The independent check is reading the file back and
      // hashing what actually landed on disk.
      const bytes = await Bun.file(out).arrayBuffer()
      expect(bytes.byteLength).toBe(WHEEL_SIZE)
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(WHEEL_SHA256)
    } finally {
      host.stop()
    }
  }, 120_000)
})
