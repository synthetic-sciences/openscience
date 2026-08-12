import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const posixTest = process.platform === "win32" ? test.skip : test
const fixture = path.resolve(import.meta.dir, "../fixture/kernel-built-in-setsid.ts")

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
