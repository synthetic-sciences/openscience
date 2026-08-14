import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessIdentity } from "../../src/process/process-identity"

const fixture = path.resolve(import.meta.dir, "../fixture/runtime-events-process.ts")
const cwd = path.resolve(import.meta.dir, "../..")

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
    OPENSCIENCE_CONFIG_CONTENT: JSON.stringify({ sandbox: { enabled: false } }),
  }
}

async function waitJson<T>(file: string, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value) return value as T
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

async function run(root: string, workspace: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, fixture, args[0]!, workspace, ...args.slice(1)], {
    cwd,
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`fixture ${args[0]} exited ${code}: ${stderr}`)
}

async function setup(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-runtime-owner-${name}-`))
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: workspace, stdout: "ignore", stderr: "pipe" })
  if (git.exitCode !== 0) throw new Error(new TextDecoder().decode(git.stderr))
  return { root, workspace }
}

test("a foreign process cannot cancel or replace a live runtime owner", async () => {
  const { root, workspace } = await setup("foreign")
  const sessionID = "ses_runtime_owner_foreign"
  const runID = "run_runtime_owner_foreign"
  const ready = path.join(root, "owner.json")
  const command = path.join(root, "owner.command")
  const contender = path.join(root, "contender.json")
  const owner = Bun.spawn([process.execPath, fixture, "owner", workspace, sessionID, runID, ready, command], {
    cwd,
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const identity = await waitJson<{ pid: number; identity: string }>(ready)
    await run(root, workspace, "cancel-and-begin", sessionID, runID, contender)
    const result = await waitJson<{
      result: { status: string; runID: string }
      begin: string
      replay: { events: Array<{ type: string }> }
    }>(contender)
    expect(result.result).toEqual({ status: "foreign_owner", runID })
    expect(result.begin).toBe("active")
    expect(result.replay.events.map((event) => event.type)).toEqual(["runtime.accepted"])
    expect(await ProcessIdentity.owns(identity.pid, identity.identity)).toBe(true)

    await Bun.write(command, "cancel")
    await owner.exited
    const local = await waitJson<{
      result: { status: string; runID: string; owner: string }
      replay: { events: Array<{ type: string }> }
    }>(ready)
    expect(local.result).toEqual({ status: "cancelled", runID, owner: "local" })
    expect(local.replay.events.map((event) => event.type)).toEqual(["runtime.accepted", "runtime.cancelled"])
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a foreign stop request is durably applied by the live owner", async () => {
  const { root, workspace } = await setup("forward")
  const sessionID = "ses_runtime_owner_forward"
  const runID = "run_runtime_owner_forward"
  const ownerFile = path.join(root, "owner.json")
  const requestFile = path.join(root, "request.json")
  const owner = Bun.spawn([process.execPath, fixture, "watch-owner", workspace, sessionID, runID, ownerFile], {
    cwd,
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    await waitJson(ownerFile)
    await run(root, workspace, "request-cancel", sessionID, runID, requestFile)
    const requested = await waitJson<{ result: { status: string; runID: string } }>(requestFile)
    expect(requested.result).toEqual({ status: "forwarded", runID })
    await owner.exited
    const applied = await waitJson<{
      result: { status: string; runID: string; owner: string }
      replay: { events: Array<{ type: string; properties: Record<string, unknown> }> }
    }>(ownerFile)
    expect(applied.result).toEqual({ status: "cancelled", runID, owner: "local" })
    expect(applied.replay.events.at(-1)).toMatchObject({
      type: "runtime.cancelled",
      properties: { source: "user" },
    })
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a contender recovers only after the exact runtime owner has died", async () => {
  const { root, workspace } = await setup("stale")
  const sessionID = "ses_runtime_owner_stale"
  const runID = "run_runtime_owner_stale"
  const ready = path.join(root, "owner.json")
  const recovered = path.join(root, "recovered.json")
  const owner = Bun.spawn([process.execPath, fixture, "owner", workspace, sessionID, runID, ready], {
    cwd,
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const identity = await waitJson<{ pid: number; identity: string }>(ready)
    expect(await ProcessIdentity.owns(identity.pid, identity.identity)).toBe(true)
    owner.kill("SIGKILL")
    await owner.exited
    expect(await ProcessIdentity.owns(identity.pid, identity.identity)).toBe(false)

    const replacement = `${runID}_replacement`
    await run(root, workspace, "begin", sessionID, replacement, recovered)
    const result = await waitJson<{
      replay: { events: Array<{ runID: string; type: string; properties: Record<string, unknown> }> }
    }>(recovered)
    expect(result.replay.events).toMatchObject([
      { runID, type: "runtime.accepted" },
      { runID, type: "runtime.failed", properties: { recovered: true } },
      { runID: replacement, type: "runtime.accepted" },
    ])
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a durable stop request survives an owner crash without releasing the live owner early", async () => {
  const { root, workspace } = await setup("stop-crash")
  const sessionID = "ses_runtime_owner_stop_crash"
  const runID = "run_runtime_owner_stop_crash"
  const ready = path.join(root, "owner.json")
  const requested = path.join(root, "request.json")
  const recovered = path.join(root, "recovered.json")
  const owner = Bun.spawn([process.execPath, fixture, "owner", workspace, sessionID, runID, ready], {
    cwd,
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const identity = await waitJson<{ pid: number; identity: string }>(ready)
    await run(root, workspace, "request-cancel", sessionID, runID, requested)
    expect((await waitJson<{ result: { status: string; runID: string } }>(requested)).result).toEqual({
      status: "forwarded",
      runID,
    })
    expect(await ProcessIdentity.owns(identity.pid, identity.identity)).toBe(true)

    owner.kill("SIGKILL")
    await owner.exited
    const replacement = `${runID}_replacement`
    await run(root, workspace, "begin", sessionID, replacement, recovered)
    const result = await waitJson<{
      replay: { events: Array<{ runID: string; type: string; properties: Record<string, unknown> }> }
    }>(recovered)
    expect(result.replay.events).toMatchObject([
      { runID, type: "runtime.accepted" },
      { runID, type: "runtime.cancelled", properties: { source: "user", recovered: true } },
      { runID: replacement, type: "runtime.accepted" },
    ])
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
