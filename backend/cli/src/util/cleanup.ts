import fs from "node:fs/promises"
import path from "node:path"

export namespace Cleanup {
  export const CONCURRENCY = 6

  export type Stats = {
    completed: number
    peak: number
  }

  type Input<T> = Iterable<T> | AsyncIterable<T>

  async function consume<T, R>(
    input: Input<T>,
    task: (item: T, index: number) => Promise<R>,
    concurrency: number,
    collect: boolean,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`Cleanup concurrency must be a positive integer: ${concurrency}`)
    }
    const iterator = Symbol.asyncIterator in input ? input[Symbol.asyncIterator]() : input[Symbol.iterator]()
    const output: R[] = []
    const errors: unknown[] = []
    const state = {
      index: 0,
      active: 0,
      completed: 0,
      peak: 0,
      done: false,
      failed: false,
      error: undefined as unknown,
      cursor: Promise.resolve(),
    }
    const take = () => {
      const next = state.cursor.then(async () => {
        if (state.done) return { done: true as const }
        try {
          const item = await iterator.next()
          if (item.done) {
            state.done = true
            return { done: true as const }
          }
          return { done: false as const, item: item.value, index: state.index++ }
        } catch (error) {
          state.done = true
          state.failed = true
          state.error = error
          return { done: true as const }
        }
      })
      state.cursor = next.then(() => undefined)
      return next
    }
    const worker = async () => {
      while (true) {
        const item = await take()
        if (item.done) return
        state.active++
        state.peak = Math.max(state.peak, state.active)
        try {
          const value = await task(item.item, item.index)
          if (collect) output[item.index] = value
        } catch (error) {
          errors.push(error)
        } finally {
          state.active--
          state.completed++
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    if (state.failed) errors.unshift(state.error)
    if (errors.length) throw new AggregateError(errors, `Cleanup failed for ${errors.length} item(s)`)
    return { output, completed: state.completed, peak: state.peak }
  }

  export async function map<T, R>(
    input: Input<T>,
    task: (item: T, index: number) => Promise<R>,
    concurrency = CONCURRENCY,
  ) {
    return consume(input, task, concurrency, true).then((result) => result.output)
  }

  export async function each<T>(
    input: Input<T>,
    task: (item: T, index: number) => Promise<unknown>,
    concurrency = CONCURRENCY,
  ): Promise<Stats> {
    return consume(input, task, concurrency, false).then((result) => ({
      completed: result.completed,
      peak: result.peak,
    }))
  }

  /** Remove a tree without following symbolic links or scheduling an operation
   * for every descendant at once. The walk is pulled by the small file worker
   * pool, then discovered directories are removed in reverse order. */
  export async function remove(root: string, concurrency = CONCURRENCY): Promise<Stats> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`Cleanup concurrency must be a positive integer: ${concurrency}`)
    }
    const directories: string[] = []
    const errors: unknown[] = []
    const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    const files = async function* () {
      const pending = [root]
      while (pending.length) {
        const target = pending.pop()
        if (!target) continue
        const info = await fs.lstat(target).catch((error) => {
          if (!missing(error)) errors.push(error)
          return undefined
        })
        if (!info) continue
        if (!info.isDirectory() || info.isSymbolicLink()) {
          yield target
          continue
        }
        directories.push(target)
        const directory = await fs.opendir(target).catch((error) => {
          if (!missing(error)) errors.push(error)
          return undefined
        })
        if (!directory) continue
        try {
          for await (const entry of directory) {
            const child = path.join(target, entry.name)
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
              pending.push(child)
              continue
            }
            yield child
          }
        } catch (error) {
          if (!missing(error)) errors.push(error)
        }
      }
    }
    const removed = await each(files(), (target) => fs.rm(target, { force: true }), concurrency).catch((error) => {
      errors.push(error)
      return { completed: 0, peak: 0 }
    })
    const folders = { completed: 0 }
    for (const target of directories.toReversed()) {
      await fs.rmdir(target).catch((error) => {
        if (!missing(error)) errors.push(error)
      })
      folders.completed++
    }
    if (errors.length) {
      throw new AggregateError(errors, `Cleanup failed for ${errors.length} path operation(s)`)
    }
    return {
      completed: removed.completed + folders.completed,
      peak: removed.peak,
    }
  }
}
