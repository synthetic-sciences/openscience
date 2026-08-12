import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DarwinResponsibility } from "../../src/process/darwin-responsibility"

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
