import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { DarwinResponsibility } from "../../src/process/darwin-responsibility"
import {
  DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX,
  DarwinResponsibilityLauncher,
} from "../../src/process/darwin-responsibility-launcher"

async function text(file: string, attempt = 0): Promise<string> {
  const value = await fs.readFile(file, "utf8").catch(() => undefined)
  if (value?.trim()) return value.trim()
  if (attempt >= 300) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return text(file, attempt + 1)
}

async function gone(pid: number, attempt = 0): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  if (attempt >= 300) return false
  await Bun.sleep(10)
  return gone(pid, attempt + 1)
}

async function independentRoot(pid: number, attempt = 0): Promise<void> {
  if (DarwinResponsibility.responsible(pid) === pid && DarwinResponsibility.unique(pid)) return
  if (attempt >= 500) throw new Error(`Timed out waiting for responsibility root ${pid}`)
  await Bun.sleep(10)
  return independentRoot(pid, attempt + 1)
}

test.skipIf(process.platform !== "darwin")(
  "SIGTERM before the Darwin activation gate cannot default-kill the responsibility root",
  async () => {
    expect(DarwinResponsibility.available()).toBe(true)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-darwin-responsibility-signal-"))
    const payload = path.join(root, "payload-ran")
    const latchReady = path.join(root, "latch-ready")
    const wrapped = DarwinResponsibilityLauncher.wrap({
      file: process.execPath,
      args: ["-e", `await Bun.write(${JSON.stringify(payload)}, "unsafe")`],
    })
    if (!wrapped.release) throw new Error("Darwin responsibility launch did not create a registration gate")
    const child = spawn(wrapped.file, wrapped.args, {
      cwd: path.resolve(import.meta.dir, "../.."),
      detached: true,
      env: {
        ...process.env,
        OPENSCIENCE_TEST_HOME: root,
        OPENSCIENCE_DARWIN_SUPERVISOR_TEST_READY: latchReady,
      },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    try {
      await fs.writeFile(wrapped.release, String(child.pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
      await independentRoot(child.pid!)
      // Stage two has installed its native latch and is blocked on the separate
      // activation marker. Signal before project code is admitted.
      expect(Number(await text(latchReady))).toBe(child.pid!)
      process.kill(child.pid!, "SIGTERM")
      const outcome = await exited
      expect(outcome.signal, stderr).toBeNull()
      expect(outcome.code, stderr).toBe(143)
      expect(await Bun.file(payload).exists()).toBe(false)
    } finally {
      child.kill("SIGKILL")
      await fs.rm(wrapped.release, { force: true })
      await fs.rm(`${wrapped.release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, { force: true })
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(process.platform !== "darwin")(
  "kernel responsibility tracks a setsid double-fork after it reparents to launchd",
  async () => {
    if (!Bun.which("python3")) return
    expect(DarwinResponsibility.available()).toBe(true)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-darwin-responsibility-"))
    const marker = path.join(root, "daemon.pid")
    const script = [
      "import os,time",
      "os.fork() and os._exit(0)",
      "os.setsid()",
      "os.fork() and os._exit(0)",
      `open(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))`,
      "time.sleep(120)",
    ].join(";")
    const supervisor = Bun.spawn(
      [
        "python3",
        "-c",
        `import subprocess,time; subprocess.Popen(['python3','-c',${JSON.stringify(script)}]); time.sleep(120)`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    let daemon = 0
    try {
      daemon = Number(await text(marker))
      expect(daemon).toBeGreaterThan(0)
      const owner = DarwinResponsibility.responsible(supervisor.pid)
      expect(owner).toBeGreaterThan(0)
      expect(DarwinResponsibility.responsible(daemon)).toBe(owner)
      expect(DarwinResponsibility.owns(owner!, daemon)).toBe(true)
      expect(DarwinResponsibility.members(owner!)).toContain(daemon)

      // The daemon completed both forks and now has launchd as PPID, so this
      // assertion exercises the exact case a PPID/PGID-only ledger loses.
      const proc = Bun.spawn(["/bin/ps", "-o", "ppid=", "-p", String(daemon)], { stdout: "pipe" })
      const ppid = Number((await new Response(proc.stdout).text()).trim())
      expect(await proc.exited).toBe(0)
      expect(ppid).toBe(1)
    } finally {
      if (daemon && !(await gone(daemon))) process.kill(daemon, "SIGKILL")
      supervisor.kill("SIGKILL")
      await supervisor.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)
