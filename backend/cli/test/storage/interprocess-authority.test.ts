import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LockCoordination } from "../../src/util/lock-coordination"
import { tmpdir } from "../fixture/fixture"

const runner = path.resolve(import.meta.dir, "../fixture/authority-process.ts")

function environment(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: root,
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  }
}

async function run(root: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, runner, ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (exit !== 0) throw new Error(`child ${args[0]} exited ${exit}: ${stderr}`)
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function wait(filepath: string) {
  return waitFor(() => Bun.file(filepath).exists(), filepath)
}

test("storage mutations and authority signals cross real process boundaries", async () => {
  await using tmp = await tmpdir()
  await run(tmp.path, "init")

  await Promise.all([run(tmp.path, "update", "40"), run(tmp.path, "update", "40")])
  const counter = await Bun.file(path.join(tmp.path, "data", "storage", "interprocess", "counter.json")).json()
  expect(counter).toEqual({ count: 80 })

  const ready = path.join(tmp.path, "watch-ready")
  const result = path.join(tmp.path, "watch-result.json")
  const watcher = Bun.spawn([process.execPath, runner, "watch", ready, result], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await Bun.file(ready).exists()) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(await Bun.file(ready).exists()).toBe(true)
  await run(tmp.path, "publish", "project-cross-process")
  const [exit, stderr] = await Promise.all([watcher.exited, new Response(watcher.stderr).text()])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  expect(await fs.readFile(result, "utf8").then(JSON.parse)).toMatchObject({
    type: "event",
    event: { kind: "trust", projectID: "project-cross-process", denied: true },
  })
}, 15_000)

test("a storage waiter preserves a live stale lock and reclaims it after its process dies", async () => {
  await using tmp = await tmpdir()
  const name = `dead-owner-${crypto.randomUUID()}`
  const ready = path.join(tmp.path, "storage-owner-ready")
  const done = path.join(tmp.path, "storage-waiter-done")
  const holder = Bun.spawn([process.execPath, runner, "hold-storage", name, ready], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  await wait(ready)
  const lockfile = path.join(tmp.path, "data", "storage", "interprocess", `${name}.json.lock`)
  const old = new Date(Date.now() - 31_000)
  await fs.utimes(lockfile, old, old)

  const waiter = Bun.spawn([process.execPath, runner, "write-storage", name, done], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  await Bun.sleep(150)
  expect(await Bun.file(done).exists()).toBe(false)

  holder.kill("SIGKILL")
  await holder.exited
  const [exit, stderr] = await Promise.all([waiter.exited, new Response(waiter.stderr).text()])
  expect(exit).toBe(0)
  expect(stderr).not.toContain("ERROR")
  expect(await Bun.file(done).text()).toBe("written")
  expect(await Bun.file(path.join(tmp.path, "data", "storage", "interprocess", `${name}.json`)).json()).toEqual({
    recovered: true,
  })
}, 15_000)

test("a fresh malformed storage lock stays put but becomes reclaimable when stale", async () => {
  await using tmp = await tmpdir()
  const name = `malformed-${crypto.randomUUID()}`
  const lockfile = path.join(tmp.path, "data", "storage", "interprocess", `${name}.json.lock`)
  const blocked = path.join(tmp.path, "malformed-blocked-done")
  const recovered = path.join(tmp.path, "malformed-recovered-done")
  await fs.mkdir(path.dirname(lockfile), { recursive: true })
  await Bun.write(lockfile, "not-json")

  const waiter = Bun.spawn([process.execPath, runner, "write-storage", name, blocked], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  await Bun.sleep(150)
  expect(await Bun.file(blocked).exists()).toBe(false)
  expect(await Bun.file(lockfile).text()).toBe("not-json")
  waiter.kill("SIGKILL")
  await waiter.exited

  const old = new Date(Date.now() - 31_000)
  await fs.utimes(lockfile, old, old)
  await run(tmp.path, "write-storage", name, recovered)
  expect(await Bun.file(recovered).text()).toBe("written")
  expect(await Bun.file(lockfile).exists()).toBe(false)
}, 15_000)

test("competing reclaimers cannot remove a newly acquired storage lock", async () => {
  await using tmp = await tmpdir()
  const name = `aba-${crypto.randomUUID()}`
  const lockfile = path.join(tmp.path, "data", "storage", "interprocess", `${name}.json.lock`)
  const processes = new Set<ReturnType<typeof Bun.spawn>>()
  const spawn = (mode: string, ...args: string[]) => {
    const proc = Bun.spawn([process.execPath, runner, mode, ...args], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment(tmp.path),
      stdout: "pipe",
      stderr: "pipe",
    })
    processes.add(proc)
    return proc
  }
  const done = (label: string) => path.join(tmp.path, `${label}.done`)
  try {
    const deadReady = path.join(tmp.path, "aba-dead.ready")
    const dead = spawn("hold-storage", name, deadReady)
    await wait(deadReady)
    dead.kill("SIGKILL")
    await dead.exited

    const intentReady = path.join(tmp.path, "aba-intent.ready")
    const intent = spawn("hold-storage-intent", name, intentReady)
    await wait(intentReady)

    const first = spawn("write-storage", name, done("aba-first"))
    const claims = LockCoordination.directory(lockfile, "claim")
    await waitFor(
      () =>
        fs
          .readdir(claims)
          .then((items) => items.length > 0)
          .catch(() => false),
      "the first reclaimer claim",
    )
    process.kill(first.pid, "SIGSTOP")
    intent.kill("SIGKILL")
    await intent.exited

    const second = spawn("write-storage", name, done("aba-second"))
    await waitFor(
      () =>
        Bun.file(lockfile)
          .exists()
          .then((exists) => !exists),
      "the dead lock removal",
    )
    const third = spawn("write-storage", name, done("aba-third"))
    await Bun.sleep(150)
    expect(
      await Promise.all(
        [done("aba-first"), done("aba-second"), done("aba-third")].map((file) => Bun.file(file).exists()),
      ),
    ).toEqual([false, false, false])
    expect(await Bun.file(lockfile).exists()).toBe(false)

    process.kill(first.pid, "SIGCONT")
    const exits = await Promise.all([first.exited, second.exited, third.exited])
    expect(exits).toEqual([0, 0, 0])
    expect(
      await Promise.all(
        [done("aba-first"), done("aba-second"), done("aba-third")].map((file) => Bun.file(file).text()),
      ),
    ).toEqual(["written", "written", "written"])
    expect(await Bun.file(lockfile).exists()).toBe(false)
    expect(await fs.readdir(LockCoordination.directory(lockfile, "claim"))).toEqual([])
    expect(await fs.readdir(LockCoordination.directory(lockfile, "intent"))).toEqual([])
  } finally {
    for (const proc of processes) {
      try {
        process.kill(proc.pid, "SIGCONT")
      } catch {}
      proc.kill()
    }
    await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
  }
}, 20_000)

test("a stale storage observer revalidates before replacing a new live owner", async () => {
  await using tmp = await tmpdir()
  const name = `revalidate-${crypto.randomUUID()}`
  const lockfile = path.join(tmp.path, "data", "storage", "interprocess", `${name}.json.lock`)
  const processes = new Set<ReturnType<typeof Bun.spawn>>()
  const spawn = (mode: string, ...args: string[]) => {
    const proc = Bun.spawn([process.execPath, runner, mode, ...args], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment(tmp.path),
      stdout: "pipe",
      stderr: "pipe",
    })
    processes.add(proc)
    return proc
  }
  try {
    const deadReady = path.join(tmp.path, "revalidate-dead.ready")
    const dead = spawn("hold-storage", name, deadReady)
    await wait(deadReady)
    dead.kill("SIGKILL")
    await dead.exited

    const intentReady = path.join(tmp.path, "revalidate-intent.ready")
    const intent = spawn("hold-storage-intent", name, intentReady)
    await wait(intentReady)

    const done = path.join(tmp.path, "revalidate-writer.done")
    const waiter = spawn("write-storage", name, done)
    const claims = LockCoordination.directory(lockfile, "claim")
    await waitFor(
      () =>
        fs
          .readdir(claims)
          .then((items) => items.length > 0)
          .catch(() => false),
      "the stale observer claim",
    )
    process.kill(waiter.pid, "SIGSTOP")
    intent.kill("SIGKILL")
    await intent.exited

    const replacementReady = path.join(tmp.path, "revalidate-replacement.ready")
    const replacement = spawn("replace-storage", name, replacementReady)
    await wait(replacementReady)
    const replacementOwner = await Bun.file(lockfile).json()
    expect(replacementOwner).toMatchObject({ pid: replacement.pid })

    process.kill(waiter.pid, "SIGCONT")
    await Bun.sleep(150)
    expect(await Bun.file(done).exists()).toBe(false)
    expect(await Bun.file(lockfile).json()).toEqual(replacementOwner)

    replacement.kill("SIGKILL")
    await replacement.exited
    expect(await waiter.exited).toBe(0)
    expect(await Bun.file(done).text()).toBe("written")
    expect(await Bun.file(lockfile).exists()).toBe(false)
  } finally {
    for (const proc of processes) {
      try {
        process.kill(proc.pid, "SIGCONT")
      } catch {}
      proc.kill()
    }
    await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
  }
}, 20_000)

test("authority lease remains held until an async critical section settles", async () => {
  await using tmp = await tmpdir()
  const ready = path.join(tmp.path, "lease-ready")
  const release = path.join(tmp.path, "lease-release")
  const acquired = path.join(tmp.path, "lease-acquired")
  const holder = Bun.spawn([process.execPath, runner, "hold", ready, release], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await Bun.file(ready).exists()) break
    await Bun.sleep(10)
  }
  expect(await Bun.file(ready).exists()).toBe(true)

  const waiter = Bun.spawn([process.execPath, runner, "acquire", acquired], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  await Bun.sleep(100)
  expect(await Bun.file(acquired).exists()).toBe(false)

  await Bun.write(release, "release")
  const [holderExit, waiterExit, holderError, waiterError] = await Promise.all([
    holder.exited,
    waiter.exited,
    new Response(holder.stderr).text(),
    new Response(waiter.stderr).text(),
  ])
  expect({ holderExit, waiterExit, holderError, waiterError }).toEqual({
    holderExit: 0,
    waiterExit: 0,
    holderError: "",
    waiterError: "",
  })
  expect(await Bun.file(acquired).text()).toBe("acquired")
}, 15_000)

test("a watcher replays an unacknowledged durable denial on startup", async () => {
  await using tmp = await tmpdir()
  await run(tmp.path, "publish", "project-pending-startup")
  const ready = path.join(tmp.path, "pending-watch-ready")
  const result = path.join(tmp.path, "pending-watch-result.json")
  const watcher = Bun.spawn([process.execPath, runner, "watch", ready, result], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: environment(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stderr] = await Promise.all([watcher.exited, new Response(watcher.stderr).text()])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  expect(await fs.readFile(result, "utf8").then(JSON.parse)).toMatchObject({
    type: "event",
    event: { kind: "trust", projectID: "project-pending-startup", denied: true },
  })
}, 15_000)

test("a newer mutation cannot erase an older unacknowledged cleanup", async () => {
  await using tmp = await tmpdir()
  await run(tmp.path, "publish", "project-first-pending")
  await run(tmp.path, "publish", "project-second-pending")

  const watch = async (projectID: string) => {
    const ready = path.join(tmp.path, `${projectID}-watch-ready`)
    const result = path.join(tmp.path, `${projectID}-watch-result.json`)
    const watcher = Bun.spawn([process.execPath, runner, "watch-project", projectID, ready, result], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment(tmp.path),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, stderr] = await Promise.all([watcher.exited, new Response(watcher.stderr).text()])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    return fs.readFile(result, "utf8").then(JSON.parse)
  }

  expect(await watch("project-second-pending")).toMatchObject({
    type: "event",
    revision: 2,
    event: { projectID: "project-second-pending" },
  })
  let signal = await Bun.file(path.join(tmp.path, "data", "storage", "authority", "revision.json")).json()
  expect(signal).toMatchObject({ revision: 2, pending: false })
  expect(signal.backlog).toEqual([
    expect.objectContaining({ revision: 1, event: expect.objectContaining({ projectID: "project-first-pending" }) }),
  ])

  expect(await watch("project-first-pending")).toMatchObject({
    type: "event",
    revision: 1,
    event: { projectID: "project-first-pending" },
  })

  signal = await Bun.file(path.join(tmp.path, "data", "storage", "authority", "revision.json")).json()
  expect(signal).toMatchObject({ revision: 2, pending: false, backlog: [] })
}, 15_000)
