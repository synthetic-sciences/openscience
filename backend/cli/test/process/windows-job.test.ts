import { expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsJob } from "../../src/process/windows-job"

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

async function text(file: string, attempt = 0): Promise<string> {
  const value = await fs.readFile(file, "utf8").catch(() => undefined)
  if (value?.trim()) return value.trim()
  if (attempt >= 300) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return text(file, attempt + 1)
}

const fixture = path.resolve(import.meta.dir, "../fixture/windows-job.ts")

test("Windows Job Object limit buffer enables kill-on-close without breakaway flags", () => {
  const info = WindowsJob.limitsForTests()
  expect(info).toHaveLength(WindowsJob.EXTENDED_LIMIT_SIZE_X64)
  expect(info.readUInt32LE(WindowsJob.LIMIT_FLAGS_OFFSET_X64)).toBe(WindowsJob.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
  expect(info.readUInt32LE(WindowsJob.LIMIT_FLAGS_OFFSET_X64) & 0x00001800).toBe(0)
})

test("Windows Job Object names are local, random, and ledger-valid", () => {
  const first = WindowsJob.name("same-runtime", "first")
  const second = WindowsJob.name("same-runtime", "second")
  expect(WindowsJob.valid(first)).toBe(true)
  expect(WindowsJob.valid(second)).toBe(true)
  expect(first).not.toBe(second)
  expect(first).toMatch(/^Local\\OpenScience-[a-f0-9]{64}$/)
})

test("every durable Windows runtime launch uses the registration gate", async () => {
  const direct = [
    "src/pty/index.ts",
    "src/tool/biology/notebook.ts",
    "src/tool/notebook.ts",
    "src/tool/rkernel.ts",
    "src/lsp/server.ts",
    "src/compute/jobs.ts",
    "src/compute/modal/volume.ts",
    "src/provider/token-command.ts",
    "src/server/routes/settings/local.ts",
  ]
  for (const file of direct) {
    const source = await Bun.file(path.join(import.meta.dir, "../..", file)).text()
    expect(source, file).toContain("WindowsJobLauncher")
    expect(source, file).toContain(".release")
  }
  const commandRuntime = [
    "src/tool/bash.ts",
    "src/session/prompt.ts",
    "src/file/publication.ts",
    "src/file/science.ts",
    "src/format/index.ts",
    "src/server/routes/repo.ts",
  ]
  for (const file of commandRuntime) {
    const source = await Bun.file(path.join(import.meta.dir, "../..", file)).text()
    expect(source, file).toContain("CommandRuntime.wrap")
    expect(source, file).toContain(".release")
  }
  const registry = await Bun.file(path.join(import.meta.dir, "../../src/science/command/registry.ts")).text()
  expect(registry).toContain("WindowsJobLauncher.bind(process, options.windowsRelease)")
  const directLinuxOwners = [
    "src/auth/wellknown-command.ts",
    "src/compute/modal/volume.ts",
    "src/provider/token-command.ts",
    "src/server/routes/settings/local.ts",
  ]
  for (const file of directLinuxOwners) {
    const source = await Bun.file(path.join(import.meta.dir, "../..", file)).text()
    expect(source, file).toContain("WindowsJobLauncher.bind(")
  }
  const compute = await Bun.file(path.join(import.meta.dir, "../../src/compute/jobs.ts")).text()
  expect(compute.match(/WindowsJobLauncher\.bind\(/g)).toHaveLength(2)
  const authority = await Bun.file(path.join(import.meta.dir, "../../src/project/authority-process.ts")).text()
  const credentials = await Bun.file(path.join(import.meta.dir, "../../src/credentials/process-ledger.ts")).text()
  for (const source of [authority, credentials]) {
    expect(source).toContain("WindowsJob.assign({ id: input.id, pid: input.pid, expectedIdentity: processIdentity })")
    expect(source).toContain("WindowsJob.terminate")
    expect(source).toContain("windowsRelease")
    expect(source).toContain('process.platform === "win32" ? "Windows Job Object" : "macOS responsibility"')
  }
  const mcp = await Bun.file(path.join(import.meta.dir, "../../src/mcp/index.ts")).text()
  const launcher = await Bun.file(path.join(import.meta.dir, "../../src/mcp/group-launcher.ts")).text()
  expect(mcp).toContain("windowsRelease: launcher.release")
  expect(launcher).toContain("Timed out waiting for Windows Job Object ownership")
})

test.skipIf(process.platform !== "win32")(
  "Windows Job Object assignment rejects a reused or mismatched process identity",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    try {
      expect(() =>
        WindowsJob.assign({
          id: `mismatch-${crypto.randomUUID()}`,
          pid: child.pid,
          expectedIdentity: "0".repeat(64),
        }),
      ).toThrow("changed identity before Windows Job Object assignment")
      expect(WindowsJob.identity(child.pid)).toStartWith("win32:")
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  },
  10_000,
)

test.skipIf(process.platform !== "win32")(
  "named Windows Job Object contains descendants and cross-process termination reaps the tree",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-windows-job-"))
    const release = path.join(root, "release")
    const descendant = path.join(root, "descendant")
    const script = [
      'const fs = require("node:fs")',
      'const cp = require("node:child_process")',
      "const release = process.env.OPENSCIENCE_JOB_TEST_RELEASE",
      "const descendant = process.env.OPENSCIENCE_JOB_TEST_DESCENDANT",
      "const wait = () => {",
      "  if (!fs.existsSync(release)) return setTimeout(wait, 10)",
      '  const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      "  fs.writeFileSync(descendant, String(child.pid))",
      "  setInterval(() => {}, 1000)",
      "}",
      "wait()",
    ].join("\n")
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        OPENSCIENCE_JOB_TEST_RELEASE: release,
        OPENSCIENCE_JOB_TEST_DESCENDANT: descendant,
      },
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    let job: string | undefined
    let descendantPID = 0
    try {
      const identity = WindowsJob.identity(child.pid)
      expect(identity).toStartWith("win32:")
      job = WindowsJob.assign({
        id: `test-${crypto.randomUUID()}`,
        pid: child.pid,
        expectedIdentity: crypto.createHash("sha256").update(identity!).digest("hex"),
      })
      expect(WindowsJob.heldForTests(job)).toBe(true)
      expect(WindowsJob.contains(job, child.pid)).toBe(true)
      await fs.writeFile(release, "ready")
      descendantPID = Number(await text(descendant))
      expect(WindowsJob.contains(job, descendantPID)).toBe(true)
      const revoker = Bun.spawn([process.execPath, fixture, "terminate", job], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, stderr] = await Promise.all([revoker.exited, new Response(revoker.stderr).text()])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      expect(await gone(child.pid)).toBe(true)
      expect(await gone(descendantPID)).toBe(true)
      expect(WindowsJob.terminate(job)).toBe(true)
      expect(WindowsJob.heldForTests(job)).toBe(false)
    } finally {
      if (job && WindowsJob.heldForTests(job)) WindowsJob.terminate(job)
      child.kill("SIGKILL")
      if (descendantPID && !(await gone(descendantPID))) process.kill(descendantPID, "SIGKILL")
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)
