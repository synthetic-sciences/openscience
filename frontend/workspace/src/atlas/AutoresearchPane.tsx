import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { ExperimentRun, ExperimentSeries, LocalGpu, Study, StudyOverview } from "@synsci/sdk/v2/client"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { useSDK } from "@/context/sdk"
import { uiStore } from "@/atlas/store/ui"
import { IconActivity } from "@/atlas/shared/Icon"
import { colorFor, formatValue, HillClimbChart, MetricChart, type ClimbPoint } from "./experiments/MetricChart"
import "./AutoresearchPane.css"

function elapsed(run: ExperimentRun, now: number) {
  if (!run.startedAt) return ""
  const seconds = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function hours(from: number, to: number) {
  const value = (to - from) / 3_600_000
  return value < 1 ? `${Math.max(1, Math.round(value * 60))} min` : `${value.toFixed(1)} h`
}

function signed(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatValue(Math.abs(value))}`
}

function targetLabel(target: Study["target"]) {
  if (target.kind === "modal") return target.gpu ? `modal ${target.gpu}` : "modal"
  if (target.kind === "ssh") return `ssh ${target.host_id}`
  return "local"
}

const VERDICT_LABEL: Record<ClimbPoint["verdict"], string> = {
  baseline: "Baseline",
  kept: "Kept",
  reverted: "Reverted",
  running: "Running",
  killed: "Killed",
  failed: "Failed",
  pending: "Unrecorded",
}

const STATUS_LABEL: Record<Study["status"], string> = {
  running: "Running",
  paused: "Paused",
  halted: "Halted",
  concluded: "Concluded",
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/**
 * Autoresearch: one tab per study. A study reads as a score (the best value
 * and how far it moved from the baseline), the climb across runs, then the
 * runs themselves with their training curves, the queue, the lessons and the
 * activity. The pane is an instrument: Pause, Resume, Halt and Write up are
 * the operator's controls; the science stays in the session.
 */
export function AutoresearchPane(): JSX.Element {
  const sdk = useSDK()
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  const read = async <T,>(path: string, query?: Record<string, string>) => {
    const response = await sdk.request(path, undefined, query)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return (await response.json()) as T
  }

  const [version, setVersion] = createSignal(0)
  const [pointsVersion, setPointsVersion] = createSignal(0)
  const debounce = (fn: () => void, wait: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => clearTimeout(timer))
    return () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        fn()
      }, wait)
    }
  }
  const bump = debounce(() => setVersion((value) => value + 1), 400)
  const bumpPoints = debounce(() => setPointsVersion((value) => value + 1), 1000)
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
  const [allRuns] = createResource(version, () => read<ExperimentRun[]>("/experiments/runs", { limit: "300" }))
  const [gpus] = createResource(
    () => Math.floor(now() / 5000),
    () => read<LocalGpu[]>("/experiments/gpus"),
  )

  // One tab per study. Nothing chosen means the live study, else the newest.
  const [chosen, setChosen] = createSignal<string>()
  const study = createMemo(() => {
    const list = studies.latest ?? []
    const picked = chosen() ? list.find((item) => item.id === chosen()) : undefined
    return picked ?? list.find((item) => item.status === "running" || item.status === "paused") ?? list[0]
  })
  const [overview] = createResource(
    () => (study() ? `${study()!.id}:${version()}` : undefined),
    (key) => read<StudyOverview>(`/experiments/studies/${key.split(":")[0]}`),
  )
  // The study's own overview carries every run; the project-wide list is
  // capped and only bridges the moment before the overview arrives.
  const runs = createMemo(() => {
    const current = study()
    if (!current) return []
    const own = overview.latest
    if (own && own.study.id === current.id) return own.runs
    return (allRuns.latest ?? []).filter((run) => run.studyID === current.id)
  })
  const loose = createMemo(() => (allRuns.latest ?? []).filter((run) => !run.studyID))
  const ordered = createMemo(() => [...runs()].sort((a, b) => a.createdAt - b.createdAt))
  const color = (run: ExperimentRun) => colorFor(ordered().findIndex((item) => item.id === run.id))

  // Chart selection: baseline, best and the newest finished runs by default;
  // killed and failed runs stay off until asked for.
  const [selected, setSelected] = createSignal(new Set<string>())
  const [touched, setTouched] = createSignal(false)
  createEffect(() => {
    if (touched()) return
    const current = study()
    const defaults = new Set<string>()
    if (current?.baselineRunID) defaults.add(current.baselineRunID)
    if (current?.bestRunID) defaults.add(current.bestRunID)
    for (const run of runs()
      .filter((run) => run.status !== "killed" && run.status !== "failed")
      .slice(0, 6)) {
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
  const pick = (id: string) => {
    setChosen(id)
    setTouched(false)
    setOpen(undefined)
    setPanel(undefined)
  }

  const [keys] = createResource(
    () => `${[...selected()].join(",")}:${version()}`,
    (key) => {
      const ids = key.split(":")[0]!
      return ids ? read<string[]>("/experiments/keys", { run_ids: ids }) : Promise.resolve([])
    },
  )
  const [key, setKey] = createSignal<string>()
  const metric = createMemo(() => {
    const available = keys.latest ?? []
    const wanted = key()
    if (wanted && available.includes(wanted)) return wanted
    const current = study()
    if (current && available.includes(current.metric)) return current.metric
    return available[0]
  })
  const [smoothing, setSmoothing] = createSignal(0)
  const [log, setLog] = createSignal(false)
  const [series] = createResource(
    () => {
      const ids = [...selected()].join(",")
      const name = metric()
      return ids && name ? `${ids}|${name}|${pointsVersion()}|${version()}` : undefined
    },
    (spec) => {
      const [ids, name] = spec.split("|")
      return read<ExperimentSeries>("/experiments/series", { run_ids: ids!, keys: name!, max: "400" })
    },
  )
  const curveSeries = createMemo(() =>
    (series.latest ?? [])
      .map((item) => {
        const run = runs().find((candidate) => candidate.id === item.runID)
        return {
          id: item.runID,
          label: run?.name ?? item.runID,
          color: run ? color(run) : colorFor(0),
          points: item.points,
        }
      })
      .sort((a, b) => ordered().findIndex((run) => run.id === a.id) - ordered().findIndex((run) => run.id === b.id)),
  )

  const [open, setOpen] = createSignal<string>()
  const [curves, setCurves] = createSignal(false)
  const [panel, setPanel] = createSignal<"about" | "queue" | "lessons" | "activity">()
  const flip = (value: NonNullable<ReturnType<typeof panel>>) => setPanel(panel() === value ? undefined : value)
  const queued = createMemo(() => (overview.latest?.ideas ?? []).filter((idea) => idea.status === "queued"))
  const dropped = createMemo(() => (overview.latest?.ideas ?? []).filter((idea) => idea.status === "dropped"))
  const gainSign = () => {
    const gain = improvement()
    return gain ? (gain.percent >= 0 ? "up" : "down") : undefined
  }
  const [steering, setSteering] = createSignal(false)
  const [directive, setDirective] = createSignal("")
  const steer = async (current: Study) => {
    const text = directive().trim()
    if (!text) return
    await sdk.request(`/experiments/studies/${current.id}/directives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
    setDirective("")
    setSteering(false)
    bump()
  }
  const retire = async (current: Study, id: string) => {
    await sdk.request(`/experiments/studies/${current.id}/directives/${id}/retire`, { method: "POST" })
    bump()
  }
  const statusTitle = (current: Study) =>
    [
      targetLabel(current.target),
      `${current.concurrency} at a time`,
      current.killCriteria ? `kill: ${current.killCriteria}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  const [openSeries] = createResource(
    () => (open() ? `${open()}|${pointsVersion()}|${version()}` : undefined),
    (spec) => read<ExperimentSeries>("/experiments/series", { run_ids: spec.split("|")[0]!, max: "200" }),
  )

  const verdict = (run: ExperimentRun): ClimbPoint["verdict"] => {
    const current = study()
    if (run.id === current?.baselineRunID) return "baseline"
    if (run.status === "running") return "running"
    if (run.status === "killed") return "killed"
    if (run.status === "failed" || run.status === "cancelled") return "failed"
    const idea = (overview.latest?.ideas ?? []).find((item) => item.runID === run.id)
    if (idea?.status === "kept") return "kept"
    if (idea?.status === "reverted") return "reverted"
    return "pending"
  }
  const climb = createMemo<ClimbPoint[]>(() =>
    ordered().map((run) => ({ id: run.id, label: run.name, value: run.headline, verdict: verdict(run) })),
  )
  const improvement = createMemo(() => {
    const best = overview.latest?.best
    const base = overview.latest?.baseline
    if (!best || !base || best.headline === null || base.headline === null || base.headline === 0) return
    const current = study()!
    const raw = ((best.headline - base.headline) / Math.abs(base.headline)) * 100
    const better = current.direction === "maximize" ? raw : -raw
    return { percent: better, best, base }
  })

  const control = async (current: Study, action: "pause" | "resume" | "halt") => {
    if (action === "halt" && !window.confirm(`Halt "${current.name}"? Live runs are cancelled and the loop stops.`))
      return
    await sdk.request(`/experiments/studies/${current.id}/${action}`, { method: "POST" })
    bump()
  }
  const writeUp = (current: Study) => {
    uiStore.setPrefill(
      `Write up the study "${current.name}" (${current.id}): read its ledger (study.md, ideas.md, results.tsv, lessons.md) and the tracked runs, then draft the results with the baseline, the best configuration, the ablations that mattered, and the figures the data supports.`,
    )
  }

  const RunRow = (props: { run: ExperimentRun }) => {
    const run = () => props.run
    const state = () => verdict(run())
    const headline = () => run().headline
    const delta = () => run().baselineDelta
    const isOpen = () => open() === run().id
    return (
      <li class="ar-run" data-open={isOpen() ? "true" : undefined} data-verdict={state()}>
        <div
          class="ar-run__row"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen()}
          onClick={() => setOpen(isOpen() ? undefined : run().id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            setOpen(isOpen() ? undefined : run().id)
          }}
        >
          <span class="ar-run__kind">
            <button
              type="button"
              class="ar-run__swatch"
              aria-pressed={selected().has(run().id)}
              aria-label={`${selected().has(run().id) ? "Hide" : "Show"} ${run().name} on the chart`}
              style={{ "--run-color": color(run()) }}
              onClick={(event) => {
                event.stopPropagation()
                toggle(run().id)
              }}
            />
          </span>
          <span class="ar-run__copy">
            <strong>{run().name}</strong>
            <span>
              {VERDICT_LABEL[state()]}
              {delta() === null ? "" : ` · ${signed(delta() as number)}`}
              {elapsed(run(), now()) ? ` · ${elapsed(run(), now())}` : ""}
            </span>
          </span>
          <span class="ar-run__value">{headline() === null ? "—" : formatValue(headline() as number)}</span>
        </div>
        <Show when={isOpen()}>
          <div class="ar-run__detail">
            <Show when={run().killReason}>
              <p class="ar-run__reason">{run().killReason}</p>
            </Show>
            <dl class="ar-facts">
              <For each={Object.entries({ ...(run().config ?? {}), ...(run().summary ?? {}) })}>
                {([name, value]) => (
                  <div>
                    <dt>{name}</dt>
                    <dd>
                      {typeof value === "number"
                        ? formatValue(value)
                        : typeof value === "object"
                          ? JSON.stringify(value)
                          : String(value)}
                    </dd>
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
              <div>
                <dt>run</dt>
                <dd>{run().id}</dd>
              </div>
            </dl>
            <div class="ar-run__curves">
              <For each={[...new Set((openSeries.latest ?? []).map((item) => item.key))]}>
                {(name) => (
                  <div class="ar-run__curve">
                    <span>{name}</span>
                    <MetricChart
                      height={96}
                      series={(openSeries.latest ?? [])
                        .filter((item) => item.key === name)
                        .map((item) => ({ id: item.runID, label: name, color: color(run()), points: item.points }))}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </li>
    )
  }

  return (
    <section class="autoresearch" aria-label="Autoresearch">
      <header class="autoresearch__bar">
        <div class="ar-tabs" role="tablist" aria-label="Studies">
          <For each={studies.latest ?? []}>
            {(item) => (
              <button
                type="button"
                role="tab"
                aria-selected={study()?.id === item.id}
                data-status={item.status}
                title={`${item.name}: ${STATUS_LABEL[item.status]}`}
                onClick={() => pick(item.id)}
              >
                <i aria-hidden="true" />
                <span>{item.name}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={(gpus.latest ?? []).length}>
          <ul class="ar-gpus" aria-label="Local GPUs">
            <For each={gpus.latest ?? []}>
              {(gpu) => (
                <li
                  title={`${gpu.name}: ${gpu.utilization}% busy, ${Math.round(gpu.memoryUsedMB / 1024)} of ${Math.round(gpu.memoryTotalMB / 1024)} GB`}
                >
                  <span>GPU {gpu.index}</span>
                  <i>
                    <b style={{ width: `${gpu.utilization}%` }} />
                  </i>
                  <span>{gpu.utilization}%</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </header>

      <div class="autoresearch__body">
        <Show
          when={study()}
          fallback={
            <div class="ar-empty" data-state="idle">
              <span class="ar-empty__glyph" aria-hidden="true">
                <IconActivity size={18} strokeWidth={1.5} />
              </span>
              <div class="ar-empty__copy">
                <strong>No studies yet</strong>
                <span>
                  Ask in the session for an autoresearch study: the metric to improve, the budget, and the script to
                  run. Each study appears here with its score, its runs and its queue.
                </span>
                <Show when={loose().length}>
                  <span>
                    {loose().length} tracked run{loose().length === 1 ? "" : "s"} outside a study:{" "}
                    {loose()
                      .slice(0, 5)
                      .map((run) => run.name)
                      .join(", ")}
                    {loose().length > 5 ? ", …" : ""}
                  </span>
                </Show>
              </div>
            </div>
          }
        >
          {(current) => (
            <>
              <section class="ar-score" aria-label="Score">
                <div class="ar-score__row">
                  <div class="ar-score__value">
                    <span class="ar-score__metric">
                      {current().direction === "maximize" ? "Maximize" : "Minimize"} {current().metric}
                    </span>
                    <strong>
                      {overview.latest?.best?.headline !== null && overview.latest?.best?.headline !== undefined
                        ? formatValue(overview.latest.best.headline)
                        : overview.latest?.baseline?.headline !== null &&
                            overview.latest?.baseline?.headline !== undefined
                          ? formatValue(overview.latest.baseline.headline)
                          : "—"}
                    </strong>
                    <span class="ar-score__gain" data-sign={gainSign()}>
                      <Show when={improvement()} fallback={overview.latest?.baseline ? "Baseline" : "No runs yet"}>
                        {(gain) => (
                          <>
                            {gain().percent >= 0 ? "▲" : "▼"}{" "}
                            {Math.abs(gain().percent).toFixed(Math.abs(gain().percent) >= 100 ? 0 : 1)}% from{" "}
                            {formatValue(gain().base.headline as number)}
                          </>
                        )}
                      </Show>
                    </span>
                  </div>
                  <div class="ar-score__controls">
                    <em class="ar-status" data-status={current().status} title={statusTitle(current())}>
                      {STATUS_LABEL[current().status]}
                    </em>
                    <Show when={current().status === "running"}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        onClick={() => void control(current(), "pause")}
                      >
                        Pause
                      </Button>
                    </Show>
                    <Show when={current().status === "paused"}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        onClick={() => void control(current(), "resume")}
                      >
                        Resume
                      </Button>
                    </Show>
                    <Show when={current().status === "running" || current().status === "paused"}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        data-danger
                        onClick={() => void control(current(), "halt")}
                      >
                        Halt
                      </Button>
                    </Show>
                    <Button type="button" variant="secondary" size="small" onClick={() => writeUp(current())}>
                      Write up
                    </Button>
                  </div>
                </div>
                <HillClimbChart
                  points={climb()}
                  direction={current().direction}
                  metric={current().metric}
                  height={132}
                />
                <div class="ar-score__meta">
                  <span class="ar-score__facts">
                    <span>
                      {runs().filter((run) => run.status !== "running").length}
                      {current().budget.maxRuns ? `/${current().budget.maxRuns}` : ""} runs
                    </span>
                    <Show when={runs().some((run) => run.status === "running")}>
                      <span>{runs().filter((run) => run.status === "running").length} live</span>
                    </Show>
                    <span>{hours(current().createdAt, now())}</span>
                  </span>
                  <span class="ar-score__links">
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      aria-expanded={panel() === "about"}
                      onClick={() => flip("about")}
                    >
                      About
                    </Button>
                    <Show when={current().status === "running" || current().status === "paused"}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        aria-expanded={steering()}
                        onClick={() => setSteering(!steering())}
                      >
                        Steer
                      </Button>
                    </Show>
                  </span>
                </div>
                <Show when={steering()}>
                  <form
                    class="ar-steer"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void steer(current())
                    }}
                  >
                    <TextField
                      hideLabel
                      label="Directive"
                      value={directive()}
                      placeholder="A standing rule for the rest of the study, e.g. only vary the optimizer"
                      onChange={setDirective}
                    />
                    <Button type="submit" variant="secondary" size="small" disabled={!directive().trim()}>
                      Send
                    </Button>
                  </form>
                </Show>
                <Show when={current().directives.some((item) => item.active)}>
                  <ul class="ar-directives" aria-label="Standing directives">
                    <For each={current().directives.filter((item) => item.active)}>
                      {(item) => (
                        <li>
                          <span>{item.text}</span>
                          <button
                            type="button"
                            aria-label="Retire directive"
                            onClick={() => void retire(current(), item.id)}
                          >
                            ×
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={panel() === "about"}>
                  <div class="ar-about">
                    <p>{current().purpose}</p>
                    <dl class="ar-facts">
                      <div>
                        <dt>Target</dt>
                        <dd>{targetLabel(current().target)}</dd>
                      </div>
                      <div>
                        <dt>Concurrency</dt>
                        <dd>{current().concurrency}</dd>
                      </div>
                      <Show when={current().killCriteria}>
                        <div>
                          <dt>Kill</dt>
                          <dd>{current().killCriteria}</dd>
                        </div>
                      </Show>
                      <Show when={Object.keys(current().budget).length}>
                        <div>
                          <dt>Budget</dt>
                          <dd>
                            {Object.entries(current().budget)
                              .filter(([, value]) => value !== undefined)
                              .map(([key, value]) => `${key} ${value}`)
                              .join(", ")}
                          </dd>
                        </div>
                      </Show>
                      <div>
                        <dt>Wake-ups</dt>
                        <dd>{current().turns}</dd>
                      </div>
                      <div>
                        <dt>Folder</dt>
                        <dd title={current().root}>{current().root.split("/").slice(-2).join("/")}</dd>
                      </div>
                    </dl>
                  </div>
                </Show>
              </section>

              <section class="ar-block" aria-label="Runs">
                <header class="ar-block__head">
                  <div class="ar-block__identity">
                    <strong>Runs</strong>
                    <em>{runs().length}</em>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-expanded={curves()}
                    onClick={() => setCurves(!curves())}
                    disabled={!runs().length}
                  >
                    {curves() ? "Hide curves" : "Curves"}
                  </Button>
                </header>
                <Show when={curves()}>
                  <div class="ar-curves">
                    <div class="ar-chart-controls">
                      <select
                        aria-label="Metric"
                        value={metric() ?? ""}
                        onChange={(event) => setKey(event.currentTarget.value)}
                      >
                        <For each={keys.latest ?? []}>{(name) => <option value={name}>{name}</option>}</For>
                      </select>
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        aria-pressed={log()}
                        onClick={() => setLog(!log())}
                      >
                        Log scale
                      </Button>
                    </div>
                    <MetricChart
                      series={curveSeries()}
                      height={170}
                      log={log()}
                      smoothing={smoothing()}
                      emphasize={open()}
                    />
                  </div>
                </Show>
                <Show when={runs().length} fallback={<p class="ar-none">The first run is the baseline.</p>}>
                  <ul class="ar-runs">
                    <For each={runs()}>{(run) => <RunRow run={run} />}</For>
                  </ul>
                </Show>
              </section>

              <section class="ar-block" aria-label="More">
                <div class="ar-more" role="group" aria-label="More about this study">
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-expanded={panel() === "queue"}
                    onClick={() => flip("queue")}
                  >
                    Queue
                    <em>{queued().length}</em>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-expanded={panel() === "lessons"}
                    onClick={() => flip("lessons")}
                    disabled={!current().lessons && !current().conclusion}
                  >
                    {current().conclusion ? "Conclusion" : "Lessons"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-expanded={panel() === "activity"}
                    onClick={() => flip("activity")}
                    disabled={!(overview.latest?.events ?? []).length}
                  >
                    Activity
                  </Button>
                </div>

                <Show when={panel() === "queue"}>
                  <div class="ar-panel" aria-label="Queue">
                    <Show when={queued().length} fallback={<p class="ar-none">Nothing queued.</p>}>
                      <ol class="ar-queue">
                        <For each={queued()}>
                          {(idea) => (
                            <li>
                              <span class="ar-queue__title" title={idea.description}>
                                {idea.title}
                              </span>
                              <span class="ar-queue__why">{idea.why}</span>
                              <span class="ar-queue__ev">EV {idea.ev}</span>
                            </li>
                          )}
                        </For>
                      </ol>
                    </Show>
                    <Show when={dropped().length}>
                      <p class="ar-none">
                        Dropped:{" "}
                        {dropped()
                          .map((idea) => idea.title)
                          .join(", ")}
                      </p>
                    </Show>
                  </div>
                </Show>

                <Show when={panel() === "lessons"}>
                  <div class="ar-panel" aria-label="Lessons">
                    <Show when={current().conclusion}>
                      <p class="ar-prose">{current().conclusion}</p>
                    </Show>
                    <Show when={current().lessons}>
                      <ul class="ar-lessons">
                        <For each={current().lessons.split("\n").filter(Boolean)}>
                          {(line) => <li>{line.replace(/^-\s*/, "")}</li>}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </Show>

                <Show when={panel() === "activity"}>
                  <div class="ar-panel" aria-label="Activity">
                    <ol class="ar-activity">
                      <For each={(overview.latest?.events ?? []).slice(0, 12)}>
                        {(event) => (
                          <li data-kind={event.kind}>
                            <time>{clock(event.createdAt)}</time>
                            <span>{event.message}</span>
                          </li>
                        )}
                      </For>
                    </ol>
                  </div>
                </Show>
              </section>
            </>
          )}
        </Show>
      </div>
    </section>
  )
}
