import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("a failed credential handler retries without replaying handlers that already succeeded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-credential-retry-"))
  const mutate = path.join(root, "mutate.ts")
  const worker = path.join(root, "worker.ts")
  const ready = path.join(root, "ready")
  const result = path.join(root, "result.json")
  const lifecycle = new URL("../../src/credentials/lifecycle.ts", import.meta.url).href
  await Bun.write(
    mutate,
    [
      `import { CredentialLifecycle } from ${JSON.stringify(lifecycle)}`,
      `await CredentialLifecycle.mutate("retry-test", async () => undefined)`,
    ].join("\n"),
  )
  await Bun.write(
    worker,
    [
      `import fs from "node:fs/promises"`,
      `import { CredentialLifecycle } from ${JSON.stringify(lifecycle)}`,
      `await CredentialLifecycle.ensureFresh()`,
      `const counts = { refreshed: 0, revoked: 0 }`,
      `CredentialLifecycle.onRefresh(() => { counts.refreshed++ })`,
      `CredentialLifecycle.onRevoke(() => { counts.revoked++; if (counts.revoked === 1) throw new Error("retry once") })`,
      `CredentialLifecycle.watch(25)`,
      `await fs.writeFile(${JSON.stringify(ready)}, "ready")`,
      `for (const _ of Array.from({ length: 500 })) { if (counts.revoked >= 2) break; await Bun.sleep(10) }`,
      `await CredentialLifecycle.ensureFresh()`,
      `CredentialLifecycle.stopWatching()`,
      `await fs.writeFile(${JSON.stringify(result)}, JSON.stringify(counts))`,
    ].join("\n"),
  )
  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: root,
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
  const run = async (args: string[]) => {
    const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" })
    const [exit, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (exit !== 0) throw new Error(error)
  }

  try {
    const live = Bun.spawn([process.execPath, worker], { env, stdout: "pipe", stderr: "pipe" })
    for (const _ of Array.from({ length: 400 })) {
      if (await Bun.file(ready).exists()) break
      await Bun.sleep(10)
    }
    expect(await Bun.file(ready).exists()).toBe(true)
    await run([process.execPath, mutate])
    const [exit, error] = await Promise.all([live.exited, new Response(live.stderr).text()])
    if (exit !== 0) throw new Error(error)
    expect(await Bun.file(result).json()).toEqual({ refreshed: 1, revoked: 2 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
