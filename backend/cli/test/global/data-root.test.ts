import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DataRoot } from "@/global/data-root"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { WindowsJunction } from "@/global/windows-junction"
import { ProcessIdentity } from "@/process/process-identity"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-data-root-"))
  roots.push(value)
  return value
}

async function waitForFile(filepath: string) {
  const deadline = Date.now() + 2_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

async function operationMarkers(config: string) {
  return fs.readdir(path.join(config, "data-root-operations")).catch(() => [] as string[])
}

function platform<T>(value: NodeJS.Platform, action: () => T) {
  const original = process.platform
  if (original === value) return action()
  Object.defineProperty(process, "platform", { value })
  try {
    return action()
  } finally {
    Object.defineProperty(process, "platform", { value: original })
  }
}

function windows<T>(action: () => T) {
  return platform("win32", action)
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

  test("admits a physical reassignable child after intent without releasing its ancestor early", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const intent = path.join(config, "data-root-switch.intent")
    const outerReady = Promise.withResolvers<void>()
    const startChild = Promise.withResolvers<void>()
    const childReady = Promise.withResolvers<void>()
    const releaseOuter = Promise.withResolvers<void>()
    let child: DataRootBarrier.Operation | undefined

    const command = DataRootBarrier.during(
      managed.path,
      async () => {
        outerReady.resolve()
        await startChild.promise
        child = await DataRootBarrier.enter(path.join(managed.path, "child.json"), 2_000)
        childReady.resolve()
        await releaseOuter.promise
      },
      2_000,
    )
    let switching: Promise<AsyncDisposable> | undefined
    try {
      await outerReady.promise
      switching = DataRootBarrier.exclusive(1_000)
      await waitForFile(intent)
      startChild.resolve()
      expect(await Promise.race([childReady.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
      expect(await operationMarkers(config)).toHaveLength(2)

      const identity = await ProcessIdentity.capture(process.pid)
      if (!identity) throw new Error("Current process identity is unavailable")
      await child!.reassign({ pid: process.pid, identity })
      expect(await operationMarkers(config)).toHaveLength(2)
      await expect(child!.during(async () => undefined)).rejects.toThrow(
        "Cannot scope work under a non-active data-root operation",
      )

      releaseOuter.resolve()
      await command
      expect(await operationMarkers(config)).toHaveLength(1)
      expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
    } finally {
      startChild.resolve()
      releaseOuter.resolve()
      await Promise.resolve(child?.[Symbol.asyncDispose]()).catch(() => undefined)
      const lease = await switching?.catch(() => undefined)
      await lease?.[Symbol.asyncDispose]()
      await command.catch(() => undefined)
    }
  })

  test("keeps the parent marker until an admitted child marker is durable", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const operations = path.join(config, "data-root-operations")
    const outerReady = Promise.withResolvers<void>()
    const startChild = Promise.withResolvers<void>()
    const childPublishing = Promise.withResolvers<void>()
    const releasePublish = Promise.withResolvers<void>()
    const renameOriginal = fs.rename.bind(fs)
    let intercepted = false
    let restoreRename = () => {}
    let child: Promise<DataRootBarrier.Operation> | undefined
    let command: Promise<void> | undefined
    let switching: Promise<AsyncDisposable> | undefined
    try {
      command = (async () => {
        await using outer = await DataRootBarrier.enter(managed.path, 2_000)
        return await outer.during(async () => {
          outerReady.resolve()
          await startChild.promise
          const gatedRename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
            if (
              !intercepted &&
              path.dirname(String(source)) === config &&
              path.basename(String(source)).endsWith(".pending") &&
              path.dirname(String(destination)) === operations
            ) {
              intercepted = true
              childPublishing.resolve()
              await releasePublish.promise
            }
            return renameOriginal(source, destination)
          })
          restoreRename = () => gatedRename.mockRestore()
          try {
            child = DataRootBarrier.enter(path.join(managed.path, "admitted.json"), 2_000)
          } finally {
            await childPublishing.promise
            restoreRename()
          }
        })
      })()
      await outerReady.promise
      startChild.resolve()
      await childPublishing.promise
      expect(await operationMarkers(config)).toHaveLength(1)
      expect(await Promise.race([command.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
      switching = DataRootBarrier.exclusive(2_000)
      await waitForFile(path.join(config, "data-root-switch.intent"))
      expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)

      releasePublish.resolve()
      const admitted = await child!
      await command
      expect(await operationMarkers(config)).toHaveLength(1)
      expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
      await admitted[Symbol.asyncDispose]()
      const exclusive = await switching
      await exclusive[Symbol.asyncDispose]()
    } finally {
      restoreRename()
      startChild.resolve()
      releasePublish.resolve()
      await command?.catch(() => undefined)
      const admitted = await child?.catch(() => undefined)
      await admitted?.[Symbol.asyncDispose]()
      const exclusive = await switching?.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
    }
  })

  test("an inherited background context reacquires after its enclosing scope closes", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const start = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let background: Promise<void> | undefined

    await DataRootBarrier.during(managed.path, async () => {
      background = (async () => {
        await start.promise
        await using operation = await DataRootBarrier.enter(path.join(managed.path, "background.json"), 2_000)
        entered.resolve()
        await finish.promise
        void operation
      })()
    })

    const exclusive = await DataRootBarrier.exclusive(2_000)
    try {
      start.resolve()
      expect(await Promise.race([entered.promise.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
    } finally {
      await exclusive[Symbol.asyncDispose]()
      start.resolve()
      await entered.promise
      finish.resolve()
      await background
    }
  })

  test("an inherited callback cannot borrow a still-open operation after its invocation ends", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const operation = await DataRootBarrier.enter(managed.path, 2_000)
    const start = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let background: Promise<void> | undefined

    await operation.during(async () => {
      background = (async () => {
        await start.promise
        await using child = await DataRootBarrier.enter(path.join(managed.path, "stale-frame.json"), 2_000)
        entered.resolve()
        await finish.promise
        void child
      })()
    })

    const switching = DataRootBarrier.exclusive(2_000)
    try {
      await waitForFile(path.join(config, "data-root-switch.intent"))
      start.resolve()
      expect(await Promise.race([entered.promise.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
      await operation[Symbol.asyncDispose]()
      const exclusive = await switching
      expect(await Promise.race([entered.promise.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
      await exclusive[Symbol.asyncDispose]()
      await entered.promise
      finish.resolve()
      await background
    } finally {
      start.resolve()
      finish.resolve()
      await Promise.resolve(operation[Symbol.asyncDispose]()).catch(() => undefined)
      const exclusive = await switching.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
      await background?.catch(() => undefined)
    }
  })

  test("unrelated concurrent scopes keep independent physical coverage", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const firstReady = Promise.withResolvers<void>()
    const secondReady = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const releaseSecond = Promise.withResolvers<void>()
    const first = DataRootBarrier.during(path.join(managed.path, "first.json"), async () => {
      firstReady.resolve()
      await releaseFirst.promise
    })
    const second = DataRootBarrier.during(path.join(managed.path, "second.json"), async () => {
      secondReady.resolve()
      await releaseSecond.promise
    })

    await Promise.all([firstReady.promise, secondReady.promise])
    expect(await operationMarkers(config)).toHaveLength(2)
    releaseFirst.resolve()
    await first
    expect(await operationMarkers(config)).toHaveLength(1)

    const switching = DataRootBarrier.exclusive(2_000)
    await waitForFile(path.join(config, "data-root-switch.intent"))
    expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
    releaseSecond.resolve()
    await second
    const exclusive = await switching
    await exclusive[Symbol.asyncDispose]()
  })

  test("a bare marker never lets a sibling operation bypass relocation intent", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const first = await DataRootBarrier.enter(path.join(managed.path, "first.json"), 2_000)
    let switching: Promise<AsyncDisposable> | undefined
    let sibling: Promise<DataRootBarrier.Operation> | undefined

    try {
      switching = DataRootBarrier.exclusive(2_000)
      await waitForFile(path.join(config, "data-root-switch.intent"))
      sibling = DataRootBarrier.enter(path.join(managed.path, "sibling.json"), 2_000)
      expect(await Promise.race([sibling.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)

      await first[Symbol.asyncDispose]()
      const exclusive = await switching
      expect(await Promise.race([sibling.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
      await exclusive[Symbol.asyncDispose]()
      const admitted = await sibling
      await admitted[Symbol.asyncDispose]()
    } finally {
      await Promise.resolve(first[Symbol.asyncDispose]()).catch(() => undefined)
      const exclusive = await switching?.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
      const admitted = await sibling?.catch(() => undefined)
      await admitted?.[Symbol.asyncDispose]()
    }
  })

  test("exclusive relocation fails fast inside an active operation scope", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })

    await DataRootBarrier.during(managed.path, async () => {
      await expect(DataRootBarrier.exclusive()).rejects.toThrow(
        "Cannot relocate the data root from inside an active data-root operation",
      )
      expect(await Bun.file(path.join(config, "data-root-switch.intent")).exists()).toBe(false)
    })
  })

  test("same-tick transitions reject new scopes but preserve an active callback's nested admission", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Current process identity is unavailable")
    const outer = await DataRootBarrier.enter(managed.path, 2_000)
    const scopeReady = Promise.withResolvers<void>()
    const startChild = Promise.withResolvers<void>()
    const childDone = Promise.withResolvers<void>()
    const releaseScope = Promise.withResolvers<void>()
    const command = outer.during(async () => {
      scopeReady.resolve()
      await startChild.promise
      await using child = await DataRootBarrier.enter(path.join(managed.path, "same-tick.json"), 2_000)
      childDone.resolve()
      await releaseScope.promise
      void child
    })
    let switching: Promise<AsyncDisposable> | undefined
    let reassigning: Promise<void> | undefined
    let disposing: PromiseLike<void> | undefined
    try {
      await scopeReady.promise
      switching = DataRootBarrier.exclusive(2_000)
      await waitForFile(path.join(config, "data-root-switch.intent"))
      reassigning = outer.reassign({ pid: process.pid, identity })
      disposing = outer[Symbol.asyncDispose]()
      await expect(outer.during(async () => undefined)).rejects.toThrow(
        "Cannot scope work under a non-active data-root operation",
      )
      startChild.resolve()
      expect(await Promise.race([childDone.promise.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true)
      expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)

      releaseScope.resolve()
      await command
      await Promise.all([reassigning, disposing])
      const exclusive = await switching
      await exclusive[Symbol.asyncDispose]()
    } finally {
      startChild.resolve()
      releaseScope.resolve()
      await command.catch(() => undefined)
      await reassigning?.catch(() => undefined)
      await Promise.resolve(disposing).catch(() => undefined)
      await Promise.resolve(outer[Symbol.asyncDispose]()).catch(() => undefined)
      const exclusive = await switching?.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
    }
  })

  test("a closing inner scope falls back to its live structured parent for admission", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const parent = await DataRootBarrier.enter(managed.path, 2_000)
    const childReady = Promise.withResolvers<void>()
    const startNested = Promise.withResolvers<void>()
    const nestedDone = Promise.withResolvers<void>()
    const finishParent = Promise.withResolvers<void>()
    let child: DataRootBarrier.Operation | undefined
    const command = parent.during(async () => {
      child = await DataRootBarrier.enter(path.join(managed.path, "child-scope.json"), 2_000)
      await child.during(async () => {
        childReady.resolve()
        await startNested.promise
        await using nested = await DataRootBarrier.enter(path.join(managed.path, "nested.json"), 2_000)
        nestedDone.resolve()
        void nested
      })
      await finishParent.promise
    })
    let switching: Promise<AsyncDisposable> | undefined

    try {
      await childReady.promise
      switching = DataRootBarrier.exclusive(2_000)
      await waitForFile(path.join(config, "data-root-switch.intent"))
      const disposingChild = child![Symbol.asyncDispose]()
      startNested.resolve()
      expect(await Promise.race([nestedDone.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
      await disposingChild
      expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)

      finishParent.resolve()
      await command
      await parent[Symbol.asyncDispose]()
      const exclusive = await switching
      await exclusive[Symbol.asyncDispose]()
    } finally {
      startNested.resolve()
      finishParent.resolve()
      await command.catch(() => undefined)
      await Promise.resolve(child?.[Symbol.asyncDispose]()).catch(() => undefined)
      await Promise.resolve(parent[Symbol.asyncDispose]()).catch(() => undefined)
      const exclusive = await switching?.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
    }
  })

  test("retries transient Windows marker locks without dropping physical coverage", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Current process identity is unavailable")
    const operation = await DataRootBarrier.enter(managed.path, 2_000)
    const [name] = await operationMarkers(config)
    const marker = path.join(config, "data-root-operations", name!)
    const original = JSON.parse(await fs.readFile(marker, "utf8")) as { token: string }
    const renameOriginal = fs.rename.bind(fs)
    const codes = ["EPERM", "EACCES", "EBUSY"]
    const coverage: number[] = []
    let attempts = 0
    let exclusive = false
    let switching: Promise<AsyncDisposable> | undefined
    const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!path.basename(String(source)).endsWith(".next")) return renameOriginal(source, destination)
      attempts++
      coverage.push((await operationMarkers(config)).length)
      expect(exclusive).toBe(false)
      expect(
        await fs.lstat(destination).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      const code = codes[attempts - 1]
      if (code) throw Object.assign(new Error(`mock ${code}`), { code })
      return renameOriginal(source, destination)
    })

    try {
      switching = DataRootBarrier.exclusive(5_000).then((lease) => {
        exclusive = true
        return lease
      })
      await waitForFile(path.join(config, "data-root-switch.intent"))
      await windows(() => operation.reassign({ pid: process.pid, identity }))
      const [currentName] = await operationMarkers(config)
      const current = JSON.parse(
        await fs.readFile(path.join(config, "data-root-operations", currentName!), "utf8"),
      ) as { token: string }
      expect(attempts).toBeGreaterThanOrEqual(4)
      expect(coverage.every((count) => count === 1)).toBe(true)
      expect(exclusive).toBe(false)
      expect(currentName).toBe(name)
      expect(current.token).toBe(original.token)
      rename.mockRestore()
      await operation[Symbol.asyncDispose]()
      const lease = await switching
      await lease[Symbol.asyncDispose]()
    } finally {
      rename.mockRestore()
      await Promise.resolve(operation[Symbol.asyncDispose]()).catch(() => undefined)
      const lease = await switching?.catch(() => undefined)
      await lease?.[Symbol.asyncDispose]()
    }
  })

  test("bounds persistent Windows marker locks and cleans the unpublished replacement", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Current process identity is unavailable")
    const operation = await DataRootBarrier.enter(managed.path, 2_000)
    const [name] = await operationMarkers(config)
    const marker = path.join(config, "data-root-operations", name!)
    const original = await fs.readFile(marker, "utf8")
    const renameOriginal = fs.rename.bind(fs)
    const coverage: number[] = []
    let attempts = 0
    let exclusive = false
    let switching: Promise<AsyncDisposable> | undefined
    const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!path.basename(String(source)).endsWith(".next")) return renameOriginal(source, destination)
      attempts++
      coverage.push((await operationMarkers(config)).length)
      expect(exclusive).toBe(false)
      expect(
        await fs.lstat(destination).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      throw Object.assign(new Error("mock persistent EPERM"), { code: "EPERM" })
    })

    try {
      switching = DataRootBarrier.exclusive(5_000).then((lease) => {
        exclusive = true
        return lease
      })
      await waitForFile(path.join(config, "data-root-switch.intent"))
      const started = performance.now()
      const reassigning = windows(() => operation.reassign({ pid: process.pid, identity }))
      await expect(reassigning).rejects.toMatchObject({ code: "EPERM" })
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(1_900)
      expect(elapsed).toBeLessThan(6_000)
      expect(attempts).toBeGreaterThan(3)
      expect(coverage.every((count) => count === 1)).toBe(true)
      expect(exclusive).toBe(false)
      expect(await fs.readFile(marker, "utf8")).toBe(original)
      expect((await fs.readdir(config)).filter((entry) => entry.endsWith(".next"))).toEqual([])
      rename.mockRestore()
      await operation[Symbol.asyncDispose]()
      const lease = await switching
      await lease[Symbol.asyncDispose]()
    } finally {
      rename.mockRestore()
      await Promise.resolve(operation[Symbol.asyncDispose]()).catch(() => undefined)
      const lease = await switching?.catch(() => undefined)
      await lease?.[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("does not retry lock-shaped rename errors outside Windows", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Current process identity is unavailable")
    const operation = await DataRootBarrier.enter(managed.path, 2_000)
    const [name] = await operationMarkers(config)
    const marker = path.join(config, "data-root-operations", name!)
    const original = await fs.readFile(marker, "utf8")
    const renameOriginal = fs.rename.bind(fs)
    const codes = ["EPERM", "EACCES", "EBUSY"]
    let code = codes[0]!
    let attempts = 0
    const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!path.basename(String(source)).endsWith(".next")) return renameOriginal(source, destination)
      attempts++
      expect(
        await fs.lstat(destination).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      throw Object.assign(new Error(`mock ${code}`), { code })
    })

    try {
      for (const current of codes) {
        code = current
        const before = attempts
        const started = performance.now()
        const reassigning = platform("darwin", () => operation.reassign({ pid: process.pid, identity }))
        await expect(reassigning).rejects.toMatchObject({ code: current })
        expect(performance.now() - started).toBeLessThan(500)
        expect(attempts).toBe(before + 1)
        expect(await fs.readFile(marker, "utf8")).toBe(original)
        expect((await fs.readdir(config)).filter((entry) => entry.endsWith(".next"))).toEqual([])
      }
    } finally {
      rename.mockRestore()
      await operation[Symbol.asyncDispose]()
    }
  })

  test("failed reassignment restores self-owned admission when no later transition is queued", async () => {
    const base = await root()
    const config = path.join(base, "config")
    const data = path.join(base, "data")
    const managed = await DataRoot.ensure(config, data, false)
    DataRootBarrier.configure({ root: managed.path, config })
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Current process identity is unavailable")
    const startNested = Promise.withResolvers<void>()
    const nestedDone = Promise.withResolvers<void>()
    const renameOriginal = fs.rename.bind(fs)
    const coverage: number[] = []
    let attempts = 0
    let restoreRename = () => {}
    const outer = await DataRootBarrier.enter(managed.path, 2_000)
    const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (path.basename(String(source)).endsWith(".next")) {
        attempts++
        coverage.push((await operationMarkers(config)).length)
        expect(
          await fs.lstat(destination).then(
            () => true,
            () => false,
          ),
        ).toBe(true)
        throw Object.assign(new Error("mock reassign failure"), { code: "EIO" })
      }
      return renameOriginal(source, destination)
    })
    restoreRename = () => rename.mockRestore()
    let command: Promise<void> | undefined
    let switching: Promise<AsyncDisposable> | undefined
    try {
      const started = performance.now()
      await expect(outer.reassign({ pid: process.pid, identity })).rejects.toThrow("mock reassign failure")
      expect(performance.now() - started).toBeLessThan(500)
      expect(attempts).toBe(1)
      expect(coverage).toEqual([1])
      expect((await fs.readdir(config)).filter((entry) => entry.endsWith(".next"))).toEqual([])
      restoreRename()
      command = outer.during(async () => {
        await startNested.promise
        await using child = await DataRootBarrier.enter(path.join(managed.path, "after-failure.json"), 2_000)
        nestedDone.resolve()
        void child
      })
      switching = DataRootBarrier.exclusive(1_000)
      await waitForFile(path.join(config, "data-root-switch.intent"))
      startNested.resolve()
      expect(await Promise.race([nestedDone.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
      await command
      await outer[Symbol.asyncDispose]()
      const exclusive = await switching
      await exclusive[Symbol.asyncDispose]()
    } finally {
      restoreRename()
      startNested.resolve()
      await command?.catch(() => undefined)
      await Promise.resolve(outer[Symbol.asyncDispose]()).catch(() => undefined)
      const exclusive = await switching?.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
    }
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
