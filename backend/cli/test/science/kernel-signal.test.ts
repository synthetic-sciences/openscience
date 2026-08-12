import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { KernelProcessIdentity } from "../../src/science/kernel/process"

test("kernel cleanup handlers terminate the host process after SIGTERM", async () => {
  if (process.platform === "win32") return
  const module = pathToFileURL(path.resolve(import.meta.dir, "../../src/science/kernel/process.ts")).href
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { KernelProcessIdentity } = await import(${JSON.stringify(module)}); KernelProcessIdentity.onExit(() => {}); console.log("ready"); await new Promise(() => {})`,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const reader = proc.stdout.getReader()
  const chunk = await reader.read()
  reader.releaseLock()
  expect(new TextDecoder().decode(chunk.value).trim()).toBe("ready")

  proc.kill("SIGTERM")
  const code = await Promise.race([proc.exited, Bun.sleep(2_000).then(() => undefined)])
  if (code === undefined) {
    proc.kill("SIGKILL")
    await proc.exited
  }
  expect(code).toBe(143)
})

test("persisted kernel identity reaps the exact orphan without trusting a reused PID", async () => {
  if (process.platform === "win32") return
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
  const identity = KernelProcessIdentity.capture(child)
  expect(identity).toBeDefined()
  expect(identity?.token).toHaveLength(64)
  expect(identity?.token).toBe(await AuthorityProcessLedger.identity(child.pid!))
  expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(true)
  expect(await KernelProcessIdentity.terminate({ ...identity!, token: `${identity!.token}-wrong` })).toBe(false)
  expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(true)
  expect(await KernelProcessIdentity.terminate(identity)).toBe(true)
  expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(false)
})
