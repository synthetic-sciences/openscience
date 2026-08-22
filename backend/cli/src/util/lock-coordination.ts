import fs from "node:fs/promises"
import path from "node:path"

/** A filesystem-only barrier around O_EXCL lock creation and dead-owner
 * reclamation. Acquirers publish a unique intent before checking claims and
 * keep it through open(); reclaimers publish a unique claim, drain prior
 * intents, then revalidate the owner before rename(). Claims keep every new
 * cooperative acquirer out until all concurrent reclaimers have finished. */
export namespace LockCoordination {
  export type Kind = "claim" | "intent"

  type Marker = {
    pid: number
    token: string
    created: number
  }

  function valid(value: unknown): value is Marker {
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

  function running(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  function filename() {
    return `${process.pid}.${crypto.randomUUID()}.marker`
  }

  export function directory(filepath: string, kind: Kind) {
    return path.join(`${filepath}.coord`, kind)
  }

  async function stale(filepath: string, name: string, timeout: number) {
    const value = await Bun.file(filepath)
      .json()
      .catch(() => undefined)
    const named = Number(name.split(".", 1)[0])
    const pid = valid(value) ? value.pid : Number.isSafeInteger(named) && named > 0 ? named : undefined
    // PID reuse is intentionally fail-closed: it may retain an orphan marker
    // until the recycled process exits, but can never delete a live owner's
    // distinct UUID marker or permit an unsafe lock replacement.
    if (pid) return !running(pid)
    return fs
      .stat(filepath)
      .then((stat) => Date.now() - stat.mtimeMs > timeout)
      .catch(() => false)
  }

  async function active(filepath: string, kind: Kind, timeout: number) {
    const dir = directory(filepath, kind)
    const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const items = await Promise.all(
      names.map(async (name) => {
        const target = path.join(dir, name)
        if (!(await stale(target, name, timeout))) return true
        return fs
          .unlink(target)
          .then(() => false)
          .catch((error: NodeJS.ErrnoException) => error.code !== "ENOENT")
      }),
    )
    return items.some(Boolean)
  }

  async function create(filepath: string, kind: Kind) {
    const dir = directory(filepath, kind)
    const name = filename()
    const target = path.join(dir, name)
    const marker = JSON.stringify({ pid: process.pid, token: name, created: Date.now() })
    const open = async (): Promise<Awaited<ReturnType<typeof fs.open>>> => {
      await fs.mkdir(dir, { recursive: true })
      return fs.open(target, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return open()
      })
    }
    const handle = await open()
    await handle
      .writeFile(marker)
      .then(() => handle.sync())
      .finally(() => handle.close())
      .catch(async (error) => {
        await fs.unlink(target).catch(() => undefined)
        throw error
      })
    return {
      async [Symbol.asyncDispose]() {
        await fs.unlink(target).catch(() => undefined)
      },
    }
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

  export async function intent(filepath: string, timeout: number) {
    const marker = await create(filepath, "intent")
    return {
      blocked: () => active(filepath, "claim", timeout),
      [Symbol.asyncDispose]: () => marker[Symbol.asyncDispose](),
    }
  }

  export async function claim(filepath: string, timeout: number) {
    const marker = await create(filepath, "claim")
    return {
      async drain(deadline: number, signal?: AbortSignal) {
        while (await active(filepath, "intent", timeout)) {
          cancelled(signal)
          if (Date.now() >= deadline) return false
          await pause(signal)
        }
        return true
      },
      [Symbol.asyncDispose]: () => marker[Symbol.asyncDispose](),
    }
  }
}
