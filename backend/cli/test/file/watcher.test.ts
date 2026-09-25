import { expect, test } from "bun:test"
import path from "node:path"

test("native watcher publishes changes and respects configured and built-in ignores", async () => {
  // Isolate the native loader and instance cache from tests that initialize the
  // server with file watching disabled or without the compiled libc constant.
  const child = Bun.spawn([process.execPath, "test", "--timeout", "12000", "./test/fixture/native-watcher.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 13_000,
    killSignal: "SIGKILL",
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? undefined : stdout + stderr }).toEqual({ code: 0, output: undefined })
    expect(stderr).toContain("1 pass")
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
})
