import { SubagentDefaults } from "@synsci/util/subagents"
import type { Config } from "@synsci/sdk/v2/client"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@synsci/ui/button"
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
  calls: Record<string, { amount: number; state: "pending" | "settled" }>
}
type Pool = {
  enabled?: boolean
  rootSessionID: string
  revision: number
  limits: Record<Unit, number>
  available: Record<Unit, number>
  workers: Record<string, Worker>
}
type Services = { request: ProjectRequest; scope: string; defaults: () => Promise<Defaults> }
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
  budget_limit: "USD limit reached",
  token_limit: "Token limit reached",
  budget_wrapup: "Budget wrap-up",
  deadline: "Deadline reached",
  cancelled: "Cancelled",
  route_changed: "Access route changed",
  pricing_unavailable: "Pricing unavailable",
  setup_required: "Allowance setup required",
}
const reason = (value?: string) => (value ? (reasons[value] ?? value.replaceAll("_", " ")) : undefined)
const amount = (unit: Unit, value: number) =>
  unit === "usd"
    ? `USD ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 9 }).format(value / 1e9)}`
    : `${value.toLocaleString("en-US")} tokens`
const pending = (worker: Worker) =>
  Object.values(worker.calls).reduce((sum, call) => sum + (call.state === "pending" ? call.amount : 0), 0)

class AllowanceError extends Error {
  constructor(readonly status: number) {
    super(`Allowance request failed (${status})`)
  }
}

export function SubagentAllowance(props: { sessionID: string; services?: Services }) {
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
      }
    })()
  const [state, setState] = createStore<{
    pool?: Pool | null
    defaults: Defaults
    attempts: Record<string, Attempt | undefined>
    stopped: Record<string, boolean>
    epoch: number
    loading: boolean
    busy?: string
    error?: string
    defaultsError: boolean
  }>({ defaults: {}, attempts: {}, stopped: {}, epoch: 0, loading: false, defaultsError: false })

  const reset = () =>
    setState({
      pool: undefined,
      defaults: {},
      attempts: {},
      stopped: {},
      epoch: state.epoch + 1,
      loading: false,
      busy: undefined,
      error: undefined,
      defaultsError: false,
    })
  createEffect(on(() => [props.sessionID, services.scope], reset))
  window.addEventListener("openscience:account-changed", reset)
  onCleanup(() => {
    setState("epoch", state.epoch + 1)
    window.removeEventListener("openscience:account-changed", reset)
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
    for (const [id, attempt] of Object.entries(state.attempts)) {
      if (attempt?.stage === "done" && pool?.workers[id]?.assignmentID !== attempt.assignmentID) {
        setState("attempts", id, undefined)
      }
    }
  }
  const load = async () => {
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
        if (epoch === state.epoch) setState("error", "Subagent allowance could not be loaded. Please retry.")
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
    ["budget_limit", "token_limit", "budget_wrapup"].includes(worker.stopReason ?? worker.reportReason ?? "")
  const remaining = (worker: Worker) => (state.pool?.available[worker.unit] ?? 0) > 0
  const label = (worker: Worker, increase = false) => {
    const attempt = state.attempts[worker.sessionID]
    if (attempt?.stage === "continue") return "Retry continuing subagent"
    if (!attempt && remaining(worker) && !increase) return "Continue with remaining allowance"
    const value = attempt?.amount ?? increment(worker)
    return `Increase limit by ${amount(worker.unit, (value ?? 0) * (worker.unit === "usd" ? 1e9 : 1))} and continue`
  }

  const resume = async (worker: Worker, increase = false) => {
    if (!state.pool || state.pool.enabled === false || state.busy || state.loading || !resumable(worker)) return
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
              : "Allowance changed and refreshed totals could not be loaded. Load allowance before approving again.",
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

  return (
    <section class="context-panel__section" aria-label="Subagent allowance">
      <h3 class="context-panel__title">Subagent allowance</h3>
      <p class="context-panel__note">Shared model inference pools. The main agent is outside these limits.</p>
      <Button
        type="button"
        size="small"
        variant="secondary"
        disabled={state.loading || !!state.busy}
        onClick={() => void load()}
      >
        {state.loading
          ? "Loading allowance…"
          : state.pool === undefined
            ? "Load subagent allowance"
            : "Refresh subagent allowance"}
      </Button>
      <Show when={state.pool === null}>
        <p>No subagent pool exists yet. Global defaults in Settings initialize it on first use.</p>
      </Show>
      <Show when={state.pool?.enabled === false}>
        <p>
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
                return (
                  <Show when={pool().limits[unit] > 0 || workers().length > 0}>
                    <p class="context-panel__note">
                      {amount(unit, pool().limits[unit])} approved ·{" "}
                      {amount(
                        unit,
                        workers().reduce((sum, worker) => sum + worker.spent, 0),
                      )}{" "}
                      used
                      {" · "}
                      {amount(
                        unit,
                        workers().reduce((sum, worker) => sum + pending(worker), 0),
                      )}{" "}
                      pending
                    </p>
                  </Show>
                )
              }}
            </For>
            <For each={Object.values(pool().workers)}>
              {(worker) => (
                <details class="context-panel__details">
                  <summary>
                    {worker.objective.trim().split("\n")[0].slice(0, 100)} ·{" "}
                    {worker.active
                      ? "Running"
                      : worker.outcome === "completed" && !worker.stopReason
                        ? "Complete"
                        : "Incomplete"}
                  </summary>
                  <div>
                    <p>
                      {worker.model.providerID}/{worker.model.modelID} · {worker.route}
                    </p>
                    <p>
                      {amount(worker.unit, worker.spent)} used of {amount(worker.unit, worker.limit)} ·{" "}
                      {amount(worker.unit, pending(worker))} pending
                    </p>
                    <Show when={worker.stopReason ?? worker.reportReason}>{(value) => <p>{reason(value())}</p>}</Show>
                    <p>Deadline: {new Date(worker.deadline).toLocaleString()}</p>
                    <Show when={worker.handoff}>
                      <p class="whitespace-pre-wrap break-words">{worker.handoff}</p>
                    </Show>
                    <Show when={!worker.active && worker.stopReason && worker.parentSessionID !== props.sessionID}>
                      <p>Continue this subagent from its immediate parent conversation: {worker.parentSessionID}.</p>
                    </Show>
                    <Show when={resumable(worker)}>
                      <Show
                        when={state.attempts[worker.sessionID]?.stage !== "done"}
                        fallback={<p role="status">Continuation queued for the same subagent.</p>}
                      >
                        <Show
                          when={!state.stopped[worker.sessionID]}
                          fallback={
                            <>
                              <p role="status">Stopped here. The conversation and partial results are kept.</p>
                              <Button
                                type="button"
                                size="small"
                                variant="secondary"
                                onClick={() => setState("stopped", worker.sessionID, false)}
                              >
                                Review continuation
                              </Button>
                            </>
                          }
                        >
                          <Show when={increment(worker) !== undefined && !state.attempts[worker.sessionID]}>
                            <p>
                              If increased: {amount(worker.unit, pool().limits[worker.unit])} →{" "}
                              {amount(
                                worker.unit,
                                pool().limits[worker.unit] + increment(worker)! * (worker.unit === "usd" ? 1e9 : 1),
                              )}{" "}
                              approved total
                            </p>
                          </Show>
                          <div class="flex flex-wrap gap-2">
                            <Show
                              when={
                                remaining(worker) || increment(worker) !== undefined || state.attempts[worker.sessionID]
                              }
                              fallback={
                                <p>Configure an increase amount in General settings to approve a larger pool.</p>
                              }
                            >
                              <Button
                                type="button"
                                size="small"
                                variant={
                                  remaining(worker) && !state.attempts[worker.sessionID] ? "primary" : "secondary"
                                }
                                disabled={!!state.busy || state.loading}
                                onClick={() => void resume(worker)}
                              >
                                {state.busy === worker.sessionID ? "Continuing…" : label(worker)}
                              </Button>
                            </Show>
                            <Show
                              when={
                                remaining(worker) &&
                                increment(worker) !== undefined &&
                                !state.attempts[worker.sessionID]
                              }
                            >
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
                              variant="secondary"
                              disabled={!!state.busy}
                              onClick={() => setState("stopped", worker.sessionID, true)}
                            >
                              Stop here
                            </Button>
                          </div>
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </details>
              )}
            </For>
            <p class="context-panel__note">
              Allowance use is separate from settled Wallet charges. Subscription tokens are not an account quota or
              cash charge. Calls are checked at dispatch boundaries; in-flight usage may exceed a reservation.
            </p>
          </>
        )}
      </Show>
      <Show when={state.defaultsError}>
        <p role="status">Increase defaults could not be loaded. Refresh to retry.</p>
      </Show>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </section>
  )
}
