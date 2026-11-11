import { SubagentDefaults } from "@synsci/util/subagents"
import { exactUsd, formatUsd } from "@synsci/util/money"
import type { Config } from "@synsci/sdk/v2/client"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import "./subagent-allowance.css"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import type { ProjectRequest } from "@/utils/openscience-fetch"

type Unit = "usd" | "tokens"
type Defaults = { usdIncrease?: number; tokenIncrease?: number }
type Worker = {
  sessionID: string
  parentSessionID: string
  assignmentID: string
  objective: string
  description?: string
  model: { providerID: string; modelID: string }
  route: string
  unit: Unit
  limit: number
  spent: number
  active: boolean
  deadline: number
  stopReason?: string
  outcome?: "completed" | "partial" | "error"
  reportReason?: string
  handoff?: string
  calls: Record<string, { amount: number; state: "pending" | "settled"; consumed?: number }>
}
type Pool = {
  enabled?: boolean
  rootSessionID: string
  revision: number
  limits: Record<Unit, number>
  available: Record<Unit, number>
  continuationCapacity?: Record<string, { available: number; ancestorLimited: boolean }>
  continuations?: Record<string, { childID: string; completed: boolean }>
  workers: Record<string, Worker>
}
type Services = {
  request: ProjectRequest
  scope: string
  defaults: () => Promise<Defaults>
  /** Subscribes to session status changes; returns the unsubscribe function. */
  events?: (listener: (sessionID: string) => void) => () => void
}
type Attempt = {
  assignmentID: string
  unit: Unit
  amount: number
  revision: number
  key: string
  continuation: string
  stage: "increase" | "continue" | "done"
}

const reasons: Record<string, string> = {
  budget_limit: "Reached its limit",
  token_limit: "Reached its limit",
  budget_wrapup: "Budget wrap-up",
  deadline_wrapup: "Deadline wrap-up",
  deadline: "Ran out of time",
  cancelled: "Cancelled",
  route_changed: "Access route changed",
  pricing_unavailable: "Pricing unavailable",
  setup_required: "Allowance setup required",
}
const reason = (value?: string) => (value ? (reasons[value] ?? value.replaceAll("_", " ")) : undefined)
const amount = (unit: Unit, value: number) =>
  unit === "usd" ? formatUsd(value / 1e9) : `${value.toLocaleString("en-US")} tokens`
const exact = (unit: Unit, value: number) =>
  unit === "usd" ? exactUsd(value / 1e9) : `${value.toLocaleString("en-US")} tokens`
const share = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0)
const pending = (worker: Worker) =>
  Object.values(worker.calls).reduce((sum, call) => sum + (call.state === "pending" ? call.amount : 0), 0)

class AllowanceError extends Error {
  constructor(readonly status: number) {
    super(`Allowance request failed (${status})`)
  }
}

/**
 * The subagent budget for a conversation. With `only`, it renders just the continue actions for
 * that worker (used on the worker's card in the chat), sharing the same approval and retry logic.
 */
export function SubagentAllowance(props: { sessionID: string; only?: string; services?: Services }) {
  const services: Services =
    props.services ??
    (() => {
      const sdk = useSDK()
      const global = useGlobalSDK()
      return {
        request: sdk.request,
        get scope() {
          return `${sdk.url}\n${sdk.projectID ?? ""}\n${sdk.directory}\n${sdk.scope}`
        },
        defaults: async () => {
          const config: Config & { subagents?: Defaults } = (await global.client.global.config.get()).data ?? {}
          return config.subagents ?? {}
        },
        events: (listener) =>
          sdk.event.listen((event) => {
            if (event.details.type === "session.status") listener(event.details.properties.sessionID)
          }),
      }
    })()
  const [state, setState] = createStore<{
    pool?: Pool | null
    defaults: Defaults
    attempts: Record<string, Attempt | undefined>
    stopped: Record<string, boolean>
    titles: Record<string, string>
    epoch: number
    loading: boolean
    busy?: string
    error?: string
    defaultsError: boolean
  }>({ defaults: {}, attempts: {}, stopped: {}, titles: {}, epoch: 0, loading: false, defaultsError: false })

  const reset = () =>
    setState({
      pool: undefined,
      defaults: {},
      attempts: {},
      stopped: {},
      titles: {},
      epoch: state.epoch + 1,
      loading: false,
      busy: undefined,
      error: undefined,
      defaultsError: false,
    })
  const restart = () => {
    reset()
    void load()
  }
  createEffect(on(() => [props.sessionID, services.scope], restart))
  window.addEventListener("openscience:account-changed", restart)
  onCleanup(() => {
    setState("epoch", state.epoch + 1)
    window.removeEventListener("openscience:account-changed", restart)
  })

  const json = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await services.request(
      path,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    )
    if (!response.ok) throw new AllowanceError(response.status)
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Expected allowance JSON")
    return response.json() as Promise<T>
  }
  const path = (sessionID: string) => `/session/${encodeURIComponent(sessionID)}/subagents`
  const read = async (sessionID: string, epoch: number) => {
    const pool = await json<Pool | null>(`${path(sessionID)}/budget`)
    if (epoch !== state.epoch) return
    setState("pool", reconcile(pool))
    // Workers saved before the task description was kept are named by their session title.
    for (const worker of Object.values(pool?.workers ?? {})) {
      if (worker.description || state.titles[worker.sessionID] !== undefined) continue
      setState("titles", worker.sessionID, "")
      void json<{ title?: string }>(`/session/${encodeURIComponent(worker.sessionID)}`)
        .then((session) => {
          if (epoch === state.epoch && session.title) setState("titles", worker.sessionID, session.title)
        })
        .catch(() => undefined)
    }
    for (const [id, attempt] of Object.entries(state.attempts)) {
      const worker = pool?.workers[id]
      // A continuation can finish without a new assignment (e.g. a provider error); it is no longer queued.
      const ended = !!pool?.continuations?.[attempt?.continuation ?? ""]?.completed && !worker?.active
      if (attempt?.stage === "done" && (worker?.assignmentID !== attempt.assignmentID || ended)) {
        setState("attempts", id, undefined)
      }
    }
  }
  // The panel loads on open and follows status changes of this conversation and its workers, so a
  // worker or continuation that starts or ends is reflected without a manual refresh.
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const follow = (sessionID: string) => {
    const pool = state.pool
    if (pool === undefined || (sessionID !== props.sessionID && !pool?.workers[sessionID])) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (state.pool === undefined) return
      if (state.loading || state.busy) return follow(props.sessionID)
      void read(props.sessionID, state.epoch).catch(() => undefined)
    }, 250)
  }
  const unsubscribe = services.events?.(follow)
  onCleanup(() => {
    clearTimeout(timer.current)
    unsubscribe?.()
  })

  async function load() {
    if (state.loading || state.busy) return
    const epoch = state.epoch
    const sessionID = props.sessionID
    setState({ loading: true, error: undefined })
    await Promise.all([
      read(sessionID, epoch),
      services
        .defaults()
        .then((defaults) => {
          if (epoch === state.epoch)
            setState({
              defaults: {
                usdIncrease: defaults.usdIncrease ?? SubagentDefaults.usdIncrease,
                tokenIncrease: defaults.tokenIncrease ?? SubagentDefaults.tokenIncrease,
              },
              defaultsError: false,
            })
        })
        .catch(() => {
          if (epoch === state.epoch) setState({ defaults: {}, defaultsError: true })
        }),
    ])
      .catch(() => {
        if (epoch === state.epoch) setState("error", "Subagent budget could not be loaded.")
      })
      .finally(() => {
        if (epoch === state.epoch) setState("loading", false)
      })
  }
  const increment = (worker: Worker) => {
    const value = worker.unit === "usd" ? state.defaults.usdIncrease : state.defaults.tokenIncrease
    return value !== undefined &&
      Number.isFinite(value) &&
      value > 0 &&
      (worker.unit === "usd" || Number.isSafeInteger(value))
      ? value
      : undefined
  }
  const resumable = (worker: Worker) =>
    worker.parentSessionID === props.sessionID &&
    !worker.active &&
    ["budget_limit", "token_limit", "budget_wrapup", "deadline"].includes(
      worker.stopReason ?? worker.reportReason ?? "",
    )
  const timedOut = (worker: Worker) => (worker.stopReason ?? worker.reportReason) === "deadline"
  // One more call like the largest so far must fit, or the continuation would stop at once.
  const minimum = (worker: Worker) => Math.max(1, ...Object.values(worker.calls).map((call) => call.consumed ?? 0))
  const capacity = (worker: Worker) => state.pool?.continuationCapacity?.[worker.sessionID]
  const ancestorLimited = (worker: Worker) =>
    capacity(worker)?.ancestorLimited ?? worker.parentSessionID !== state.pool?.rootSessionID
  const available = (worker: Worker) =>
    capacity(worker)?.available ?? (ancestorLimited(worker) ? 0 : (state.pool?.available[worker.unit] ?? 0))
  const remaining = (worker: Worker) => available(worker) >= minimum(worker)
  const label = (worker: Worker, increase = false) => {
    const attempt = state.attempts[worker.sessionID]
    if (attempt?.stage === "continue") return "Retry continuing subagent"
    if (!attempt && remaining(worker) && !increase)
      return timedOut(worker) ? "Continue with a new deadline" : "Continue with remaining budget"
    const value = attempt?.amount ?? increment(worker)
    return `Add ${amount(worker.unit, (value ?? 0) * (worker.unit === "usd" ? 1e9 : 1))} and continue`
  }

  const resume = async (worker: Worker, increase = false) => {
    if (
      !state.pool ||
      state.pool.enabled === false ||
      state.busy ||
      state.loading ||
      !resumable(worker) ||
      ancestorLimited(worker)
    )
      return
    const epoch = state.epoch
    const sessionID = props.sessionID
    const id = worker.sessionID
    const value = increment(worker)
    if (!state.attempts[id] && (!remaining(worker) || increase) && value === undefined) return
    const attempt =
      state.attempts[id] ??
      ({
        assignmentID: worker.assignmentID,
        unit: worker.unit,
        amount: value ?? 0,
        revision: state.pool.revision,
        key: crypto.randomUUID(),
        continuation: crypto.randomUUID(),
        stage: remaining(worker) && !increase ? "continue" : "increase",
      } satisfies Attempt)
    if (attempt.stage === "done") return
    setState("attempts", id, attempt)
    setState({ busy: id, error: undefined })
    await (async () => {
      if (attempt.stage === "increase") {
        const pool = await json<Pool>(`${path(sessionID)}/budget/increase`, {
          unit: attempt.unit,
          amount: attempt.amount,
          revision: attempt.revision,
          key: attempt.key,
        })
        if (epoch !== state.epoch) return
        setState("pool", reconcile(pool))
        setState("attempts", id, "stage", "continue")
      }
      if (epoch !== state.epoch) return
      const result = await json<{ sessionID: string; callID: string }>(
        `${path(sessionID)}/${encodeURIComponent(id)}/continue`,
        {
          key: attempt.continuation,
        },
      )
      if (result.sessionID !== id || !result.callID) throw new Error("Unexpected continuation identity")
      if (epoch === state.epoch) setState("attempts", id, "stage", "done")
    })()
      .catch(async (error: unknown) => {
        if (epoch !== state.epoch) return
        if (error instanceof AllowanceError && error.status === 409) {
          setState("attempts", id, undefined)
          const refreshed = await read(sessionID, epoch).then(
            () => true,
            () => false,
          )
          if (epoch !== state.epoch) return
          if (!refreshed) setState("pool", undefined)
          setState(
            "error",
            refreshed
              ? "Allowance changed. Review the refreshed totals before approving again."
              : "Allowance changed and refreshed totals could not be loaded. Retry before approving again.",
          )
          return
        }
        setState(
          "error",
          "The action could not be confirmed. Retry to check the same approval or continuation; it will not increase the limit twice.",
        )
      })
      .finally(() => {
        if (epoch === state.epoch) setState("busy", undefined)
      })
  }

  const status = (worker: Worker) =>
    worker.active
      ? "Running"
      : worker.outcome === "completed" && !worker.stopReason
        ? "Complete"
        : (reason(worker.stopReason ?? worker.reportReason) ?? "Incomplete")
  const title = (worker: Worker) =>
    worker.description?.trim() ||
    state.titles[worker.sessionID] ||
    worker.objective.trim().split("\n")[0].slice(0, 100) ||
    "Subagent"
  // Show the pools that workers actually draw from; before any worker starts, show every approved pool.
  const shown = (pool: Pool, unit: Unit) => {
    const units = new Set(Object.values(pool.workers).map((worker) => worker.unit))
    return units.size ? units.has(unit) : pool.limits[unit] > 0
  }
  const tone = (worker: Worker) =>
    worker.active ? "running" : worker.outcome === "completed" && !worker.stopReason ? "complete" : "stopped"

  const actions = (worker: Worker, pool: () => Pool) => (
    <Show when={resumable(worker)}>
      <Show
        when={!ancestorLimited(worker)}
        fallback={
          <p class="context-panel__note">Continue the parent task first to allocate allowance to this subagent.</p>
        }
      >
        <Show
          when={state.attempts[worker.sessionID]?.stage !== "done"}
          fallback={
            <p class="context-panel__note" role="status">
              Continuation queued for the same subagent.
            </p>
          }
        >
          <Show
            when={!state.stopped[worker.sessionID]}
            fallback={
              <div class="allowance__actions">
                <p class="context-panel__note" role="status">
                  Stopped here. The conversation and partial results are kept.
                </p>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  onClick={() => setState("stopped", worker.sessionID, false)}
                >
                  Review continuation
                </Button>
              </div>
            }
          >
            <p class="context-panel__note">
              <Show when={timedOut(worker)}>It ran out of time; continuing gives it a new deadline. </Show>
              <Show
                when={remaining(worker)}
                fallback={
                  <Show when={available(worker) > 0} fallback={<>The conversation budget is used up. </>}>
                    Only {amount(worker.unit, available(worker))} is left, less than its last model call (
                    {amount(worker.unit, minimum(worker))}).{" "}
                  </Show>
                }
              >
                {amount(worker.unit, available(worker))} of the conversation budget is still available.{" "}
              </Show>
              <Show when={increment(worker) !== undefined && !state.attempts[worker.sessionID]}>
                Adding raises the budget from {amount(worker.unit, pool().limits[worker.unit])} to{" "}
                {amount(
                  worker.unit,
                  pool().limits[worker.unit] + increment(worker)! * (worker.unit === "usd" ? 1e9 : 1),
                )}
                .
              </Show>
            </p>
            <div class="allowance__actions">
              <Show
                when={remaining(worker) || increment(worker) !== undefined || state.attempts[worker.sessionID]}
                fallback={
                  <p class="context-panel__note">Set an increase amount in General settings to add to the budget.</p>
                }
              >
                <Button
                  type="button"
                  size="small"
                  variant={remaining(worker) && !state.attempts[worker.sessionID] ? "primary" : "secondary"}
                  disabled={!!state.busy || state.loading}
                  onClick={() => void resume(worker)}
                >
                  {state.busy === worker.sessionID ? "Continuing…" : label(worker)}
                </Button>
              </Show>
              <Show when={remaining(worker) && increment(worker) !== undefined && !state.attempts[worker.sessionID]}>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={!!state.busy || state.loading}
                  onClick={() => void resume(worker, true)}
                >
                  {label(worker, true)}
                </Button>
              </Show>
              <Button
                type="button"
                size="small"
                variant="ghost"
                disabled={!!state.busy}
                onClick={() => setState("stopped", worker.sessionID, true)}
              >
                Stop here
              </Button>
            </div>
          </Show>
        </Show>
      </Show>
    </Show>
  )

  if (props.only)
    return (
      <div class="allowance allowance--inline" aria-label="Subagent actions">
        <Show when={state.pool?.enabled !== false && state.pool?.workers[props.only]}>
          {(worker) => actions(worker(), () => state.pool!)}
        </Show>
        <Show when={state.error}>
          <p class="allowance__error" role="alert">
            {state.error}
          </p>
        </Show>
        <Show when={!state.loading && !state.busy && state.error && state.pool === undefined}>
          <div class="allowance__actions">
            <Button type="button" size="small" variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Show>
      </div>
    )

  return (
    <section class="context-panel__section allowance" aria-label="Subagent budget">
      <header class="allowance__header">
        <h3 class="context-panel__title">Subagent budget</h3>
        <Show when={state.loading && state.pool !== undefined}>
          <span class="allowance__sync" role="status">
            Updating…
          </span>
        </Show>
      </header>
      <Show when={state.loading && state.pool === undefined}>
        <p class="context-panel__note" role="status">
          Loading budget…
        </p>
      </Show>
      <Show when={state.pool === null}>
        <p class="context-panel__note">
          No subagents have run in this conversation yet. The limits in Settings apply when the first one starts.
        </p>
      </Show>
      <Show when={state.pool?.enabled === false}>
        <p class="context-panel__note">
          Bounded runs are off for this conversation. Enable bounded runs in General settings, then start a new
          conversation to use allowances and deadlines. Existing conversations keep their saved mode and limits.
        </p>
      </Show>
      <Show when={state.pool?.enabled !== false && state.pool}>
        {(pool) => (
          <>
            <For each={["usd", "tokens"] as const}>
              {(unit) => {
                const workers = () => Object.values(pool().workers).filter((worker) => worker.unit === unit)
                const used = () => workers().reduce((sum, worker) => sum + worker.spent, 0)
                const held = () => workers().reduce((sum, worker) => sum + pending(worker), 0)
                return (
                  <Show when={shown(pool(), unit)}>
                    <div class="allowance__total">
                      <div class="context-panel__tokens">
                        <strong title={exact(unit, used())}>{amount(unit, used())}</strong>
                        <span>spent of {amount(unit, pool().limits[unit])}</span>
                      </div>
                      <div
                        class="allowance__bar"
                        role="img"
                        aria-label={`${amount(unit, used())} spent of ${amount(unit, pool().limits[unit])}`}
                      >
                        <span data-part="used" style={{ width: `${share(used(), pool().limits[unit])}%` }} />
                        <span
                          data-part="pending"
                          style={{ width: `${share(held(), pool().limits[unit] - used())}%` }}
                        />
                      </div>
                      <p class="allowance__meta">
                        <span title={exact(unit, pool().available[unit])}>
                          {amount(unit, pool().available[unit])} left
                        </span>
                        <Show when={held() > 0}>
                          <span title={exact(unit, held())}>{amount(unit, held())} pending</span>
                        </Show>
                      </p>
                    </div>
                  </Show>
                )
              }}
            </For>
            <p class="context-panel__note">
              The budget for all subagents in this conversation. Each subagent gets its own limit from it; the main
              agent is not limited.
            </p>
            <Show when={Object.keys(pool().workers).length > 0}>
              <ul class="allowance__workers">
                <For each={Object.values(pool().workers)}>
                  {(worker) => (
                    <li>
                      <details class="allowance__worker" data-tone={tone(worker)}>
                        <summary>
                          <i class="allowance__dot" aria-hidden="true" />
                          <span class="allowance__objective">{title(worker)}</span>
                          <span class="allowance__status" data-slot="worker-status">
                            {status(worker)}
                          </span>
                          <span class="allowance__spend" title={exact(worker.unit, worker.spent)}>
                            {amount(worker.unit, worker.spent)} of {amount(worker.unit, worker.limit)}
                          </span>
                        </summary>
                        <div class="allowance__body">
                          <div class="allowance__bar" data-size="small" aria-hidden="true">
                            <span data-part="used" style={{ width: `${share(worker.spent, worker.limit)}%` }} />
                            <span
                              data-part="pending"
                              style={{ width: `${share(pending(worker), worker.limit - worker.spent)}%` }}
                            />
                          </div>
                          <dl class="allowance__facts">
                            <dt>Spent</dt>
                            <dd title={`${exact(worker.unit, worker.spent)} of ${exact(worker.unit, worker.limit)}`}>
                              {amount(worker.unit, worker.spent)} of its {amount(worker.unit, worker.limit)} limit
                            </dd>
                            <Show when={pending(worker) > 0}>
                              <dt>Pending</dt>
                              <dd>{amount(worker.unit, pending(worker))}</dd>
                            </Show>
                            <dt>Model</dt>
                            <dd>
                              {worker.model.providerID}/{worker.model.modelID} · {worker.route}
                            </dd>
                            <dt>Deadline</dt>
                            <dd>{new Date(worker.deadline).toLocaleString()}</dd>
                          </dl>
                          <Show when={worker.handoff}>
                            <p class="allowance__handoff">{worker.handoff}</p>
                          </Show>
                          <Show
                            when={!worker.active && worker.stopReason && worker.parentSessionID !== props.sessionID}
                          >
                            <p class="context-panel__note">
                              Continue this subagent from its immediate parent conversation: {worker.parentSessionID}.
                            </p>
                          </Show>
                          {actions(worker, pool)}
                        </div>
                      </details>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <p class="context-panel__note">
              Spending is checked before each model call, so a call can go slightly over.
              <Show when={shown(pool(), "usd")}> Your actual Wallet charges are under Cost so far.</Show>
            </p>
          </>
        )}
      </Show>
      <Show when={state.defaultsError}>
        <p class="context-panel__note" role="status">
          Increase defaults could not be loaded.
        </p>
      </Show>
      <Show when={state.error}>
        <p class="allowance__error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={!state.loading && !state.busy && (state.defaultsError || (state.error && state.pool === undefined))}>
        <div class="allowance__actions">
          <Button type="button" size="small" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Show>
    </section>
  )
}
