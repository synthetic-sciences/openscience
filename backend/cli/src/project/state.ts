import { Log } from "@/util/log"

export namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    const get = () => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose,
      })
      return state
    }
    /** Whether the state exists for the current root, without creating it. */
    const created = () => !!recordsByKey.get(root())?.has(init)
    return Object.assign(get, { created })
  }

  /** Number of runtimes registered for one project root. */
  export function size(key: string) {
    return recordsByKey.get(key)?.size ?? 0
  }

  export function clear(key: string, init: Function) {
    const entries = recordsByKey.get(key)
    if (!entries) return
    entries.delete(init)
    if (entries.size === 0) recordsByKey.delete(key)
  }

  export async function dispose(key: string, options: { strict?: boolean } = {}) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false

    setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000).unref()

    const tasks: Array<{ init: unknown; task: Promise<void> }> = []
    for (const [init, entry] of entries) {
      if (!entry.dispose) continue

      const task = Promise.resolve(entry.state).then((state) => entry.dispose!(state))

      tasks.push({ init, task })
    }

    const results = await Promise.allSettled(tasks.map((value) => value.task))
    const failures: unknown[] = []
    for (const [index, result] of results.entries()) {
      const init = tasks[index].init
      if (result.status === "fulfilled") {
        if (options.strict) entries.delete(init)
        continue
      }
      failures.push(result.reason)
      const label = typeof init === "function" ? init.name : String(init)
      log.error("Error while disposing state:", { error: result.reason, key, init: label })
    }

    disposalFinished = true
    if (failures.length && options.strict) {
      // Successful and non-disposable states need no retry. Retain only the
      // exact failed disposers so a second graceful-shutdown attempt cannot
      // repeat teardown that already completed.
      for (const [init, entry] of entries) {
        if (!entry.dispose) entries.delete(init)
      }
      throw new AggregateError(failures, `One or more project runtimes could not be disposed for ${key}`)
    }

    entries.clear()
    recordsByKey.delete(key)

    log.info("state disposal completed", { key })
  }
}
