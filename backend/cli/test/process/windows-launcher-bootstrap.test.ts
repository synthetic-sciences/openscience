import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsJobLauncher, WINDOWS_JOB_LAUNCHER_ARG } from "../../src/process/windows-job-launcher"

test("Windows command helper starts without loading or migrating application data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "windows-launcher-bootstrap-"))
  const release = path.join(root, "release")
  const invalidData = path.join(root, "data-is-a-file")
  await fs.writeFile(invalidData, "do not initialize application storage", "utf8")
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../src/bootstrap.ts"),
      WINDOWS_JOB_LAUNCHER_ARG,
      release,
      "0",
      process.execPath,
      "-e",
      'console.log("payload-started")',
    ],
    {
      env: {
        ...process.env,
        OPENSCIENCE_DATA_DIR: invalidData,
        OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "share"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENSCIENCE_DESKTOP_PARENT_PID: undefined,
        OPENSCIENCE_DESKTOP_PARENT_TOKEN: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    await WindowsJobLauncher.release(release, child.pid)
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, stderr).toBe(0)
    expect(stdout.trim()).toBe("payload-started")
    expect(await fs.readFile(invalidData, "utf8")).toBe("do not initialize application storage")
    expect(await fs.stat(path.join(root, "config")).catch(() => undefined)).toBeUndefined()
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("Windows helper forwards piped stdin received before gate release", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "windows-launcher-stdin-"))
  const release = path.join(root, "release")
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../src/bootstrap.ts"),
      WINDOWS_JOB_LAUNCHER_ARG,
      release,
      "0",
      process.execPath,
      "-e",
      'process.stdin.on("data", data => { console.log(data.toString().trim()); process.exit(0) })',
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 5_000)
  try {
    child.stdin.write("early-kernel-input\n")
    await Bun.sleep(200)
    await WindowsJobLauncher.release(release, child.pid)
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, stderr).toBe(0)
    expect(stdout.trim()).toBe("early-kernel-input")
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 10_000)
