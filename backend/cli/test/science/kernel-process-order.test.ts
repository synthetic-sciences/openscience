import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const posixTest = process.platform === "win32" ? test.skip : test
const fixture = path.resolve(import.meta.dir, "../fixture/kernel-built-in-setsid.ts")

test("the relocation quarantine parses every ledger and requires Windows Job containment", async () => {
  const source = await fs.readFile(path.resolve(import.meta.dir, "../../src/project/authority-process.ts"), "utf8")
  const start = source.indexOf("export async function assertRelocationSafe")
  const end = source.indexOf("export function pathForTests", start)
  const policy = source.slice(start, end)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  expect(policy.indexOf("await read()")).toBeLessThan(policy.indexOf("process.platform"))
  expect(policy).toContain(': "windows_job_v1"')
  expect(policy).toContain('(process.platform === "win32" && !entry.windows_job)')
})

test("registered synchronous exit never raw-kills its containment anchor", async () => {
  const source = await fs.readFile(path.resolve(import.meta.dir, "../../src/science/kernel/process.ts"), "utf8")
  const start = source.indexOf("export function terminateSync")
  const end = source.indexOf("export async function complete", start)
  const handoff = source.slice(start, end)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  expect(handoff).toContain("if (!identity?.ownershipID) return false")
  expect(handoff).toContain('if (process.platform === "win32") return true')
  expect(handoff).not.toContain("Shell.kill")
})

posixTest("built-in registration cleanup keeps its lexical ID and fails closed on ledger errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-register-cleanup-"))
  const runner = path.join(root, "runner.ts")
  const processModule = new URL("../../src/science/kernel/process.ts", import.meta.url).href
  const ledgerModule = new URL("../../src/project/authority-process.ts", import.meta.url).href
  const [notebook, rkernel, identitySource] = await Promise.all([
    fs.readFile(path.resolve(import.meta.dir, "../../src/tool/notebook.ts"), "utf8"),
    fs.readFile(path.resolve(import.meta.dir, "../../src/tool/rkernel.ts"), "utf8"),
    fs.readFile(path.resolve(import.meta.dir, "../../src/science/kernel/process.ts"), "utf8"),
  ])
  expect(notebook).toContain("await this.terminate(proc, ownership?.id)")
  expect(rkernel).toContain("await this.terminate(proc, ownership?.id)")
  expect(identitySource).toContain("if (identity.ownershipID || revoked > 0)")
  await fs.writeFile(
    runner,
    `
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { KernelProcessIdentity } from ${JSON.stringify(processModule)}
import { AuthorityProcessLedger } from ${JSON.stringify(ledgerModule)}
const child = spawn(${JSON.stringify(Bun.which("sleep") || "/bin/sleep")}, ["30"], { detached: true, stdio: "ignore" })
const captured = KernelProcessIdentity.capture(child)
if (!captured) throw new Error("missing child identity")
const ledger = AuthorityProcessLedger.pathForTests()
await fs.mkdir(path.dirname(ledger), { recursive: true })
await fs.writeFile(ledger, "{corrupt")
let rejected = false
try {
  await KernelProcessIdentity.terminate({ ...captured, ownershipID: "kernel-cleanup-order-test" })
} catch {
  rejected = true
}
const alive = KernelProcessIdentity.matchesRecorded(captured)
await fs.writeFile(ledger, "[]")
try { process.kill(-captured.pid, "SIGKILL") } catch {}
console.log(JSON.stringify({ rejected, alive }))
`,
  )
  try {
    const proc = Bun.spawn([process.execPath, runner], {
      env: {
        ...process.env,
        OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
        OPENSCIENCE_TEST_HOME: path.join(root, "home"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config-xdg"),
        XDG_DATA_HOME: path.join(root, "data-xdg"),
        XDG_STATE_HOME: path.join(root, "state-xdg"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({ rejected: true, alive: true })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function scenario(language: "python" | "r") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-${language}-kernel-setsid-`))
  const workspace = path.join(root, "workspace")
  const marker = path.join(root, "descendant.pid")
  const config = path.join(root, "config")
  await Promise.all([fs.mkdir(workspace), fs.mkdir(config)])
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({ sandbox: { enabled: false } }))
  try {
    const proc = Bun.spawn([process.execPath, fixture, workspace, language, marker], {
      env: {
        ...process.env,
        OPENSCIENCE_CONFIG_CONTENT: JSON.stringify({ sandbox: { enabled: false } }),
        OPENSCIENCE_DATA_DIR: path.join(root, "data"),
        OPENSCIENCE_CONFIG_DIR: config,
        OPENSCIENCE_TEST_HOME: path.join(root, "home"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config-xdg"),
        XDG_DATA_HOME: path.join(root, "data-xdg"),
        XDG_STATE_HOME: path.join(root, "state-xdg"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    return JSON.parse(stdout.trim()) as {
      kernelPID: number
      childPID: number
      childPPID: number
      childPGID: number
      childAncestors: number[]
      survived: boolean
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

posixTest(
  "built-in Python release reaps a direct start_new_session child before killing the kernel leader",
  async () => {
    const result = await scenario("python")
    // On Darwin the durable responsibility supervisor is the recorded kernel
    // leader and the Python interpreter is its direct payload child. The
    // start_new_session worker must remain in that authenticated ancestry even
    // though it is no longer necessarily a direct child of the ledger leader.
    expect(result.childAncestors).toContain(result.kernelPID)
    expect(result.childPGID).toBe(result.childPID)
    expect(result.survived).toBe(false)
  },
  30_000,
)

test.skipIf(process.platform !== "darwin")(
  "graceful server exit cooperatively drains the Darwin supervisor responsibility",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-python-kernel-exit-sync-"))
    const workspace = path.join(root, "workspace")
    const marker = path.join(root, "descendant.pid")
    const ready = path.join(root, "ready.json")
    const config = path.join(root, "config")
    await Promise.all([fs.mkdir(workspace), fs.mkdir(config)])
    await fs.writeFile(path.join(config, "config.json"), JSON.stringify({ sandbox: { enabled: false } }))
    const owner = Bun.spawn([process.execPath, fixture, workspace, "python", marker, "wait-for-signal", ready], {
      env: {
        ...process.env,
        OPENSCIENCE_CONFIG_CONTENT: JSON.stringify({ sandbox: { enabled: false } }),
        OPENSCIENCE_DATA_DIR: path.join(root, "data"),
        OPENSCIENCE_CONFIG_DIR: config,
        OPENSCIENCE_TEST_HOME: path.join(root, "home"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config-xdg"),
        XDG_DATA_HOME: path.join(root, "data-xdg"),
        XDG_STATE_HOME: path.join(root, "state-xdg"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const waitReady = async (attempt = 0): Promise<{ kernelPID: number; childPID: number }> => {
      const value = await Bun.file(ready)
        .json()
        .catch(() => undefined)
      if (value) return value as { kernelPID: number; childPID: number }
      if (attempt >= 500) throw new Error(`Timed out waiting for ${ready}`)
      await Bun.sleep(10)
      return waitReady(attempt + 1)
    }
    const gone = async (pid: number, attempt = 0): Promise<boolean> => {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      if (attempt >= 500) return false
      await Bun.sleep(10)
      return gone(pid, attempt + 1)
    }
    try {
      const published = await waitReady()
      owner.kill("SIGTERM")
      const code = await owner.exited
      const stderr = await new Response(owner.stderr).text()
      expect(code, stderr).toBe(143)
      expect(await gone(published.childPID)).toBe(true)
      expect(await gone(published.kernelPID)).toBe(true)
    } finally {
      owner.kill("SIGKILL")
      await owner.exited.catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test.skipIf(process.platform === "win32" || !Bun.which("Rscript"))(
  "built-in R release reaps a different-process-group descendant before killing the kernel leader",
  async () => {
    const result = await scenario("r")
    expect(result.childAncestors).toContain(result.kernelPID)
    expect(result.childPGID).toBe(result.childPID)
    expect(result.survived).toBe(false)
  },
  30_000,
)
