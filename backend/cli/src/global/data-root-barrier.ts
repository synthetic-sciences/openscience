import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
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
    during<T>(action: () => Promise<T>): Promise<T>
  }

  interface PhysicalOperation extends AsyncDisposable {
    reassign(owner: Owner, windows: boolean): Promise<void>
  }

  interface Record {
    pid?: number
    identity?: string
    token?: string
  }

  type Configuration = { root: string; config: string }
  type ScopeState = "opening" | "active" | "closing" | "detached" | "closed"
  interface Anchor {
    configuration: Configuration
    state: ScopeState
    accepting: boolean
    admissions: number
    drained?: () => void
    uses: number
    unused?: () => void
  }
  interface ScopeFrame {
    anchor: Anchor
    parent?: ScopeFrame
    active: boolean
  }

  let configuration: Configuration | undefined
  let self: Promise<Owner> | undefined
  const scopes = new AsyncLocalStorage<ScopeFrame>()

  const pause = 20
  const wait = 30_000
  const replaceWait = 2_000
  const replacePause = 10
  const replaceMaxPause = 100

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

  function configured(filepath: string) {
    const current = configuration
    if (!current || !relevant(path.resolve(filepath), path.resolve(current.root))) return
    return current
  }

  function noOperation(): Operation {
    return {
      async reassign() {},
      async during<T>(action: () => Promise<T>) {
        return await action()
      },
      async [Symbol.asyncDispose]() {},
    }
  }

  function scopedAnchor(current: Configuration, start = scopes.getStore()) {
    for (let frame = start; frame; frame = frame.parent) {
      if (!frame.active) continue
      const anchor = frame.anchor
      if ((anchor.state === "active" || anchor.state === "closing") && anchor.configuration === current) return anchor
    }
  }

  function admissionAnchor(current: Configuration, start = scopes.getStore()) {
    for (let frame = start; frame; frame = frame.parent) {
      if (!frame.active) continue
      const anchor = frame.anchor
      // `accepting` gates new Operation.during calls. A frame that was already
      // admitted must retain child publication until its callback settles;
      // otherwise a close/reassign racing relocation can strand that callback
      // behind intent while relocation waits for the callback's marker.
      if (anchor.state === "active" && anchor.configuration === current) return anchor
    }
  }

  function admit(anchor: Anchor) {
    anchor.admissions++
    let released = false
    return () => {
      if (released) return
      released = true
      anchor.admissions--
      if (!anchor.admissions) anchor.drained?.()
    }
  }

  async function drain(anchor: Anchor) {
    if (!anchor.admissions) return
    await new Promise<void>((resolve) => (anchor.drained = resolve))
  }

  function inside(anchor: Anchor) {
    for (let frame = scopes.getStore(); frame; frame = frame.parent) {
      if (frame.active && frame.anchor === anchor) return true
    }
    return false
  }

  function beginTransition(anchor: Anchor) {
    anchor.accepting = false
    if (!anchor.uses && anchor.state === "active") anchor.state = "closing"
  }

  function use(anchor: Anchor) {
    anchor.uses++
    let released = false
    return () => {
      if (released) return
      released = true
      anchor.uses--
      if (anchor.uses) return
      if (!anchor.accepting && anchor.state === "active") anchor.state = "closing"
      anchor.unused?.()
    }
  }

  async function finishUses(anchor: Anchor) {
    if (!anchor.uses) return
    await new Promise<void>((resolve) => (anchor.unused = resolve))
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

  function replaceable(error: NodeJS.ErrnoException, windows: boolean) {
    return windows && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY")
  }

  async function replace(
    source: string,
    destination: string,
    windows: boolean,
    deadline = Date.now() + replaceWait,
    delay = replacePause,
  ): Promise<void> {
    return fs.rename(source, destination).catch(async (error: NodeJS.ErrnoException) => {
      if (!replaceable(error, windows) || Date.now() >= deadline) throw error
      await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
      return replace(source, destination, windows, deadline, Math.min(delay * 2, replaceMaxPause))
    })
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

  async function createOperation(
    current: Configuration,
    filepath: string,
    timeoutMs: number,
    requestedOwner?: Owner,
    admittedBy?: Anchor,
  ): Promise<PhysicalOperation> {
    const { intent, operations } = paths(current.config)
    const deadline = Date.now() + timeoutMs
    const operationOwner = await exactOwner(requestedOwner)
    await fs.mkdir(operations, { recursive: true })
    const token = randomUUID()
    const marker = path.join(operations, `${operationOwner.pid}.${token}.json`)
    for (;;) {
      // An active ancestor marker was admitted before the relocation intent.
      // While that marker is retained, a descendant may publish its own marker
      // without waiting on the intent; there is no coverage gap for the switch.
      if (!admittedBy) await waitForIntent(intent, deadline)
      // Build the complete record outside the scanned operations directory.
      // Publishing the final name atomically prevents exclusive() from seeing
      // an empty/partial record, classifying it as dead, and unlinking it while
      // this process continues writing through an open handle.
      const temporary = path.join(
        current.config,
        `.data-root-operation-${operationOwner.pid}.${token}.${randomUUID()}.pending`,
      )
      const handle = await fs.open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ...operationOwner, token, created: Date.now() }))
        await handle.sync()
        await handle.close()
        await fs.rename(temporary, marker)
      } catch (error) {
        await handle.close().catch(() => undefined)
        await fs.rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      if (admittedBy || !(await fs.lstat(intent).catch(() => undefined))) {
        let serial = Promise.resolve()
        let disposed = false
        let disposal: Promise<void> | undefined
        const enqueue = (action: () => Promise<void>) => {
          const result = serial.then(action)
          serial = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        }
        return {
          reassign(value: Owner, windows: boolean) {
            if (disposed) return Promise.reject(new Error("Cannot reassign a closed data-root operation"))
            return enqueue(async () => {
              const nextOwner = await exactOwner(value)
              const temporary = path.join(current.config, `.data-root-operation-${token}.${randomUUID()}.next`)
              const replacement = await fs.open(temporary, "wx", 0o600)
              try {
                await replacement.writeFile(JSON.stringify({ ...nextOwner, token, created: Date.now() }))
                await replacement.sync()
                await replacement.close()
                // Windows can reject replacement while a scanner holds a
                // conflicting destination handle. Retrying the same atomic
                // update keeps the old complete marker authoritative.
                await replace(temporary, marker, windows)
              } catch (error) {
                await replacement.close().catch(() => undefined)
                await fs.rm(temporary, { force: true }).catch(() => undefined)
                throw error
              }
            })
          },
          [Symbol.asyncDispose]() {
            if (disposal) return disposal
            disposed = true
            disposal = enqueue(async () => {
              const record = await owner(marker)
              if (record?.token === token) await fs.rm(marker, { force: true }).catch(() => undefined)
            })
            return disposal
          },
        }
      }
      // A non-admitted entrant still rechecks intent after atomic publication.
      // Remove its complete marker and retry only after relocation finishes.
      await fs.rm(marker, { force: true })
    }
  }

  function scopedOperation(anchor: Anchor, operation: PhysicalOperation): Operation {
    let disposed = false
    let disposal: Promise<void> | undefined
    let reassignments = 0
    let serial = Promise.resolve()
    const enqueue = (action: () => Promise<void>) => {
      const result = serial.then(action)
      serial = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    return {
      reassign(owner: Owner) {
        if (disposed) return Promise.reject(new Error("Cannot reassign a closed data-root operation"))
        if (inside(anchor)) {
          return Promise.reject(new Error("Cannot reassign a data-root operation from inside its structured scope"))
        }
        const windows = process.platform === "win32"
        reassignments++
        // Reject new structured uses immediately. Existing callbacks retain
        // admission until they settle, so they cannot strand this marker
        // behind an intent while the transition waits for them.
        beginTransition(anchor)
        return enqueue(async () => {
          try {
            await finishUses(anchor)
            await drain(anchor)
            await operation.reassign(owner, windows)
            // A foreign owner can exit while this process remains alive, so
            // this marker can no longer admit same-process descendants.
            anchor.state = "detached"
          } finally {
            reassignments--
            // Rename is the final fallible step, so a failed reassignment left
            // the original self-owned marker intact. Re-open admission only
            // when no later transition or disposal is waiting behind it.
            if (!disposed && !reassignments && anchor.state === "closing") {
              anchor.state = "active"
              anchor.accepting = true
            }
          }
        })
      },
      during<T>(action: () => Promise<T>) {
        if (disposed || !anchor.accepting || anchor.state !== "active") {
          return Promise.reject(new Error("Cannot scope work under a non-active data-root operation"))
        }
        // Use a fresh invocation-time parent. A creation-time parent may be a
        // closed request, and installing it here would resurrect stale scope.
        const frame: ScopeFrame = { anchor, parent: scopes.getStore(), active: true }
        const release = use(anchor)
        return scopes.run(frame, async () => {
          try {
            return await action()
          } finally {
            frame.active = false
            release()
          }
        })
      },
      [Symbol.asyncDispose]() {
        if (disposal) return disposal
        if (inside(anchor)) {
          return Promise.reject(new Error("Cannot dispose a data-root operation from inside its structured scope"))
        }
        disposed = true
        beginTransition(anchor)
        disposal = enqueue(async () => {
          await finishUses(anchor)
          await drain(anchor)
          try {
            await operation[Symbol.asyncDispose]()
          } finally {
            anchor.state = "closed"
          }
        })
        return disposal
      },
    }
  }

  /** Mark one durable operation. Paths outside the managed root are no-ops.
   * Each relevant call owns a physical marker. A live async-local ancestor may
   * admit the child past a newly-published relocation intent, but retains its
   * own marker until the child's marker has been fully published. */
  export async function enter(filepath: string, timeoutMs = wait, requestedOwner?: Owner): Promise<Operation> {
    const current = configured(filepath)
    if (!current) return noOperation()

    const ancestor = admissionAnchor(current)
    // Admission is synchronous: a closing ancestor can never miss a child that
    // has decided to rely on its marker while publishing under an intent.
    const release = ancestor ? admit(ancestor) : undefined
    const anchor: Anchor = {
      configuration: current,
      state: "opening",
      accepting: false,
      admissions: 0,
      uses: 0,
    }
    try {
      const operation = await createOperation(current, filepath, timeoutMs, requestedOwner, ancestor)
      // Explicitly-owned operations are transferable child markers, not
      // trustworthy same-process admission anchors.
      anchor.state = requestedOwner ? "detached" : "active"
      anchor.accepting = !requestedOwner
      return scopedOperation(anchor, operation)
    } catch (error) {
      anchor.state = "closed"
      throw error
    } finally {
      release?.()
    }
  }

  /** Keep a marker alive until the asynchronous operation has actually
   * settled. Returning an un-awaited Promise from an `await using` scope
   * releases the marker too early, so request/CLI boundaries use this helper. */
  export function during<T>(filepath: string, action: () => Promise<T>, timeoutMs = wait): Promise<T> {
    return (async () => {
      await using operation = await enter(filepath, timeoutMs)
      return await operation.during(action)
    })()
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
    if (scopedAnchor(current)) {
      throw new Error("Cannot relocate the data root from inside an active data-root operation")
    }
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
