import { expect, test } from "bun:test"
import path from "node:path"
import { DESKTOP_STOP_DEADLINE_MS, STOP_DEADLINE_MS, STOP_TIMED_OUT } from "../../src/cli/server-stop"
import { spawn } from "../fixture/spawn"
import { tmpdir } from "../fixture/fixture"

const fixture = path.resolve(import.meta.dir, "../fixture/server-stop-process.ts")

async function stopping(...args: string[]) {
  const child = spawn([process.execPath, fixture, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("a runtime that will not release warns and still leaves a clean stop", async () => {
  await using tmp = await tmpdir({ git: true })
  const stopped = await stopping("dispose-failure", tmp.path)

  // The stop was asked for and the process is leaving either way, so a
  // supervisor must not read it as a failed unit.
  expect(stopped.code).toBe(0)
  expect(stopped.stdout).toContain("stopped")
  // The error stays inside the command instead of reaching the CLI's fatal
  // path, which has no branch for it and would print this banner.
  expect(stopped.stderr).not.toContain("Unexpected error")
  expect(stopped.stderr).toContain("OpenScience could not release every active runtime")
  // Named, not buried: the innermost reason is the only layer that says which
  // runtime refused.
  expect(stopped.stderr).toContain("the kernel ledger is still busy")
}, 30_000)

test("the deadline bounds the whole stop, not only the command that started it", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "kernels")
  const started = Date.now()
  // The fixture hangs *after* stopServer returns, which is where the usage
  // drain, the data-root disposal and the log flush run for real.
  const stopped = await stopping("deadline", "700", marker)

  expect(stopped.stdout).toContain("stopped")
  expect(stopped.code).toBe(STOP_TIMED_OUT)
  expect(Date.now() - started).toBeLessThan(10_000)
  // The deadline ends the process through `process.exit`, so the kernel
  // children are reaped even when the stop never finished.
  expect(await Bun.file(marker).text()).toContain("kernels released")
}, 30_000)

test("a desktop sidecar leaves before the shell that is waiting for it gives up", async () => {
  const shell = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const drain = shell.slice(shell.indexOf("async function drainService"), shell.indexOf('service.kill("SIGKILL")'))
  const patience = Number(/waitForExit\(service, ([\d_]+)\)/.exec(drain)?.[1]?.replace(/_/g, ""))

  // A SIGKILL runs no `exit` hook, so a sidecar still draining when the shell
  // loses patience orphans the kernel children it spawned. Its own deadline
  // has to come first: that one ends the process through `process.exit`, which
  // runs the hooks.
  expect(patience).toBeGreaterThan(0)
  expect(DESKTOP_STOP_DEADLINE_MS).toBeLessThan(patience)
  expect(DESKTOP_STOP_DEADLINE_MS).toBeLessThan(STOP_DEADLINE_MS)
})
