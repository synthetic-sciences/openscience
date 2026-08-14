import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { ProcessIdentity } from "../../src/process/process-identity"
import { WINDOWS_JOB_LAUNCHER_ARG, WindowsJobLauncher } from "../../src/process/windows-job-launcher"
import { Shell } from "../../src/shell/shell"

const python = Bun.which("python3")
const linuxTest = process.platform === "linux" && python ? test : test.skip

async function waitText(file: string, attempt = 0): Promise<string> {
  const value = await fs.readFile(file, "utf8").catch(() => undefined)
  if (value?.trim()) return value.trim()
  if (attempt >= 500) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return waitText(file, attempt + 1)
}

async function waitGone(pid: number, identity: string, attempt = 0): Promise<boolean> {
  if (!(await ProcessIdentity.owns(pid, identity))) return true
  if (attempt >= 500) return false
  await Bun.sleep(10)
  return waitGone(pid, identity, attempt + 1)
}

async function owner() {
  const identity = await ProcessIdentity.capture(process.pid)
  if (!identity) throw new Error("Could not capture the Linux test owner identity")
  return { pid: process.pid, identity }
}

linuxTest("immediate payload exits preserve their exact 0 and 127 statuses", async () => {
  for (const [file, args, expected] of [
    ["/bin/true", [], 0],
    ["/bin/sh", ["-c", "exit 127"], 127],
  ] as const) {
    const wrapped = WindowsJobLauncher.wrap({ file, args: [...args], linuxOwner: await owner() })
    if (!wrapped.release) throw new Error("Linux subreaper launch did not create a registration gate")
    const child = Bun.spawn([wrapped.file, ...wrapped.args], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "ignore",
      stderr: "pipe",
    })
    await WindowsJobLauncher.release(wrapped.release, child.pid)
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(expected)
  }
})

linuxTest("a forged launcher argv marker cannot opt a raw process out of ordinary group teardown", async () => {
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done", WINDOWS_JOB_LAUNCHER_ARG], {
    detached: true,
    stdio: "ignore",
  })
  try {
    await Bun.sleep(50)
    await Shell.killTree(child, { detached: true, exited: () => child.exitCode !== null || child.signalCode !== null })
    for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt++) {
      await Bun.sleep(10)
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
  }
})

linuxTest(
  "normal payload completion drains an adopted setsid double-fork before the launcher exits",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-subreaper-complete-"))
    const marker = path.join(root, "daemon.pid")
    const source = [
      "import os, sys, time",
      "if os.fork():",
      "    time.sleep(0.5)",
      "    os._exit(0)",
      "os.setsid()",
      "if os.fork(): os._exit(0)",
      `open(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))`,
      "time.sleep(600)",
    ].join("\n")
    const wrapped = WindowsJobLauncher.wrap({
      file: python!,
      args: ["-c", source],
      linuxOwner: await owner(),
    })
    if (!wrapped.release) throw new Error("Linux subreaper launch did not create a registration gate")
    const { OPENSCIENCE_SUBREAPER_TEST_INIT_FAILURE: _, ...env } = process.env
    const child = Bun.spawn([wrapped.file, ...wrapped.args], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "ignore",
      stderr: "pipe",
    })
    let daemonPID = 0
    let daemonIdentity: string | undefined
    try {
      await WindowsJobLauncher.release(wrapped.release, child.pid)
      daemonPID = Number(await waitText(marker))
      daemonIdentity = await ProcessIdentity.capture(daemonPID)
      expect(daemonIdentity).toMatch(/^[a-f0-9]{64}$/)
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(await waitGone(daemonPID, daemonIdentity!)).toBe(true)
    } finally {
      child.kill("SIGKILL")
      if (daemonPID && daemonIdentity && (await ProcessIdentity.owns(daemonPID, daemonIdentity))) {
        process.kill(daemonPID, "SIGKILL")
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)

linuxTest("subreaper initialization failure is fail-closed before the payload body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-subreaper-failure-"))
  const marker = path.join(root, "body-ran")
  const wrapped = WindowsJobLauncher.wrap({
    file: python!,
    args: ["-c", `open(${JSON.stringify(marker)}, 'w').write('unsafe')`],
    linuxOwner: await owner(),
  })
  const child = Bun.spawn([wrapped.file, ...wrapped.args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      OPENSCIENCE_TEST_HOME: root,
      OPENSCIENCE_SUBREAPER_TEST_INIT_FAILURE: "1",
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain("Injected Linux child-subreaper initialization failure")
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    child.kill("SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
})
