import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DataRoot } from "@/global/data-root"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { WindowsJunction } from "@/global/windows-junction"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-data-root-"))
  roots.push(value)
  return value
}

describe("managed data root", () => {
  test("Windows junction reparse buffer carries a mount-point tag and two UTF-16 paths", () => {
    const target = "C:\\OpenScience Data"
    const data = WindowsJunction.bufferForTests(target)
    const substituteLength = data.readUInt16LE(10)
    const printOffset = data.readUInt16LE(12)
    const printLength = data.readUInt16LE(14)
    expect(data.readUInt32LE(0)).toBe(WindowsJunction.IO_REPARSE_TAG_MOUNT_POINT)
    expect(data.readUInt16LE(4)).toBe(data.length - 8)
    expect(data.toString("utf16le", 16, 16 + substituteLength)).toBe(`\\??\\${target}`)
    expect(data.toString("utf16le", 16 + printOffset, 16 + printOffset + printLength)).toBe(target)
  })

  test("switches every precomputed child path through one stable link", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const first = path.join(base, "first")
    const second = path.join(base, "second")
    await Promise.all([fs.mkdir(first), fs.mkdir(second)])
    const managed = await DataRoot.ensure(config, first, false)
    const record = path.join(managed.path, "storage", "record.json")
    await fs.mkdir(path.dirname(record), { recursive: true })
    await fs.writeFile(record, "first")

    await DataRoot.switchTo(managed.path, second)
    await fs.mkdir(path.dirname(record), { recursive: true })
    await fs.writeFile(record, "second")

    expect(await fs.readFile(path.join(first, "storage", "record.json"), "utf8")).toBe("first")
    expect(await fs.readFile(path.join(second, "storage", "record.json"), "utf8")).toBe("second")
    expect(await fs.realpath(managed.path)).toBe(await fs.realpath(second))
  })

  test("blocks new operations and drains existing operations before a switch", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const active = await DataRootBarrier.enter(path.join(managed.path, "record.json"))
    let exclusive = false
    const switching = DataRootBarrier.exclusive().then(async (lease) => {
      exclusive = true
      return lease
    })
    await Bun.sleep(50)
    expect(exclusive).toBe(false)

    await active[Symbol.asyncDispose]()
    const lease = await switching
    expect(exclusive).toBe(true)
    let entered = false
    const waiting = DataRootBarrier.enter(path.join(managed.path, "later.json")).then((value) => {
      entered = true
      return value
    })
    await Bun.sleep(50)
    expect(entered).toBe(false)
    await lease[Symbol.asyncDispose]()
    const later = await waiting
    expect(entered).toBe(true)
    await later[Symbol.asyncDispose]()
  })

  test("holds a request operation marker until its returned promise settles", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    let finish!: () => void
    const delayed = new Promise<void>((resolve) => (finish = resolve))
    const request = DataRootBarrier.during(managed.path, () => delayed)
    await Bun.sleep(20)

    let exclusive = false
    const switching = DataRootBarrier.exclusive().then((lease) => {
      exclusive = true
      return lease
    })
    await Bun.sleep(50)
    expect(exclusive).toBe(false)

    finish()
    await request
    const lease = await switching
    expect(exclusive).toBe(true)
    await lease[Symbol.asyncDispose]()
  })

  test.skipIf(process.platform === "win32")(
    "keeps a reassigned child marker live after its owning server is SIGKILLed",
    async () => {
      const base = await root()
      const config = path.join(base, "config")
      const data = path.join(base, "data")
      const ready = path.join(base, "ready.json")
      const helper = path.join(base, "owner.ts")
      const rootModule = new URL("../../src/global/data-root.ts", import.meta.url).href
      const barrierModule = new URL("../../src/global/data-root-barrier.ts", import.meta.url).href
      const identityModule = new URL("../../src/process/process-identity.ts", import.meta.url).href
      await fs.writeFile(
        helper,
        [
          'import { spawn } from "node:child_process"',
          'import fs from "node:fs/promises"',
          `import { DataRoot } from ${JSON.stringify(rootModule)}`,
          `import { DataRootBarrier } from ${JSON.stringify(barrierModule)}`,
          `import { ProcessIdentity } from ${JSON.stringify(identityModule)}`,
          "const [config, data, ready] = process.argv.slice(-3)",
          "const managed = await DataRoot.ensure(config, data, false)",
          "DataRootBarrier.configure({ root: managed.path, config })",
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })',
          "child.unref()",
          "if (!child.pid) throw new Error('child PID missing')",
          "const identity = await ProcessIdentity.capture(child.pid)",
          "if (!identity) throw new Error('child identity missing')",
          "const operation = await DataRootBarrier.enter(managed.path)",
          "await operation.reassign({ pid: child.pid, identity })",
          "await fs.writeFile(ready, JSON.stringify({ pid: child.pid, identity }))",
          "await new Promise(() => undefined)",
        ].join("\n"),
      )
      const managed = await DataRoot.ensure(config, data, false)
      DataRootBarrier.configure({ root: managed.path, config })
      const owner = Bun.spawn([process.execPath, helper, config, data, ready], {
        stdout: "ignore",
        stderr: "pipe",
      })
      let childPID: number | undefined
      try {
        const deadline = Date.now() + 10_000
        while (!(await Bun.file(ready).exists())) {
          if (Date.now() >= deadline) throw new Error(await new Response(owner.stderr).text())
          await Bun.sleep(20)
        }
        childPID = ((await Bun.file(ready).json()) as { pid: number }).pid
        process.kill(owner.pid, "SIGKILL")
        await owner.exited
        expect(() => process.kill(childPID!, 0)).not.toThrow()

        let exclusive = false
        const switching = DataRootBarrier.exclusive(10_000).then((lease) => {
          exclusive = true
          return lease
        })
        await Bun.sleep(100)
        expect(exclusive).toBe(false)
        process.kill(-childPID, "SIGKILL")
        childPID = undefined
        const lease = await switching
        expect(exclusive).toBe(true)
        await lease[Symbol.asyncDispose]()
      } finally {
        if (owner.exitCode === null) {
          try {
            process.kill(owner.pid, "SIGKILL")
          } catch {}
        }
        if (childPID) {
          try {
            process.kill(-childPID, "SIGKILL")
          } catch {}
        }
      }
    },
    20_000,
  )

  test.skipIf(process.platform !== "win32")(
    "retargets the same managed junction repeatedly on Windows without deleting its name",
    async () => {
      const base = await root()
      const config = path.join(base, "config")
      const first = path.join(base, "first")
      const second = path.join(base, "second")
      await Promise.all([fs.mkdir(first), fs.mkdir(second)])
      const managed = await DataRoot.ensure(config, first, false)
      const identity = (await fs.lstat(managed.path)).ino
      const canonicalFirst = await fs.realpath(first)
      const canonicalSecond = await fs.realpath(second)

      let reading = true
      const failures: unknown[] = []
      const reader = (async () => {
        while (reading) {
          const selected = await fs.realpath(managed.path).catch((error) => {
            failures.push(error)
            return undefined
          })
          if (selected !== undefined && selected !== canonicalFirst && selected !== canonicalSecond) {
            failures.push(selected)
          }
          await Bun.sleep(0)
        }
      })()

      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          await DataRoot.switchTo(managed.path, attempt % 2 ? first : second)
        }
      } finally {
        reading = false
        await reader
      }

      expect(failures).toEqual([])
      expect((await fs.lstat(managed.path)).ino).toBe(identity)
      expect(await fs.realpath(managed.path)).toBe(canonicalFirst)
    },
    20_000,
  )
})
