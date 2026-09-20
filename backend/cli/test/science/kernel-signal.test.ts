import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { KernelProcessIdentity } from "../../src/science/kernel/process"

const kernelModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/science/kernel/process.ts")).href
const signalModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/process/shutdown-signal.ts")).href

/** Start a process that owns kernels and announces itself on stdout. */
async function host(script: string) {
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  const chunk = await reader.read()
  reader.releaseLock()
  expect(new TextDecoder().decode(chunk.value).trim()).toBe("ready")
  return {
    proc,
    async code() {
      const code = await Promise.race([proc.exited, Bun.sleep(2_000).then(() => undefined)])
      if (code === undefined) {
        proc.kill("SIGKILL")
        await proc.exited
      }
      return code
    },
  }
}

test("kernel cleanup handlers terminate the host process after SIGTERM", async () => {
  if (process.platform === "win32") return
  const running = await host(
    `const { KernelProcessIdentity } = await import(${JSON.stringify(kernelModule)}); KernelProcessIdentity.onExit(() => {}); console.log("ready"); await new Promise(() => {})`,
  )
  running.proc.kill("SIGTERM")
  expect(await running.code()).toBe(143)
})

test("a claimed signal reaches its owner, which still runs the kernel cleanup on its way out", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-signal-owner-"))
  const marker = path.join(root, "shutdown")
  try {
    // The claim comes first here, so the kernel hook is the later listener and
    // still has to see the signal owned. A server claims before any tool has
    // asked for a kernel, and the kernel hook installs whenever that happens.
    const running = await host(
      `const fs = await import("node:fs")
       const { ShutdownSignal } = await import(${JSON.stringify(signalModule)})
       const { KernelProcessIdentity } = await import(${JSON.stringify(kernelModule)})
       const stop = Promise.withResolvers()
       ShutdownSignal.claim(() => stop.resolve())
       KernelProcessIdentity.onExit(() => fs.appendFileSync(${JSON.stringify(marker)}, "kernels released\\n"))
       console.log("ready")
       await stop.promise
       fs.appendFileSync(${JSON.stringify(marker)}, "owner shut down\\n")
       process.exit(0)`,
    )
    running.proc.kill("SIGTERM")
    expect(await running.code()).toBe(0)
    expect((await fs.readFile(marker, "utf8")).trim().split("\n")).toEqual(["owner shut down", "kernels released"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a second signal is the impatient one: ownership ends with the first delivery", async () => {
  if (process.platform === "win32") return
  const running = await host(
    `const { KernelProcessIdentity } = await import(${JSON.stringify(kernelModule)})
     const { ShutdownSignal } = await import(${JSON.stringify(signalModule)})
     KernelProcessIdentity.onExit(() => {})
     ShutdownSignal.claim(() => {})
     console.log("ready")
     await new Promise(() => {})`,
  )
  running.proc.kill("SIGTERM")
  await Bun.sleep(200)
  // The owner took the first delivery and is free to take as long as it needs.
  expect(running.proc.exitCode).toBe(null)
  running.proc.kill("SIGTERM")
  expect(await running.code()).toBe(143)
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
