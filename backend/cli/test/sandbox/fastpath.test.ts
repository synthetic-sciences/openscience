import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * The sandbox re-entry points must be answered before the process builds
 * anything of its own.
 *
 * This is not a style preference. The egress shim IS this binary, re-entered
 * inside the sandbox, where the user's data, config, state, log and bin
 * directories are not reachable — and `src/global/index.ts` creates all five in
 * a top-level await. ESM evaluates every static import before the importing
 * module's first statement, so the argv checks sitting at the top of
 * `src/index.ts` ran far too late to help:
 *
 *     EEXIST: file already exists, mkdir 'C:\Users\<user>\.local\state\openscience'
 *         at async <anonymous> (src/global/index.ts:105:15)
 *         at async <anonymous> (src/server/server.ts:43:1)
 *
 * The shim died during module evaluation, so the proxy it was supposed to serve
 * was a dead port and every network call inside the sandbox failed to resolve.
 *
 * The test makes the directories genuinely unwritable and asserts the entry
 * point still answers, which is the property; asserting import ORDER in the
 * source would pass just as happily on a graph that had grown a new heavyweight
 * import somewhere below.
 */

const root = process.getuid?.() === 0

test.if(!root)(
  "a sandbox re-entry point answers without building the user's directories",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-fastpath-"))
    const ro = path.join(dir, "ro")
    await fs.mkdir(ro)
    await fs.chmod(ro, 0o500)
    try {
      const entry = new URL("../../src/index.ts", import.meta.url).pathname
      const proc = Bun.spawn([process.execPath, entry, "__appcontainer-launch"], {
        // Every directory the boot path would create now lives somewhere it
        // cannot be created. If anything below the entry check runs, this exits
        // on EACCES instead of on the usage message.
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: ro,
          OPENSCIENCE_TEST_HOME: ro,
          XDG_DATA_HOME: path.join(ro, "data"),
          XDG_CACHE_HOME: path.join(ro, "cache"),
          XDG_CONFIG_HOME: path.join(ro, "config"),
          XDG_STATE_HOME: path.join(ro, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const err = await new Response(proc.stderr).text()
      await proc.exited
      expect(err).toContain("__appcontainer-launch requires")
      expect(err).not.toContain("EACCES")
      expect(err).not.toContain("mkdir")
      expect(proc.exitCode).toBe(2)
    } finally {
      await fs.chmod(ro, 0o700).catch(() => {})
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  },
  60_000,
)

test("the re-entry points live in one module, not scattered through the CLI entry", async () => {
  // `src/index.ts` held them behind a comment asserting they ran first. A
  // comment cannot order an import graph, so the guarantee now comes from the
  // module being imported before anything heavy — and from the test above.
  const index = await Bun.file(new URL("../../src/index.ts", import.meta.url).pathname).text()
  expect(index).not.toContain('process.argv[2] === "__egress-shim"')
  expect(index).not.toContain('process.argv[2] === "__appcontainer-launch"')
  const before = index.slice(0, index.indexOf('import "./sandbox/fastpath"'))
  // Only the synced-env preload, which is synchronous, fully guarded, and has
  // to stay first for provider SDKs to see their keys at construction.
  expect(before.match(/^import .*/gm)).toEqual(['import "./openscience/preload-env"'])
})
