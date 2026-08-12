import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { ProcessIdentity } from "../process/process-identity"

/**
 * Cross-process drain barrier used only for data-root relocation.
 *
 * Writers publish small operation markers in the config directory. A switch
 * first publishes an intent (which blocks new markers), then waits for every
 * marker owned by a live OpenScience process to disappear. The config root is
 * deliberately outside the switchable data root.
 */
export namespace DataRootBarrier {
  export interface Owner {
    pid: number
    identity: string
  }

  export interface Operation extends AsyncDisposable {
    reassign(owner: Owner): Promise<void>
  }

  interface Record {
    pid?: number
    identity?: string
    token?: string
  }

  type Configuration = { root: string; config: string }
  let configuration: Configuration | undefined
  let self: Promise<Owner> | undefined

  const pause = 20
  const wait = 30_000

  export function configure(value: Configuration) {
    configuration = value
  }

  function paths(config: string) {
    return {
      intent: path.join(config, "data-root-switch.intent"),
      lock: path.join(config, "data-root-switch.lock"),
      operations: path.join(config, "data-root-operations"),
    }
  }

  function relevant(filepath: string, root: string) {
    const relative = path.relative(root, filepath)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  function running(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  async function owner(filepath: string): Promise<Record | undefined> {
    return Bun.file(filepath)
      .json()
      .then((value) => (value && typeof value === "object" ? value : undefined))
      .catch(() => undefined)
  }

  async function exactOwner(value?: Owner): Promise<Owner> {
    if (value) {
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^[a-f0-9]{64}$/.test(value.identity)) {
        throw new Error("A data-root operation owner requires an exact process identity")
      }
      if (!(await ProcessIdentity.owns(value.pid, value.identity))) {
        throw new Error(`Data-root operation owner ${value.pid} is no longer the recorded process`)
      }
      return value
    }
    self ??= ProcessIdentity.capture(process.pid).then((identity) => {
      if (!identity) throw new Error(`Could not establish an exact identity for OpenScience process ${process.pid}`)
      return { pid: process.pid, identity }
    })
    return self
  }

  async function liveOwner(record: Record | undefined): Promise<boolean> {
    if (typeof record?.pid !== "number") return false
    if (record.identity) return ProcessIdentity.owns(record.pid, record.identity)
    // Compatibility for an operation marker written by an older process.
    // New markers always include an exact process-start identity.
    return running(record.pid)
  }

  async function waitForIntent(intent: string, deadline: number) {
    while (await fs.lstat(intent).catch(() => undefined)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the active data relocation to finish")
      const record = await owner(intent)
      if (typeof record?.pid === "number" && !(await liveOwner(record))) {
        const aside = `${intent}.${randomUUID()}.dead`
        const claimed = await fs
          .rename(intent, aside)
          .then(() => true)
          .catch(() => false)
        if (claimed) await fs.rm(aside, { force: true })
        continue
      }
      await Bun.sleep(pause)
    }
  }

  /** Mark one durable operation. Paths outside the managed root are no-ops. */
  export async function enter(filepath: string, timeoutMs = wait, requestedOwner?: Owner): Promise<Operation> {
    const current = configuration
    if (!current || !relevant(path.resolve(filepath), path.resolve(current.root))) {
      return {
        async reassign() {},
        async [Symbol.asyncDispose]() {},
      }
    }

    const { intent, operations } = paths(current.config)
    const deadline = Date.now() + timeoutMs
    const operationOwner = await exactOwner(requestedOwner)
    await fs.mkdir(operations, { recursive: true })
    const token = randomUUID()
    const marker = path.join(operations, `${operationOwner.pid}.${token}.json`)
    for (;;) {
      await waitForIntent(intent, deadline)
      const handle = await fs.open(marker, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ...operationOwner, token, created: Date.now() }))
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        await fs.rm(marker, { force: true }).catch(() => undefined)
        throw error
      }
      if (!(await fs.lstat(intent).catch(() => undefined))) {
        let pending = Promise.resolve()
        let disposed = false
        return {
          reassign(value: Owner) {
            pending = pending.then(async () => {
              if (disposed) throw new Error("Cannot reassign a closed data-root operation")
              const nextOwner = await exactOwner(value)
              const temporary = path.join(current.config, `.data-root-operation-${token}.${randomUUID()}.next`)
              const replacement = await fs.open(temporary, "wx", 0o600)
              try {
                await replacement.writeFile(JSON.stringify({ ...nextOwner, token, created: Date.now() }))
                await replacement.sync()
                await replacement.close()
                await fs.rename(temporary, marker)
              } catch (error) {
                await replacement.close().catch(() => undefined)
                await fs.rm(temporary, { force: true }).catch(() => undefined)
                throw error
              }
            })
            return pending
          },
          async [Symbol.asyncDispose]() {
            await pending
            disposed = true
            await handle.close().catch(() => undefined)
            const record = await owner(marker)
            if (record?.token === token) await fs.rm(marker, { force: true }).catch(() => undefined)
          },
        }
      }
      await handle.close().catch(() => undefined)
      await fs.rm(marker, { force: true }).catch(() => undefined)
    }
  }

  /** Keep a marker alive until the asynchronous operation has actually
   * settled. Returning an un-awaited Promise from an `await using` scope
   * releases the marker too early, so request/CLI boundaries use this helper. */
  export async function during<T>(filepath: string, action: () => Promise<T>, timeoutMs = wait): Promise<T> {
    await using operation = await enter(filepath, timeoutMs)
    return await action()
  }

  async function acquire(filepath: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    const token = randomUUID()
    const operationOwner = await exactOwner()
    for (;;) {
      const handle = await fs.open(filepath, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
        const record = await owner(filepath)
        if (typeof record?.pid === "number" && !(await liveOwner(record))) {
          const aside = `${filepath}.${randomUUID()}.dead`
          const claimed = await fs
            .rename(filepath, aside)
            .then(() => true)
            .catch(() => false)
          if (claimed) await fs.rm(aside, { force: true })
          if (claimed) return
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for another data relocation")
        await Bun.sleep(pause)
      })
      if (!handle) continue
      try {
        await handle.writeFile(JSON.stringify({ ...operationOwner, token, created: Date.now() }))
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        await fs.rm(filepath, { force: true }).catch(() => undefined)
        throw error
      }
      return { handle, token }
    }
  }

  /** Block new operations and wait for every pre-existing writer to drain. */
  export async function exclusive(timeoutMs = wait): Promise<AsyncDisposable> {
    const current = configuration
    if (!current) throw new Error("The data-root barrier has not been configured")
    const state = paths(current.config)
    await fs.mkdir(state.operations, { recursive: true })
    const lock = await acquire(state.lock, timeoutMs)
    const intent = await fs.open(state.intent, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
      await lock.handle.close().catch(() => undefined)
      await fs.rm(state.lock, { force: true }).catch(() => undefined)
      throw error
    })
    const intentToken = randomUUID()
    const intentOwner = await exactOwner()
    try {
      await intent.writeFile(JSON.stringify({ ...intentOwner, token: intentToken, created: Date.now() }))
      await intent.sync()
    } catch (error) {
      await intent.close().catch(() => undefined)
      await fs.rm(state.intent, { force: true }).catch(() => undefined)
      await lock.handle.close().catch(() => undefined)
      await fs.rm(state.lock, { force: true }).catch(() => undefined)
      throw error
    }

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const entries = await fs.readdir(state.operations).catch(() => [])
      const live: string[] = []
      for (const name of entries) {
        const marker = path.join(state.operations, name)
        const record = await owner(marker)
        if (await liveOwner(record)) {
          live.push(name)
          continue
        }
        await fs.rm(marker, { force: true }).catch(() => undefined)
      }
      if (!live.length) break
      if (Date.now() >= deadline) {
        await intent.close().catch(() => undefined)
        await fs.rm(state.intent, { force: true }).catch(() => undefined)
        await lock.handle.close().catch(() => undefined)
        await fs.rm(state.lock, { force: true }).catch(() => undefined)
        throw new Error(`Active OpenScience operations did not quiesce: ${live.join(", ")}`)
      }
      await Bun.sleep(pause)
    }

    return {
      async [Symbol.asyncDispose]() {
        await intent.close().catch(() => undefined)
        const activeIntent = await owner(state.intent)
        if (activeIntent?.token === intentToken) await fs.rm(state.intent, { force: true }).catch(() => undefined)
        await lock.handle.close().catch(() => undefined)
        const activeLock = await owner(state.lock)
        if (activeLock?.token === lock.token) await fs.rm(state.lock, { force: true }).catch(() => undefined)
      },
    }
  }
}
