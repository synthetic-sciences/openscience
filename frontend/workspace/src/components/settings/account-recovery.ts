import { withAccountDeadline } from "./account-deadline"

/** One bounded request at a time; recover transient failures without a poll loop. */
export function createAccountRecovery<T>(options: {
  read: (signal: AbortSignal) => Promise<T>
  apply: (value: T) => void
  loading: () => void
  failed: (error: unknown) => void
  retry: (value: T) => boolean
  active?: () => boolean
  timeoutMs: number
  delays?: number[]
}) {
  const delays = options.delays ?? [2_000, 5_000, 15_000, 30_000]
  const state: {
    epoch: number
    attempts: number
    disposed: boolean
    pending?: Promise<void>
    controller?: AbortController
    timer?: ReturnType<typeof setTimeout>
  } = { epoch: 0, attempts: 0, disposed: false }

  const clear = () => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }
  const schedule = () => {
    clear()
    if (state.disposed) return
    const delay = delays[Math.min(state.attempts++, delays.length - 1)] ?? 30_000
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (options.active?.() === false) return
      void load()
    }, delay)
  }
  const load = (): Promise<void> => {
    if (state.disposed) return Promise.resolve()
    if (state.pending) return state.pending
    clear()
    const epoch = state.epoch
    const controller = new AbortController()
    state.controller = controller
    options.loading()
    const current = () => !state.disposed && state.epoch === epoch
    const pending = withAccountDeadline(
      (signal) => options.read(AbortSignal.any([signal, controller.signal])),
      options.timeoutMs,
    )
      .then((value) => {
        if (!current()) return
        options.apply(value)
        if (options.retry(value)) schedule()
        else state.attempts = 0
      })
      .catch((error) => {
        if (!current()) return
        options.failed(error)
        schedule()
      })
      .finally(() => {
        if (state.pending !== pending) return
        state.pending = undefined
        state.controller = undefined
      })
    state.pending = pending
    return pending
  }
  const invalidate = () => {
    state.epoch++
    clear()
    state.controller?.abort()
    state.controller = undefined
    state.pending = undefined
    state.attempts = 0
  }
  return {
    load,
    invalidate,
    dispose: () => {
      state.disposed = true
      invalidate()
    },
  }
}
