import fs from "node:fs/promises"
import path from "node:path"
import { DataRootBarrier } from "@/global/data-root-barrier"

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
      "token" in value &&
      typeof value.token === "string" &&
      "created" in value &&
      typeof value.created === "number"
    )
  }

  async function abandoned(filepath: string, value: unknown) {
    const owner = value
    if (owner && typeof owner === "object" && "pid" in owner && typeof owner.pid === "number") {
      return !running(owner.pid)
    }
    const stat = await fs.stat(filepath).catch(() => undefined)
    return !!stat && Date.now() - stat.mtimeMs > grace
  }

  export async function acquire(filepath: string, timeoutMs = timeout): Promise<Lease> {
    const operation = await DataRootBarrier.enter(filepath, timeoutMs)
    try {
      let blockedAt = Date.now()
      let blockedOwner: string | undefined
      const token = crypto.randomUUID()
      const parent = path.dirname(filepath)
      await fs.mkdir(parent, { recursive: true })
      // Pin the lock to the physical directory selected while the operation
      // marker is live. If the managed data-root link changes later, disposal
      // must remove the source lock it actually acquired rather than following
      // the new link and leaking a permanently-live lock in the old root.
      filepath = path.join(await fs.realpath(parent), path.basename(filepath))

      const open = async (): Promise<Awaited<ReturnType<typeof fs.open>>> => {
        const handle = await fs.open(filepath, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
          const current = await owner(filepath)
          if (await abandoned(filepath, current)) {
            const aside = `${filepath}.${crypto.randomUUID()}.dead`
            const claimed = await fs
              .rename(filepath, aside)
              .then(() => true)
              .catch(() => false)
            if (claimed) await fs.rm(aside, { force: true })
            if (claimed) return open()
          }
          // Timeout one unchanged owner, not the whole healthy queue. Each
          // lease writes a unique token, so an exact owner change proves that
          // the serialized operation ahead of us completed and the queue made
          // progress. A live but wedged owner still fails within timeoutMs.
          if (exactOwner(current)) {
            const signature = `${current.pid}\0${current.token}\0${current.created}`
            if (signature !== blockedOwner) {
              blockedOwner = signature
              blockedAt = Date.now()
            }
          }
          if (Date.now() - blockedAt >= timeoutMs) {
            throw new Error(`Timed out waiting for another OpenScience process to release ${filepath}`)
          }
          await Bun.sleep(15)
          return open()
        })
        return handle
      }

      const handle = await open()
      await handle
        .writeFile(JSON.stringify({ pid: process.pid, token, created: Date.now() }))
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
