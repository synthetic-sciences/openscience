import { createStore } from "solid-js/store"
import type { DesktopUpdateState, Platform } from "@/context/platform"

type State = DesktopUpdateState & {
  available?: string
  checking: boolean
  cancelling: boolean
  dismissed: boolean
}

const controllers = new WeakMap<object, ReturnType<typeof createUpdateController>>()
// Phases the supervisor advances on its own. A blocked restart is not one of
// them: it waits for the user, so polling it only burns the transport.
const transitional = new Set<DesktopUpdateState["phase"]>(["downloading", "extracting", "verifying", "restarting"])
const POLL_MS = 500
const POLL_BACKOFF_AFTER = 20
const POLL_MAX_MS = 30_000

/** Half-second reads for the first ten seconds of a transition, then doubling up to a 30 s ceiling. */
export function pollDelay(polls: number) {
  if (polls < POLL_BACKOFF_AFTER) return POLL_MS
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** (polls - POLL_BACKOFF_AFTER + 1))
}

export function createUpdateController(
  platform: Platform,
  options: { schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout> } = {},
) {
  const [state, setState] = createStore<State>({
    phase: "idle",
    checking: false,
    cancelling: false,
    dismissed: false,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let polls = 0
  const pending = new Map<string, Promise<unknown>>()
  let mutation: { action: string; promise: Promise<unknown> } | undefined
  let syncing: Promise<DesktopUpdateState | undefined> | undefined

  const merge = (next: DesktopUpdateState) => {
    setState({
      phase: next.phase,
      version: next.version,
      transferred: next.transferred,
      total: next.total,
      progress: next.progress,
      completed_at: next.completed_at,
      error: next.error,
      migration_required: next.migration_required,
      available: next.phase === "succeeded" ? undefined : (next.version ?? state.available),
      checking: false,
      cancelling: false,
    })
    if (transitional.has(next.phase)) schedule()
  }

  const sync = () => {
    if (syncing) return syncing
    if (!platform.updateState) return Promise.resolve(undefined)
    const active = platform
      .updateState()
      .then((next) => {
        merge(next)
        return next
      })
      .finally(() => {
        if (syncing === active) syncing = undefined
      })
    syncing = active
    return active
  }

  const schedule = () => {
    clearTimeout(timer)
    const delay = pollDelay(polls)
    polls++
    timer = (options.schedule ?? setTimeout)(
      () => void sync().catch((error) => setState({ phase: "failed", error: message(error) })),
      delay,
    )
  }

  const once = <T>(action: string, run: () => Promise<T>) => {
    const existing = pending.get(action)
    if (existing) return existing as Promise<T>
    const active = run().finally(() => {
      if (pending.get(action) === active) pending.delete(action)
    })
    pending.set(action, active)
    return active
  }

  const mutate = <T>(action: string, run: () => Promise<T>) => {
    if (mutation) {
      if (mutation.action === action) return mutation.promise as Promise<T>
      return Promise.reject(
        new Error(`OpenScience is already ${mutation.action === "apply" ? "restarting" : "updating"}`),
      )
    }
    // The user acted, so the supervisor is expected to move again soon.
    polls = 0
    const active = run().finally(() => {
      if (mutation?.promise === active) mutation = undefined
    })
    mutation = { action, promise: active }
    return active
  }

  return {
    state,
    start() {
      void sync().catch(() => undefined)
    },
    check(background = false) {
      return once("check", async () => {
        if (!platform.checkUpdate) return
        polls = 0
        setState("checking", true)
        try {
          const result = await platform.checkUpdate({ refresh: !background })
          setState({
            checking: false,
            available: result.updateAvailable ? (result.version ?? "latest") : undefined,
            dismissed: false,
          })
          return result
        } catch (error) {
          setState("checking", false)
          if (!background) throw error
        }
      })
    },
    stage() {
      return mutate("stage", async () => {
        if (!platform.stageUpdate) throw new Error("In-app staging is unavailable for this installation")
        setState({ phase: "downloading", error: undefined, dismissed: false })
        try {
          merge(await platform.stageUpdate())
        } catch (error) {
          setState({ phase: "failed", error: message(error) })
          throw error
        }
      })
    },
    apply() {
      return mutate("apply", async () => {
        if (!platform.applyUpdate) throw new Error("In-app restart is unavailable for this installation")
        const previous = { phase: state.phase, version: state.version }
        setState({ phase: "restarting", error: undefined, dismissed: false })
        try {
          merge(await platform.applyUpdate())
        } catch (error) {
          setState({ ...previous, error: message(error) })
          throw error
        }
      })
    },
    cancel() {
      return mutate("cancel", async () => {
        if (!platform.cancelUpdate) return
        clearTimeout(timer)
        setState("cancelling", true)
        try {
          merge(await platform.cancelUpdate())
        } finally {
          setState("cancelling", false)
        }
      })
    },
    dismiss() {
      setState("dismissed", true)
    },
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function updateController(platform: Platform) {
  const existing = controllers.get(platform)
  if (existing) return existing
  const created = createUpdateController(platform)
  controllers.set(platform, created)
  return created
}

export function formatUpdateBytes(value: number | undefined) {
  if (value === undefined) return ""
  const units = ["B", "KiB", "MiB", "GiB"]
  let amount = Math.max(0, value)
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit++
  }
  const digits = unit === 0 || amount >= 10 ? 0 : 1
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(amount)} ${units[unit]}`
}
