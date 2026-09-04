import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cli = path.join(import.meta.dir, "../../src/index.ts")
const username = "web-command-test"
const password = "web-command-test-password"

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-web-command-"))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_DISABLE_PROJECT_CONFIG: "1",
    OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "1",
    OPENSCIENCE_DISABLE_MODELS_FETCH: "1",
    OPENSCIENCE_DISABLE_AUTOUPDATE: "1",
    OPENSCIENCE_DISABLE_LSP_DOWNLOAD: "1",
    // The web command opens a browser unless it is told a restart already did.
    OPENSCIENCE_RESTARTED: "1",
    OPENSCIENCE_SERVER_USERNAME: username,
    OPENSCIENCE_SERVER_PASSWORD: password,
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }
  return { root, project, env }
}

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port
  await server.stop(true)
  return port
}

function spawn(args: string[], cwd: string, env: Record<string, string | undefined>) {
  return Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

async function waitForHealth(base: string, deadline: number) {
  if (Date.now() > deadline) return false
  const ok = await fetch(`${base}/global/health`)
    .then((response) => response.ok)
    .catch(() => false)
  if (ok) return true
  await Bun.sleep(100)
  return waitForHealth(base, deadline)
}

// Starts the workspace with the given arguments, returns the project the
// server chose, and shuts it down the way Ctrl+C would.
async function worktreeOf(args: string[]) {
  const { root, project, env } = await sandbox()
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn([...args.map((arg) => arg.replace("<project>", project)), "--port", String(port)], root, env)
  const stderr = new Response(proc.stderr).text()
  const stdout = new Response(proc.stdout).text()
  try {
    expect(await waitForHealth(base, Date.now() + 20_000)).toBe(true)
    const response = await fetch(`${base}/project/current`, {
      headers: { authorization: `Basic ${btoa(`${username}:${password}`)}` },
    })
    expect(response.status).toBe(200)
    const current = (await response.json()) as { worktree: string }
    return { worktree: current.worktree, project: await fs.realpath(project), stderr, stdout }
  } finally {
    proc.kill("SIGINT")
    await proc.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("openscience web project argument", () => {
  test("bare openscience <directory> opens the workspace in that directory", async () => {
    const result = await worktreeOf(["<project>"])
    expect(result.worktree).toBe(result.project)
    expect(await result.stderr).toContain("Web interface:")
    expect(await result.stdout).not.toContain("Commands:")
  }, 30_000)

  test("openscience web <directory> opens the workspace in that directory", async () => {
    const result = await worktreeOf(["web", "<project>"])
    expect(result.worktree).toBe(result.project)
    expect(await result.stderr).toContain("Web interface:")
  }, 30_000)

  test("a missing directory is an error, not a usage dump", async () => {
    const { root, project, env } = await sandbox()
    const missing = path.join(root, "missing")
    try {
      for (const args of [["web", missing], [missing]]) {
        const proc = spawn(args, project, env)
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        expect(code).toBe(1)
        expect(stderr).toContain(`Cannot open ${missing}: no such directory`)
        expect(stdout + stderr).not.toContain("Commands:")
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
