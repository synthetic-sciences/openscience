import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { usageCsv, usageDate, usageModels, usageRange, usageTotals, type UsageRow } from "@synsci/util/usage"
import { downloadBlob } from "@/artifacts/bytes"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import { settingsApi } from "./api"
import "./preference-panels.css"
import "./usage.css"

type Source = "managed" | "byok" | "local" | "subscription" | "unknown"
type Result = { connected: boolean; rows: UsageRow[] }
type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
}
const sources: { id: Source; label: string }[] = [
  { id: "managed", label: "Managed" },
  { id: "byok", label: "API keys" },
  { id: "local", label: "Local models" },
  { id: "subscription", label: "Subscriptions" },
  { id: "unknown", label: "Unclassified" },
]
const number = (value: number) =>
  Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
const money = (value: number) =>
  value > 0 && value < 0.0001
    ? "<$0.0001"
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 })}`
const modelName = (value: string) => value.split("/").pop() ?? value
const dateName = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

export default function Usage(props: { services?: Services } = {}) {
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const [state, setState] = createStore({
    ...usageRange(),
    source: "managed" as Source,
    model: "all",
    period: "30",
    metric: "tokens" as "tokens" | "cost" | "calls",
    active: "",
    refresh: 0,
    local: undefined as Result | undefined,
    managed: undefined as Result | undefined,
    loading: { local: false, managed: false },
    error: { local: "", managed: "" },
  })
  onMount(() => {
    const refresh = () => setState({ model: "all", refresh: state.refresh + 1 })
    window.addEventListener("openscience:account-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:account-changed", refresh))
  })
  const valid = createMemo(
    () =>
      usageDate(state.start) &&
      usageDate(state.end) &&
      state.start <= state.end &&
      (Date.parse(state.end) - Date.parse(state.start)) / 86_400_000 < 366,
  )
  createEffect(() => {
    const start = state.start
    const end = state.end
    state.refresh
    if (!valid()) return
    const controller = new AbortController()
    setState({ local: undefined, managed: undefined, active: "" })
    for (const source of ["local", "managed"] as const) {
      setState("loading", source, true)
      setState("error", source, "")
      void settingsApi<Result>(
        sdk.url,
        platform.fetch ?? fetch,
        `/settings/usage/${source}?${new URLSearchParams({ start, end })}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) setState(source, result)
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setState("error", source, cause instanceof Error ? cause.message : "Usage could not be loaded.")
        })
        .finally(() => {
          if (!controller.signal.aborted) setState("loading", source, false)
        })
    }
    onCleanup(() => controller.abort())
  })
  const dataset = () => (state.source === "managed" ? "managed" : "local")
  const loading = () => state.loading[dataset()]
  const available = () => state[dataset()]
  const filtered = createMemo(() =>
    (available()?.rows ?? []).filter((row) =>
      state.source === "byok"
        ? row.route === "byok" || row.route === "custom"
        : state.source === "subscription"
          ? row.route === "subscription" || row.route === "chatgpt"
          : row.route === state.source,
    ),
  )
  const options = createMemo(() => [...new Set(filtered().map((row) => row.model))].sort())
  const rows = createMemo(() => filtered().filter((row) => state.model === "all" || row.model === state.model))
  const totals = createMemo(() => usageTotals(rows()))
  const models = createMemo(() => usageModels(rows()))
  const days = createMemo(() => {
    if (!valid()) return []
    const count = Math.round((Date.parse(state.end) - Date.parse(state.start)) / 86_400_000) + 1
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.parse(state.start) + index * 86_400_000).toISOString().slice(0, 10)
      return { date, ...usageTotals(rows().filter((row) => row.date === date)) }
    })
  })
  const max = () => Math.max(Number.EPSILON, ...days().map((day) => day[state.metric]))
  const active = () => days().find((day) => day.date === state.active)
  const exportCsv = () => {
    if (loading() || !valid() || !rows().length) return
    downloadBlob(
      `openscience-${state.source}-usage-${state.start}-${state.end}.csv`,
      new Blob(["\uFEFF", usageCsv(rows())], { type: "text/csv;charset=utf-8" }),
    )
  }
  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-usage">
        <PanelHeader
          title="Usage"
          description="Track model activity, costs, and tokens."
          toolbar={
            <Button
              size="small"
              variant="secondary"
              disabled={loading() || !valid()}
              onClick={() => setState("refresh", (value) => value + 1)}
            >
              Refresh
            </Button>
          }
        />
        <PanelBody>
          <div class="usage-source-tabs" role="group" aria-label="Usage source">
            <For each={sources}>
              {(source) => (
                <button
                  type="button"
                  aria-pressed={state.source === source.id}
                  onClick={() => setState({ source: source.id, model: "all", active: "" })}
                >
                  {source.label}
                </button>
              )}
            </For>
          </div>
          <div class="usage-controls">
            <label>
              Period
              <select
                value={state.period}
                onChange={(event) => {
                  const period = event.currentTarget.value
                  setState("period", period)
                  if (period !== "custom") setState(usageRange(Number(period)))
                }}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="custom">Custom dates</option>
              </select>
            </label>
            <label>
              From
              <input
                type="date"
                aria-label="From date"
                value={state.start}
                max={state.end}
                onInput={(event) => setState({ start: event.currentTarget.value, period: "custom" })}
              />
            </label>
            <label>
              To
              <input
                type="date"
                aria-label="To date"
                value={state.end}
                min={state.start}
                onInput={(event) => setState({ end: event.currentTarget.value, period: "custom" })}
              />
            </label>
            <label>
              Model
              <select value={state.model} onChange={(event) => setState("model", event.currentTarget.value)}>
                <option value="all">All models</option>
                <For each={options()}>{(model) => <option value={model}>{modelName(model)}</option>}</For>
              </select>
            </label>
          </div>
          <Show when={!valid()}>
            <p class="settings-alert" data-tone="critical" role="alert">
              Choose valid dates in order, spanning no more than 366 days.
            </p>
          </Show>
          <p class="usage-scope">
            {state.source === "managed"
              ? "Your confirmed Wallet charges in the selected funding workspace, across devices."
              : state.source === "unknown"
                ? "Older activity on this device without a recorded access route. It may include managed calls and is kept separate to avoid double-counting."
                : state.source === "local"
                  ? "Saved conversation activity on this device, across projects. Local inference has no provider charge."
                  : state.source === "subscription"
                    ? "ChatGPT and subscription activity on this device. Subscription fees are not included."
                    : "API-key activity in saved conversations on this device, across projects. Costs are estimates; your provider bills you directly."}{" "}
            Dates use UTC.
          </p>
          <Show when={state.error[dataset()]}>
            <div class="settings-alert" data-tone="critical" role="alert">
              {state.error[dataset()]}{" "}
              <button type="button" onClick={() => setState("refresh", (value) => value + 1)}>
                Retry
              </button>
            </div>
          </Show>
          <Show when={valid() && !state.error[dataset()]}>
            <Show
              when={!loading()}
              fallback={
                <div class="usage-empty" role="status">
                  Loading usage…
                </div>
              }
            >
              <Show
                when={available()?.connected !== false}
                fallback={
                  <div class="usage-empty">
                    Connect your Synthetic Sciences account in Ace to see managed usage. API-key and local activity are
                    available without signing in.
                  </div>
                }
              >
                <dl class="usage-totals">
                  <div>
                    <dt>{state.source === "managed" ? "Wallet charges" : "Estimated cost"}</dt>
                    <dd>{money(totals().cost)}</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>{number(totals().tokens)}</dd>
                  </div>
                  <div>
                    <dt>Requests</dt>
                    <dd>{totals().calls.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Cached input</dt>
                    <dd>{number(totals().cacheRead)}</dd>
                  </div>
                </dl>
                <section class="usage-chart" aria-label="Daily usage">
                  <header>
                    <h3>Daily activity</h3>
                    <select
                      aria-label="Chart metric"
                      value={state.metric}
                      onChange={(event) => setState("metric", event.currentTarget.value as typeof state.metric)}
                    >
                      <option value="tokens">Tokens</option>
                      <option value="cost">Cost</option>
                      <option value="calls">Requests</option>
                    </select>
                  </header>
                  <div class="usage-chart-scroll">
                    <div
                      class="usage-bars"
                      style={{
                        "grid-template-columns": `repeat(${days().length}, minmax(5px, 1fr))`,
                        "min-width": `${days().length * 7}px`,
                      }}
                    >
                      <For each={days()}>
                        {(day) => (
                          <button
                            type="button"
                            aria-label={`${day.date}: ${day.tokens.toLocaleString()} tokens, ${day.calls} requests, ${money(day.cost)}`}
                            aria-pressed={state.active === day.date}
                            onFocus={() => setState("active", day.date)}
                            onClick={() => setState("active", day.date)}
                            onMouseEnter={() => setState("active", day.date)}
                          >
                            <span
                              style={{
                                height: `${Math.max(day[state.metric] > 0 ? 2 : 0.5, (day[state.metric] / max()) * 100)}%`,
                              }}
                            />
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                  <div class="usage-axis">
                    <span>{dateName(state.start)}</span>
                    <span>{dateName(state.end)}</span>
                  </div>
                  <p class="usage-chart-detail" aria-live="polite">
                    {active()
                      ? `${dateName(active()!.date)} · ${number(active()!.tokens)} tokens · ${active()!.calls} requests · ${money(active()!.cost)}`
                      : "Select a day to see its activity."}
                  </p>
                </section>
                <section class="usage-models">
                  <h3>
                    By model <span>{models().length}</span>
                  </h3>
                  <Show
                    when={models().length}
                    fallback={<div class="usage-empty">No activity for these dates and filters.</div>}
                  >
                    <div class="usage-table-scroll" role="region" aria-label="Model usage" tabIndex={0}>
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Model</th>
                            <th scope="col">Requests</th>
                            <th scope="col">Tokens</th>
                            <th scope="col">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={models()}>
                            {(row) => (
                              <tr>
                                <td>
                                  <strong>{modelName(row.model)}</strong>
                                  <Show when={state.source !== "managed"}>
                                    <small>{row.provider}</small>
                                  </Show>
                                </td>
                                <td>{row.calls.toLocaleString()}</td>
                                <td>{number(row.tokens)}</td>
                                <td>{money(row.cost)}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </section>
              </Show>
            </Show>
          </Show>
          <footer class="usage-export">
            <div>
              <strong>Export usage</strong>
              <p>
                Daily totals by model for the selected source, dates, and model. Includes token details and costs in
                USD.
              </p>
            </div>
            <Button
              size="small"
              variant="secondary"
              disabled={loading() || !valid() || !!state.error[dataset()] || !rows().length}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          </footer>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
