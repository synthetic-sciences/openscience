type SearchTask<T> = {
  query: string
  promise: Promise<T>
  resolve: (value: T) => void
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  settled: boolean
}

export function createDebouncedSearch<T>(
  run: (query: string, signal: AbortSignal) => Promise<T>,
  options: { delayMs: number; fallback: () => T },
) {
  let current: SearchTask<T> | undefined

  const settle = (task: SearchTask<T>, value: T) => {
    if (task.settled) return
    task.settled = true
    task.resolve(value)
    if (current === task) current = undefined
  }

  const cancel = () => {
    const task = current
    if (!task) return
    if (task.timer) clearTimeout(task.timer)
    task.controller?.abort()
    settle(task, options.fallback())
  }

  const execute = (task: SearchTask<T>) => {
    if (task.settled) return
    task.timer = undefined
    const controller = new AbortController()
    task.controller = controller

    run(task.query, controller.signal).then(
      (result) => settle(task, result),
      () => settle(task, options.fallback()),
    )
  }

  const search = (query: string) => {
    if (current?.query === query) return current.promise
    cancel()

    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    const task: SearchTask<T> = {
      query,
      promise,
      resolve,
      settled: false,
    }
    current = task

    if (!query) {
      execute(task)
      return promise
    }

    task.timer = setTimeout(() => execute(task), options.delayMs)
    return promise
  }

  return { search, cancel }
}
