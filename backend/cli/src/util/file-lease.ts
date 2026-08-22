import fs from "node:fs/promises"
import path from "node:path"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { LockCoordination } from "@/util/lock-coordination"

export namespace FileLease {
  const timeout = 10_000
  const grace = 5_000

  type Owner = {
    pid: number
    token: string
    created: number
  }

  export interface Lease extends AsyncDisposable {
    during<T>(action: () => Promise<T>): Promise<T>
  }

  function running(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  async function owner(filepath: string) {
    return Bun.file(filepath)
      .json()
      .catch(() => undefined)
  }

  function exactOwner(value: unknown): value is Owner {
    return (
      !!value &&
      typeof value === "object" &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      "token" in value &&
      typeof value.token === "string" &&
      "created" in value &&
      typeof value.created === "number"
    )
  }

  async function abandoned(filepath: string, value: unknown) {
    const owner = value
    if (
      owner &&
      typeof owner === "object" &&
      "pid" in owner &&
      typeof owner.pid === "number" &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0
    ) {
      return !running(owner.pid)
    }
    const stat = await fs.stat(filepath).catch(() => undefined)
    return !!stat && Date.now() - stat.mtimeMs > grace
  }

  function cancelled(signal?: AbortSignal) {
    signal?.throwIfAborted()
  }

  async function pause(signal?: AbortSignal) {
    cancelled(signal)
    if (!signal) return Bun.sleep(15)
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
      }
      const abort = () => {
        done()
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      }
      const timer = setTimeout(() => {
        done()
        resolve()
      }, 15)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  export async function acquire(filepath: string, timeoutMs = timeout, signal?: AbortSignal): Promise<Lease> {
    cancelled(signal)
    const operation = await DataRootBarrier.enter(filepath, timeoutMs)
    try {
      cancelled(signal)
      const blocked: { at: number; owner?: string } = { at: Date.now() }
      const token = crypto.randomUUID()
      const parent = path.dirname(filepath)
      await fs.mkdir(parent, { recursive: true })
      // Pin the lock to the physical directory selected while the operation
      // marker is live. If the managed data-root link changes later, disposal
      // must remove the source lock it actually acquired rather than following
      // the new link and leaking a permanently-live lock in the old root.
      filepath = path.join(await fs.realpath(parent), path.basename(filepath))

      const open = async (): Promise<Awaited<ReturnType<typeof fs.open>>> => {
        const expired = () => {
          if (Date.now() - blocked.at < timeoutMs) return
          throw new Error(`Timed out waiting for another OpenScience process to release ${filepath}`)
        }
        while (true) {
          cancelled(signal)
          const attempt = await (async () => {
            await using intent = await LockCoordination.intent(filepath, grace)
            if (await intent.blocked()) return { status: "blocked" as const }
            const handle = await fs.open(filepath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "EEXIST") return
              throw error
            })
            if (handle) return { status: "acquired" as const, handle }
            return { status: "occupied" as const }
          })()
          if (attempt.status === "acquired") return attempt.handle

          const recovery = await (async () => {
            const observed = await owner(filepath)
            if (!(await abandoned(filepath, observed))) return { current: observed, reclaimed: false }
            await using claim = await LockCoordination.claim(filepath, grace)
            if (!(await claim.drain(blocked.at + timeoutMs, signal))) return { current: observed, reclaimed: false }
            const current = await owner(filepath)
            if (!(await abandoned(filepath, current))) return { current, reclaimed: false }
            const aside = `${filepath}.${crypto.randomUUID()}.dead`
            const reclaimed = await fs
              .rename(filepath, aside)
              .then(() => true)
              .catch(() => false)
            if (reclaimed) await fs.rm(aside, { force: true })
            return { current, reclaimed }
          })()
          if (recovery.reclaimed) continue
          // Timeout one unchanged owner, not the whole healthy queue. Each
          // lease writes a unique token, so an exact owner change proves that
          // the serialized operation ahead of us completed and the queue made
          // progress. A live but wedged owner still fails within timeoutMs.
          if (exactOwner(recovery.current)) {
            const signature = `${recovery.current.pid}\0${recovery.current.token}\0${recovery.current.created}`
            if (signature !== blocked.owner) {
              blocked.owner = signature
              blocked.at = Date.now()
            }
          }
          expired()
          await pause(signal)
        }
      }

      const handle = await open()
      await handle
        .writeFile(JSON.stringify({ pid: process.pid, token, created: Date.now() }))
        .then(() => cancelled(signal))
        .then(() => handle.sync())
        .catch(async (error) => {
          await handle.close().catch(() => undefined)
          await fs.rm(filepath, { force: true }).catch(() => undefined)
          throw error
        })
      let closing = false
      let uses = 0
      let drained: (() => void) | undefined
      let disposal: Promise<void> | undefined

      const releaseUse = () => {
        uses--
        if (uses) return
        const resolve = drained
        drained = undefined
        resolve?.()
      }

      const drain = async () => {
        if (!uses) return
        await new Promise<void>((resolve) => (drained = resolve))
      }

      return {
        during<T>(action: () => Promise<T>) {
          if (closing) return Promise.reject(new Error("Cannot scope work under a closing file lease"))
          uses++
          return operation.during(action).finally(releaseUse)
        },
        [Symbol.asyncDispose]() {
          if (disposal) return disposal
          closing = true
          disposal = (async () => {
            await drain()
            await handle.close().catch(() => undefined)
            const owner = await Bun.file(filepath)
              .json()
              .catch(() => undefined)
            if (owner && typeof owner === "object" && "token" in owner && owner.token === token) {
              await fs.rm(filepath, { force: true }).catch(() => undefined)
            }
            await LockCoordination.cleanup(filepath).catch(() => undefined)
            await Promise.resolve(operation[Symbol.asyncDispose]()).catch(() => undefined)
          })()
          return disposal
        },
      }
    } catch (error) {
      await Promise.resolve(operation[Symbol.asyncDispose]()).catch(() => undefined)
      throw error
    }
  }
}
