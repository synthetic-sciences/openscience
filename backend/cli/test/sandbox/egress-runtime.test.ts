import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { EgressRuntime } from "../../src/sandbox/egress-runtime"

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

test("the socket is created under the state directory, not the workspace", async () => {
  const { socket } = await EgressRuntime.ensure()
  // Not Bun.file(socket).exists(): Bun.file() only recognizes regular files,
  // and a unix socket is a distinct inode type (S_IFSOCK) — verified with an
  // isolated Bun.listen({ unix }) that Bun.file(...).exists() reports false
  // for it while fs.stat sees it fine. fs.stat is the correct check here.
  await expect(fs.stat(socket)).resolves.toBeDefined()
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
  const first = await EgressRuntime.ensure()

  const before = await proxyRequest(first.socket, authority)
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
    after = await proxyRequest(first.socket, authority)
  }
  expect(after).not.toContain("not on the sandbox allowlist")
  expect(after).toContain("Cannot reach")

  const second = await EgressRuntime.ensure()
  expect(second.socket).toBe(first.socket) // same proxy the whole time, not a restart
})
