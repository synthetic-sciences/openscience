import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AuthorityProcessLedger } from "../../src/project/authority-process"

const runner = path.resolve(import.meta.dir, "../fixture/authority-runtime-process.ts")
const cwd = path.resolve(import.meta.dir, "../..")

interface Setup {
  projectID: string
  sessionID: string
  grantID: string
  shell: string
  descendantFile: string
}

interface Entry {
  pid: number
  identity: string
  project_id: string
  session_id: string
  authority_generation: string
  sandboxed: boolean
  descendant: {
    pid: number
    identity: string
    pgid: number
    ppid: number
  }
}

function environment(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  }
}

async function run(root: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, runner, ...args], {
    cwd,
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`fixture ${args[0]} exited ${code}: ${stderr}`)
}

async function waitJson<T>(file: string, attempt = 0): Promise<T> {
  const value = await Bun.file(file)
    .json()
    .catch(() => undefined)
  if (value) return value as T
  if (attempt >= 300) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(20)
  return waitJson<T>(file, attempt + 1)
}

async function gone(entry: Pick<Entry, "pid" | "identity">, attempt = 0): Promise<boolean> {
  if (!(await AuthorityProcessLedger.owns(entry.pid, entry.identity))) return true
  if (attempt >= 200) return false
  await Bun.sleep(20)
  return gone(entry, attempt + 1)
}

async function scenario(kind: "pty" | "biology", action: "trust" | "filesystem" | "session") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-authority-${kind}-${action}-`))
  const workspace = path.join(root, "workspace")
  const setupFile = path.join(root, "setup.json")
  const ready = path.join(root, "ready.json")
  await fs.mkdir(workspace, { recursive: true })
  let owner: ReturnType<typeof Bun.spawn> | undefined
  let entry: Entry | undefined
  try {
    await run(root, "setup", workspace, setupFile)
    const setup = await waitJson<Setup>(setupFile)
    owner = Bun.spawn(
      [
        process.execPath,
        runner,
        `owner-${kind}`,
        workspace,
        ready,
        setup.sessionID,
        setup.grantID,
        setup.shell,
        setup.descendantFile,
      ],
      { cwd, env: environment(root), stdout: "pipe", stderr: "pipe" },
    )
    entry = await waitJson<Entry>(ready).catch(async (error) => {
      owner?.kill("SIGKILL")
      await owner?.exited
      const stderr = owner?.stderr instanceof ReadableStream ? await new Response(owner.stderr).text() : ""
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nowner stderr: ${stderr}`)
    })
    expect(entry.project_id).toBe(setup.projectID)
    expect(entry.session_id).toBe(setup.sessionID)
    expect(entry.authority_generation).toHaveLength(64)
    // The fixture intentionally exercises the default enforced sandbox. The
    // old project-config override was ineffective because sandbox policy is
    // trusted global/managed configuration, not project configuration.
    expect(entry.sandboxed).toBe(true)
    expect(await AuthorityProcessLedger.owns(entry.pid, entry.identity)).toBe(true)
    expect(await AuthorityProcessLedger.owns(entry.descendant.pid, entry.descendant.identity)).toBe(true)
    expect(entry.descendant.pgid).not.toBe(entry.pid)
    // A double-fork reparents to host init without a sandbox. Inside
    // bubblewrap it reparents to the namespace init, whose host PID remains a
    // descendant of the durable outer leader.
    if (process.platform === "linux" && entry.sandboxed) expect(entry.descendant.ppid).not.toBe(1)
    else expect(entry.descendant.ppid).toBe(1)

    owner.kill("SIGKILL")
    await owner.exited
    // Both fixtures ignore terminal hangup, so any death below must come from
    // the platform containment rather than directly from the killed server.
    const contained = process.platform === "darwin" || (process.platform === "linux" && entry.sandboxed)
    if (contained) {
      // The macOS responsibility supervisor and Linux bubblewrap namespace
      // observe owner death asynchronously. Prove their causal teardown to a
      // bounded deadline instead of treating 100 ms as a lifecycle contract.
      expect(await gone(entry)).toBe(true)
      expect(await gone(entry.descendant)).toBe(true)
    } else {
      await Bun.sleep(100)
      expect(await AuthorityProcessLedger.owns(entry.pid, entry.identity)).toBe(true)
    }

    await run(
      root,
      `revoke-${action}`,
      workspace,
      path.join(root, "unused"),
      setup.sessionID,
      setup.grantID,
      setup.shell,
    )
    expect(await gone(entry)).toBe(true)
    expect(await gone(entry.descendant)).toBe(true)
    expect(await Bun.file(path.join(root, "data", "authority-processes.json")).json()).toEqual([])
  } finally {
    if (owner) owner.kill("SIGKILL")
    if (entry && (await AuthorityProcessLedger.owns(entry.pid, entry.identity))) {
      await run(root, "reap", workspace, path.join(root, "unused"), "", "", "").catch(() => undefined)
    }
    if (entry?.descendant && (await AuthorityProcessLedger.owns(entry.descendant.pid, entry.descendant.identity))) {
      process.kill(entry.descendant.pid, "SIGKILL")
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("trust, filesystem, and session revocation reclaim PTY and biology children after owner SIGKILL", async () => {
  if (process.platform === "win32") return
  for (const kind of ["pty", "biology"] as const) {
    for (const action of ["trust", "filesystem", "session"] as const) await scenario(kind, action)
  }
}, 120_000)

test("installation-scope revocation reaps killed-owner children from another project", async () => {
  if (process.platform === "win32") return
  for (const kind of ["pty", "biology"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-authority-installation-${kind}-`))
    const workspaceA = path.join(root, "workspace-a")
    const workspaceB = path.join(root, "workspace-b")
    const setupAFile = path.join(root, "setup-a.json")
    const setupBFile = path.join(root, "setup-b.json")
    const ready = path.join(root, "ready.json")
    await Promise.all([fs.mkdir(workspaceA, { recursive: true }), fs.mkdir(workspaceB, { recursive: true })])
    let owner: ReturnType<typeof Bun.spawn> | undefined
    let entry: Entry | undefined
    try {
      await run(root, "setup-installation", workspaceA, setupAFile)
      await run(root, "setup", workspaceB, setupBFile)
      const setupA = await waitJson<Setup>(setupAFile)
      const setupB = await waitJson<Setup>(setupBFile)
      expect(setupB.projectID).not.toBe(setupA.projectID)
      owner = Bun.spawn(
        [
          process.execPath,
          runner,
          `owner-${kind}`,
          workspaceB,
          ready,
          setupB.sessionID,
          setupB.grantID,
          setupB.shell,
          setupB.descendantFile,
        ],
        { cwd, env: environment(root), stdout: "pipe", stderr: "pipe" },
      )
      entry = await waitJson<Entry>(ready)
      owner.kill("SIGKILL")
      await owner.exited

      await run(
        root,
        "revoke-filesystem",
        workspaceA,
        path.join(root, "unused"),
        setupA.sessionID,
        setupA.grantID,
        setupA.shell,
      )
      expect(await gone(entry)).toBe(true)
      expect(await gone(entry.descendant)).toBe(true)
      expect(await Bun.file(path.join(root, "data", "authority-processes.json")).json()).toEqual([])
    } finally {
      owner?.kill("SIGKILL")
      if (entry && (await AuthorityProcessLedger.owns(entry.pid, entry.identity))) {
        await run(root, "reap", workspaceB, path.join(root, "unused"), "", "", "").catch(() => undefined)
      }
      if (entry?.descendant && (await AuthorityProcessLedger.owns(entry.descendant.pid, entry.descendant.identity))) {
        process.kill(entry.descendant.pid, "SIGKILL")
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}, 60_000)

test("ledger refuses mismatched identities and POSIX children without private process groups", async () => {
  if (process.platform === "win32" || process.platform === "darwin") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-authority-safety-"))
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  try {
    const mismatch = path.join(root, "mismatch.json")
    await run(root, "mismatched-identity", workspace, mismatch)
    expect(await waitJson<{ killed: number; survived: boolean }>(mismatch)).toEqual({ killed: 0, survived: true })

    const group = path.join(root, "group.json")
    await run(root, "non-group", workspace, group)
    expect(await waitJson<{ error: string }>(group)).toMatchObject({
      error: expect.stringContaining("not its own process-group leader"),
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("normal leader exit reaps and verifies a surviving same-group child before completing", async () => {
  if (process.platform === "win32" || process.platform === "darwin") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-authority-leader-exit-"))
  const workspace = path.join(root, "workspace")
  const result = path.join(root, "result.json")
  await fs.mkdir(workspace, { recursive: true })
  try {
    await run(root, "leader-exit-grandchild", workspace, result)
    const outcome = await waitJson<{
      completed: boolean
      child: { pid: number; identity: string }
      survived: boolean
    }>(result)
    expect(outcome.completed).toBe(true)
    expect(outcome.survived).toBe(false)
    expect(await AuthorityProcessLedger.owns(outcome.child.pid, outcome.child.identity)).toBe(false)
    expect(await Bun.file(path.join(root, "data", "authority-processes.json")).json()).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "darwin")("Darwin authority registration rejects an unwrapped runtime", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    await expect(
      AuthorityProcessLedger.register({
        id: `authority-unwrapped-${crypto.randomUUID()}`,
        kind: "biology",
        pid: child.pid,
        projectID: "project-unwrapped",
        sessionID: "session-unwrapped",
        authorityGeneration: "unwrapped-generation",
      }),
    ).rejects.toThrow("macOS responsibility registration gate")
  } finally {
    process.kill(-child.pid, "SIGKILL")
    await child.exited
  }
})
