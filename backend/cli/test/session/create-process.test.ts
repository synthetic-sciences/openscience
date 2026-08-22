import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

const fixture = path.join(import.meta.dir, "../fixture/session-create-process.ts")

async function wait(filepath: string) {
  const deadline = Date.now() + 10_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

function child(directory: string, sessionID: string, title: string, ready: string, start: string) {
  return spawn([process.execPath, fixture, directory, sessionID, title, ready, start], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function result(proc: ReturnType<typeof child>) {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Session-create worker exited ${code}: ${stderr}`)
  const line = stdout
    .trim()
    .split("\n")
    .findLast((item) => item.startsWith("{"))
  if (!line) throw new Error(`Session-create worker returned no JSON: ${stdout}\n${stderr}`)
  return JSON.parse(line) as Session.Info
}

test("caller-supplied session IDs are idempotent across processes", async () => {
  await using tmp = await tmpdir({ git: true })
  const id = Identifier.descending("session")
  await Instance.provide({ directory: tmp.path, fn: async () => Instance.project.id })
  const readyA = path.join(tmp.path, "create-a.ready")
  const readyB = path.join(tmp.path, "create-b.ready")
  const start = path.join(tmp.path, "create.start")
  const first = child(tmp.path, id, "First contender", readyA, start)
  const second = child(tmp.path, id, "Second contender", readyB, start)
  try {
    await Promise.all([wait(readyA), wait(readyB)])
    await fs.writeFile(start, "start")
    const [a, b] = await Promise.all([result(first), result(second)])
    expect(b).toEqual(a)
    expect(a.id).toBe(id)
    expect(["First contender", "Second contender"]).toContain(a.title)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessions = []
        for await (const session of Session.list()) {
          if (session.id === id) sessions.push(session)
        }
        expect(sessions).toHaveLength(1)
        await Session.remove(id)
      },
    })
  } finally {
    first.kill()
    second.kill()
    await Promise.all([first.exited.catch(() => undefined), second.exited.catch(() => undefined)])
  }
}, 20_000)
