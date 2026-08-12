import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
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
