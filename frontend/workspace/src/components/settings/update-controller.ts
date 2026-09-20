import { createStore } from "solid-js/store"
import type { DesktopUpdateState, Platform } from "@/context/platform"

type State = DesktopUpdateState & {
  available?: string
  checking: boolean
  cancelling: boolean
  dismissed: boolean
}

/**
 * The release this installation can move to right now, if any. A finished
 * update result describes what is already installed, so it never outranks a
 * newer release; an update that is actually in flight does.
 */
export function offeredUpdate(state: Pick<State, "phase" | "available">) {
  if (!state.available) return undefined
  return state.phase === "idle" || state.phase === "succeeded" ? state.available : undefined
}

// What an offer is called when the check reports one without naming a version.
// It cannot be compared with an installed version, so any success spends it.
const UNNAMED = "latest"

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
  let armed: (() => Promise<void>) | undefined

  /** Fire — or drop — the restart armed by one press, now that the state has
   * settled. Never called while a mutation is in flight: the desktop can answer
   * the staging request with an already verified bundle, and a restart started
   * from inside that request would be refused as a concurrent mutation.
   * `mutate` settles that case once any mutation has ended — including a second
   * stage pressed in Settings while the banner's one press was still following
   * the first, which is the request that can answer `ready`. */
  const settleArmed = () => {
    if (!armed) return
    if (state.phase === "ready") {
      const restart = armed
      armed = undefined
      return restart()
    }
    // A discarded, cancelled or failed download ends the one-press intent.
    if (!transitional.has(state.phase)) armed = undefined
  }

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
      // A finished update spends only the offer it installed. A release found
      // since is still ahead of this app and has to survive the result.
      available:
        next.phase === "succeeded"
          ? state.available === next.version || state.available === UNNAMED
            ? undefined
            : state.available
          : (next.version ?? state.available),
      checking: false,
      cancelling: false,
    })
    if (transitional.has(next.phase)) schedule()
    if (!mutation) void settleArmed()
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
      // Whichever request ends the download settles the armed restart, not only
      // the one `downloadAndRestart` started.
      void settleArmed()
    })
    mutation = { action, promise: active }
    return active
  }

  const stage = () =>
    mutate("stage", async () => {
      if (!platform.stageUpdate) throw new Error("In-app staging is unavailable for this installation")
      setState({ phase: "downloading", error: undefined, dismissed: false })
      try {
        merge(await platform.stageUpdate())
      } catch (error) {
        setState({ phase: "failed", error: message(error) })
        throw error
      }
    })

  return {
    state,
    stage,
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
            available: result.updateAvailable ? (result.version ?? UNNAMED) : undefined,
            dismissed: false,
          })
          return result
        } catch (error) {
          setState("checking", false)
          if (!background) throw error
        }
      })
    },
    /** One press: download and verify the update, then restart as soon as it
     * is ready. The restart runs through `restart` so the caller keeps its own
     * confirmation for a restart the server refuses while turns are running. */
    downloadAndRestart(restart: () => Promise<void>) {
      if (state.phase === "ready" || state.phase === "restart_blocked") return restart()
      armed = restart
      return stage().catch((error: unknown) => {
        armed = undefined
        throw error
      })
    },
    /** Restart into the staged update. `mode: "now"` pauses running agent
     * turns, which continue after the restart, instead of being refused. */
    apply(options?: { mode?: "now" }) {
      return mutate("apply", async () => {
        if (!platform.applyUpdate) throw new Error("In-app restart is unavailable for this installation")
        const previous = { phase: state.phase, version: state.version }
        setState({ phase: "restarting", error: undefined, dismissed: false })
        try {
          merge(await platform.applyUpdate(options))
        } catch (error) {
          setState({ ...previous, error: message(error) })
          throw error
        }
      })
    },
    cancel() {
      return mutate("cancel", async () => {
        armed = undefined
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
