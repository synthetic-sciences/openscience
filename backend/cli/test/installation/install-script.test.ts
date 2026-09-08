import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.join(__dirname, "../../../../install")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The installer is driven with shims for the host probes it runs before any
// network access, so the guards can be exercised on every development host.
async function install(shims: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openscience-install-script-"))
  roots.push(root)
  const bin = path.join(root, "bin")
  await Bun.write(path.join(bin, ".keep"), "")
  for (const [name, body] of Object.entries(shims)) {
    const file = path.join(bin, name)
    await writeFile(file, `#!/bin/sh\n${body}\n`)
    await chmod(file, 0o755)
  }
  const proc = Bun.spawn(["bash", script], {
    env: { ...process.env, HOME: path.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, output: stdout + stderr }
}

const linuxArm64 = 'case "$1" in -m) echo aarch64 ;; *) echo Linux ;; esac'
// Stands in for the GitHub release lookup so a run that passes the guards
// stops at the version fetch instead of reaching the network.
const offline = "exit 22"

describe.skipIf(process.platform === "win32")("install script", () => {
  test("refuses Linux ARM64 kernels without 4 KB pages before downloading", async () => {
    const result = await install({ uname: linuxArm64, getconf: "echo 16384", curl: offline })
    expect(result.code).toBe(1)
    expect(result.output).toContain("page size 16384 is unsupported")
    expect(result.output).toContain("4 KB pages")
    expect(result.output).toContain("https://github.com/oven-sh/bun/issues/17627")
    expect(result.output).not.toContain("Failed to fetch version information")
  })

  test("continues on 4 KB pages and when getconf is unavailable", async () => {
    for (const getconf of ["echo 4096", "exit 127"]) {
      const result = await install({ uname: linuxArm64, getconf, curl: offline })
      expect(result.output).not.toContain("is unsupported")
      expect(result.output).toContain("Failed to fetch version information")
      expect(result.code).toBe(1)
    }
  })
})
