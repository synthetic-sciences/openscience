import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { ExperimentRun, ExperimentSeries, LocalGpu, Study, StudyOverview } from "@synsci/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { uiStore } from "@/atlas/store/ui"
import { colorFor, formatValue, MetricChart } from "./experiments/MetricChart"
import "./ExperimentsPane.css"

type Selection = Set<string>

function duration(run: ExperimentRun, now: number) {
  if (!run.startedAt) return ""
  const end = run.endedAt ?? now
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function delta(run: ExperimentRun) {
  if (run.baselineDelta === null || run.baselineDelta === undefined) return ""
  return `${run.baselineDelta >= 0 ? "+" : ""}${formatValue(run.baselineDelta)}`
}

/**
 * Experiments: tracked runs with their metrics, and the studies that
 * hill-climb over them. The pane is an instrument: it never edits code or
 * starts runs. Pause, resume and halt are the operator's controls; the
 * science stays in the session.
 */
export function ExperimentsPane(): JSX.Element {
  const sdk = useSDK()
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))

  const read = async <T,>(path: string, init?: RequestInit, query?: Record<string, string>) => {
    const response = await sdk.request(path, init, query)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return (await response.json()) as T
  }

  const [version, setVersion] = createSignal(0)
  const [pointsVersion, setPointsVersion] = createSignal(0)
  const bump = (() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        setVersion((value) => value + 1)
      }, 400)
    }
  })()
  const bumpPoints = (() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        setPointsVersion((value) => value + 1)
      }, 1000)
    }
  })()
  createEffect(() => {
    const subscriptions = [
      sdk.event.on("experiment.run.updated", bump),
      sdk.event.on("experiment.study.updated", bump),
      sdk.event.on("experiment.idea.updated", bump),
      sdk.event.on("experiment.study.event", bump),
      sdk.event.on("experiment.run.points", bumpPoints),
    ]
    onCleanup(() => subscriptions.forEach((unsubscribe) => unsubscribe()))
  })

  const [studies] = createResource(version, () => read<Study[]>("/experiments/studies"))
  const [runs] = createResource(version, () => read<ExperimentRun[]>("/experiments/runs", undefined, { limit: "300" }))
  const [gpus] = createResource(
    () => Math.floor(now() / 5000),
    () => read<LocalGpu[]>("/experiments/gpus"),
  )

  // Tabs: one per study, plus every run in the project. Nothing selected
  // means the live study, else the newest, else all runs.
  const [tab, setTab] = createSignal<string>()
  const activeStudy = createMemo(() => {
    const list = studies.latest ?? []
    const chosen = tab()
    if (chosen === "all") return undefined
    const picked = chosen ? list.find((study) => study.id === chosen) : undefined
    return picked ?? list.find((study) => study.status === "running" || study.status === "paused") ?? list[0]
  })
  const select = (value: string) => {
    setTab(value)
    setTouched(false)
    setDetail(undefined)
  }
  const [overview] = createResource(
    () => (activeStudy() ? `${activeStudy()!.id}:${version()}` : undefined),
    (key) => read<StudyOverview>(`/experiments/studies/${key.split(":")[0]}`),
  )

  const visibleRuns = createMemo(() => {
    const all = runs.latest ?? []
    const study = activeStudy()
    return study ? all.filter((run) => run.studyID === study.id) : all
  })

  // Chart selection: the baseline, the best and the newest runs by default.
  const [selected, setSelected] = createSignal<Selection>(new Set())
  const [touched, setTouched] = createSignal(false)
  createEffect(() => {
    if (touched()) return
    const list = visibleRuns()
    const study = activeStudy()
    // Killed and failed runs stay off the chart until asked for: a diverging
    // run flattens every other curve against its own scale.
    const defaults = new Set<string>()
    if (study?.baselineRunID) defaults.add(study.baselineRunID)
    if (study?.bestRunID) defaults.add(study.bestRunID)
    for (const run of list.filter((run) => run.status !== "killed" && run.status !== "failed").slice(0, 6)) {
      defaults.add(run.id)
    }
    setSelected(defaults)
  })
  const toggle = (id: string) => {
    setTouched(true)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const [keys] = createResource(
    () => `${[...selected()].join(",")}:${version()}`,
    (key) => {
      const ids = key.split(":")[0]!
      return ids ? read<string[]>("/experiments/keys", undefined, { run_ids: ids }) : Promise.resolve([])
    },
  )
  const [key, setKey] = createSignal<string>()
  const metricKey = createMemo(() => {
    const available = keys.latest ?? []
    const chosen = key()
    if (chosen && available.includes(chosen)) return chosen
    const study = activeStudy()
    if (study && available.includes(study.metric)) return study.metric
    return available[0]
  })
  const [smoothing, setSmoothing] = createSignal(0)
  const [log, setLog] = createSignal(false)
  const [series] = createResource(
    () => {
      const ids = [...selected()].join(",")
      const metric = metricKey()
      return ids && metric ? `${ids}|${metric}|${pointsVersion()}|${version()}` : undefined
    },
    (spec) => {
      const [ids, metric] = spec.split("|")
      return read<ExperimentSeries>("/experiments/series", undefined, { run_ids: ids!, keys: metric!, max: "400" })
    },
  )
  const chart = createMemo(() => {
    const list = visibleRuns()
    const order = new Map(list.map((run, index) => [run.id, index]))
    return (series.latest ?? [])
      .map((item) => ({
        id: item.runID,
        label: list.find((run) => run.id === item.runID)?.name ?? item.runID,
        color: colorFor(order.get(item.runID) ?? 0),
        points: item.points,
      }))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  })

  const [detail, setDetail] = createSignal<string>()
  const detailRun = createMemo(() => visibleRuns().find((run) => run.id === detail()))
  const [detailSeries] = createResource(
    () => (detail() ? `${detail()}|${pointsVersion()}|${version()}` : undefined),
    (spec) => read<ExperimentSeries>("/experiments/series", undefined, { run_ids: spec.split("|")[0]!, max: "200" }),
  )

  const control = async (study: Study, action: "pause" | "resume" | "halt") => {
    if (action === "halt" && !window.confirm(`Halt "${study.name}"? Live runs are cancelled and the loop stops.`))
      return
    await sdk.request(`/experiments/studies/${study.id}/${action}`, { method: "POST" })
    bump()
  }
  const writeUp = (study: Study) => {
    uiStore.setPrefill(
      `Write up the study "${study.name}" (${study.id}): read its ledger (study.md, ideas.md, results.tsv, lessons.md) and the tracked runs, then draft the results section with the baseline, the best configuration, the ablations that mattered, and the figures the data supports.`,
    )
  }

  const status = (value: string) => (
    <em class="experiments-status" data-status={value}>
      {value}
    </em>
  )

  return (
    <section class="experiments-pane" aria-label="Experiments">
      <header class="experiments-pane__header">
        <div class="experiments-tabs" role="tablist" aria-label="Studies and runs">
          <For each={studies.latest ?? []}>
            {(study) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeStudy()?.id === study.id}
                data-status={study.status}
                title={`${study.name}: ${study.status}`}
                onClick={() => select(study.id)}
              >
                <i aria-hidden="true" />
                <span>{study.name}</span>
              </button>
            )}
          </For>
          <button type="button" role="tab" aria-selected={!activeStudy()} onClick={() => select("all")}>
            <span>All runs</span>
            <em>{(runs.latest ?? []).length}</em>
          </button>
        </div>
        <Show when={(gpus.latest ?? []).length}>
          <ul class="experiments-gpus" aria-label="Local GPUs">
            <For each={gpus.latest ?? []}>
              {(gpu) => (
                <li
                  title={`${gpu.name}: ${gpu.utilization}% busy, ${Math.round(gpu.memoryUsedMB / 1024)} of ${Math.round(gpu.memoryTotalMB / 1024)} GB`}
                >
                  <span class="experiments-gpus__index">GPU {gpu.index}</span>
                  <span class="experiments-gpus__bar">
                    <i style={{ width: `${gpu.utilization}%` }} />
                  </span>
                  <span class="experiments-gpus__value">{gpu.utilization}%</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </header>

      <div class="experiments-pane__body">
        <Show when={activeStudy()}>
          {(study) => (
            <article class="study-card" data-status={study().status}>
              <header class="study-card__head">
                <div class="study-card__identity">
                  <strong>{study().name}</strong>
                  {status(study().status)}
                </div>
                <div class="study-card__controls">
                  <Show when={study().status === "running"}>
                    <button type="button" onClick={() => void control(study(), "pause")}>
                      Pause
                    </button>
                  </Show>
                  <Show when={study().status === "paused"}>
                    <button type="button" onClick={() => void control(study(), "resume")}>
                      Resume
                    </button>
                  </Show>
                  <Show when={study().status === "running" || study().status === "paused"}>
                    <button type="button" data-danger onClick={() => void control(study(), "halt")}>
                      Halt
                    </button>
                  </Show>
                  <button type="button" onClick={() => writeUp(study())}>
                    Write up
                  </button>
                </div>
              </header>
              <p class="study-card__purpose">{study().purpose}</p>
              <dl class="study-card__facts">
                <div>
                  <dt>Objective</dt>
                  <dd>
                    {study().direction} <code>{study().metric}</code>
                  </dd>
                </div>
                <div>
                  <dt>Baseline</dt>
                  <dd>
                    {overview.latest?.baseline
                      ? `${overview.latest.baseline.name} · ${overview.latest.baseline.headline === null ? "n/a" : formatValue(overview.latest.baseline.headline)}`
                      : "not set"}
                  </dd>
                </div>
                <div>
                  <dt>Best</dt>
                  <dd>
                    {overview.latest?.best
                      ? `${overview.latest.best.name} · ${overview.latest.best.headline === null ? "n/a" : formatValue(overview.latest.best.headline)}${
                          overview.latest.best.baselineDelta !== null &&
                          overview.latest.best.baselineDelta !== undefined
                            ? ` (${delta(overview.latest.best)})`
                            : ""
                        }`
                      : "none yet"}
                  </dd>
                </div>
                <div>
                  <dt>Runs</dt>
                  <dd>
                    {(overview.latest?.runs ?? []).filter((run) => run.status !== "running").length} done ·{" "}
                    {(overview.latest?.runs ?? []).filter((run) => run.status === "running").length}/
                    {study().concurrency} live
                    {study().budget.maxRuns ? ` · limit ${study().budget.maxRuns}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Queue</dt>
                  <dd>{(overview.latest?.ideas ?? []).filter((idea) => idea.status === "queued").length} ideas</dd>
                </div>
                <div>
                  <dt>Elapsed</dt>
                  <dd>
                    {((now() - study().createdAt) / 3_600_000).toFixed(1)} h
                    {study().budget.maxHours ? ` of ${study().budget.maxHours}` : ""}
                    {" · "}
                    {study().turns} turn{study().turns === 1 ? "" : "s"}
                  </dd>
                </div>
              </dl>
              <Show when={study().killCriteria}>
                <p class="study-card__rule">Kill criteria: {study().killCriteria}</p>
              </Show>
              <Show when={(overview.latest?.ideas ?? []).length}>
                <details class="study-card__ideas">
                  <summary>Ideas ({(overview.latest?.ideas ?? []).length})</summary>
                  <ul>
                    <For each={overview.latest?.ideas ?? []}>
                      {(idea) => (
                        <li data-status={idea.status}>
                          <span class="study-idea__title">{idea.title}</span>
                          <span class="study-idea__meta">
                            ev {idea.ev}
                            {idea.priority ? ` · p${idea.priority}` : ""}
                          </span>
                          {status(idea.status)}
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              </Show>
              <Show when={(overview.latest?.events ?? []).length}>
                <details class="study-card__events">
                  <summary>Activity</summary>
                  <ul>
                    <For each={(overview.latest?.events ?? []).slice(0, 20)}>
                      {(event) => (
                        <li>
                          <time>
                            {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </time>
                          <span>{event.message}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              </Show>
            </article>
          )}
        </Show>

        <section class="experiments-chart" aria-label="Metric chart">
          <header class="experiments-chart__head">
            <label>
              <span>Metric</span>
              <select value={metricKey() ?? ""} onChange={(event) => setKey(event.currentTarget.value)}>
                <For each={keys.latest ?? []}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </label>
            <label>
              <span>Smooth</span>
              <input
                type="range"
                min="0"
                max="0.95"
                step="0.05"
                value={smoothing()}
                onInput={(event) => setSmoothing(Number(event.currentTarget.value))}
              />
            </label>
            <label class="experiments-chart__toggle">
              <input type="checkbox" checked={log()} onChange={(event) => setLog(event.currentTarget.checked)} />
              <span>log</span>
            </label>
          </header>
          <MetricChart series={chart()} height={190} log={log()} smoothing={smoothing()} emphasize={detail()} />
        </section>

        <section class="experiments-runs" aria-label="Runs">
          <Show
            when={visibleRuns().length}
            fallback={
              <div class="experiments-empty">
                <strong>No tracked runs yet</strong>
                <span>
                  Import <code>openscience_track</code> (or <code>wandb</code>) in a script run through compute, or ask
                  for a study: "start an autoresearch study on …".
                </span>
              </div>
            }
          >
            <table>
              <colgroup>
                <col class="eye" />
                <col />
                <col class="status" />
                <col class="value" />
                <col class="delta" />
                <col class="time" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Show on chart" />
                  <th>Run</th>
                  <th>Status</th>
                  <th class="num">{activeStudy()?.metric ?? "headline"}</th>
                  <th class="num delta">Δ</th>
                  <th class="num time">Time</th>
                </tr>
              </thead>
              <tbody>
                <For each={visibleRuns()}>
                  {(run, index) => (
                    <tr
                      data-selected={detail() === run.id ? "true" : undefined}
                      data-role={
                        run.id === activeStudy()?.baselineRunID
                          ? "baseline"
                          : run.id === activeStudy()?.bestRunID
                            ? "best"
                            : undefined
                      }
                      onClick={() => setDetail(detail() === run.id ? undefined : run.id)}
                    >
                      <td>
                        <button
                          type="button"
                          class="experiments-eye"
                          aria-pressed={selected().has(run.id)}
                          aria-label={`${selected().has(run.id) ? "Hide" : "Show"} ${run.name} on the chart`}
                          style={{ "--run-color": colorFor(index()) }}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggle(run.id)
                          }}
                        />
                      </td>
                      <td class="experiments-runs__name">
                        <span>{run.name}</span>
                        <Show when={run.id === activeStudy()?.baselineRunID}>
                          <em>baseline</em>
                        </Show>
                        <Show when={run.id === activeStudy()?.bestRunID}>
                          <em>best</em>
                        </Show>
                      </td>
                      <td>{status(run.status)}</td>
                      <td class="num">{run.headline === null ? "" : formatValue(run.headline)}</td>
                      <td
                        class="num delta"
                        data-sign={run.baselineDelta === null ? undefined : run.baselineDelta >= 0 ? "up" : "down"}
                      >
                        {delta(run)}
                      </td>
                      <td class="num time">{duration(run, now())}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>

        <Show when={detailRun()}>
          {(run) => (
            <section class="experiments-detail" aria-label={`Run ${run().name}`}>
              <header>
                <strong>{run().name}</strong>
                {status(run().status)}
                <span class="experiments-detail__id">{run().id}</span>
                <button type="button" onClick={() => setDetail(undefined)} aria-label="Close run details">
                  ×
                </button>
              </header>
              <Show when={run().killReason}>
                <p class="experiments-detail__reason">{run().killReason}</p>
              </Show>
              <div class="experiments-detail__grid">
                <div>
                  <h4>Config</h4>
                  <dl>
                    <For each={Object.entries(run().config ?? {})}>
                      {([name, value]) => (
                        <div>
                          <dt>{name}</dt>
                          <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </div>
                <div>
                  <h4>Summary</h4>
                  <dl>
                    <For each={Object.entries(run().summary ?? {})}>
                      {([name, value]) => (
                        <div>
                          <dt>{name}</dt>
                          <dd>{typeof value === "number" ? formatValue(value) : String(value)}</dd>
                        </div>
                      )}
                    </For>
                    <div>
                      <dt>points</dt>
                      <dd>{run().points}</dd>
                    </div>
                    <Show when={run().jobID}>
                      <div>
                        <dt>job</dt>
                        <dd>{run().jobID}</dd>
                      </div>
                    </Show>
                  </dl>
                </div>
              </div>
              <div class="experiments-detail__charts">
                <For each={[...new Set((detailSeries.latest ?? []).map((item) => item.key))]}>
                  {(name) => (
                    <div class="experiments-detail__chart">
                      <h4>{name}</h4>
                      <MetricChart
                        height={120}
                        series={(detailSeries.latest ?? [])
                          .filter((item) => item.key === name)
                          .map((item) => ({ id: item.runID, label: name, color: colorFor(0), points: item.points }))}
                      />
                    </div>
                  )}
                </For>
              </div>
            </section>
          )}
        </Show>
      </div>
    </section>
  )
}
