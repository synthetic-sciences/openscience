import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import type { SessionTraceResponse } from "@synsci/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { IconRefresh } from "@/atlas/shared/Icon"
import {
  formatClock,
  resultPolyline,
  resultTrend,
  sourceLabel,
  traceActivity,
  traceCounts,
  traceMetrics,
} from "./session-trace-model"
import "./SessionTraceSurface.css"

export function SessionTraceSurface(props: { session: string }): JSX.Element {
  const sdk = useSDK()
  const [trace, api] = createResource(
    () => (props.session && props.session !== "new" ? props.session : false),
    async (sessionID) => {
      const response = await sdk.client.session.trace({ sessionID })
      if (!response.data) throw new Error("The local trace did not return any data.")
      return response.data as SessionTraceResponse
    },
  )
  const activity = createMemo(() => (trace() ? traceActivity(trace()!) : []))
  const [reviewing, setReviewing] = createSignal(false)
  const [reviewState, setReviewState] = createSignal<"idle" | "started" | "error">("idle")

  const review = async () => {
    if (reviewing()) return
    setReviewing(true)
    setReviewState("idle")
    try {
      await sdk.client.session.review({ sessionID: props.session })
      setReviewState("started")
      await api.refetch()
    } catch {
      setReviewState("error")
    } finally {
      setReviewing(false)
    }
  }

  return (
    <section class="session-trace" aria-label="Session trace">
      <Show
        when={props.session && props.session !== "new"}
        fallback={
          <TraceState
            title="No session trace yet"
            detail="Send a prompt to start a session. Observable work will appear here as it runs."
          />
        }
      >
        <Show
          when={!trace.loading}
          fallback={
            <div class="session-trace__skeleton" role="status" aria-label="Loading session trace">
              <span />
              <span />
              <span />
            </div>
          }
        >
          <Show
            when={!trace.error && trace()}
            fallback={
              <TraceState
                title="Trace unavailable"
                detail={trace.error instanceof Error ? trace.error.message : String(trace.error)}
                action={() => void api.refetch()}
              />
            }
          >
            {(data) => (
              <>
                <header class="session-trace__intro">
                  <div>
                    <span class="session-trace__eyebrow">Local observable record</span>
                    <h2>{data().session.title}</h2>
                    <p>
                      Timing, cost, approvals, and results from this session. Hidden reasoning and raw tool output are
                      never stored here.
                    </p>
                  </div>
                  <button
                    type="button"
                    class="session-trace__refresh"
                    title="Refresh trace"
                    aria-label="Refresh trace"
                    onClick={() => void api.refetch()}
                  >
                    <IconRefresh size={13} />
                  </button>
                </header>

                <dl class="session-trace__metrics">
                  <For each={traceMetrics(data())}>
                    {(metric) => (
                      <div>
                        <dt>{metric.label}</dt>
                        <dd>{metric.value}</dd>
                        <span>{metric.detail}</span>
                      </div>
                    )}
                  </For>
                </dl>

                <dl class="session-trace__counts" aria-label="Session work counts">
                  <For each={traceCounts(data())}>
                    {(count) => (
                      <div data-alert={count.label === "failures" && count.value > 0 ? "true" : undefined}>
                        <dt>{count.label}</dt>
                        <dd>{count.value}</dd>
                        <Show when={count.note}>
                          <span>{count.note}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </dl>

                <Show when={data().inference.length > 0}>
                  <section class="session-trace__route" aria-label="Inference route">
                    <span>Inference</span>
                    <strong>
                      {data().inference[0].provider} / {data().inference[0].model}
                    </strong>
                    <small>
                      {sourceLabel(data().inference[0].source)} · {data().inference[0].effort} effort
                    </small>
                  </section>
                </Show>

                <Show when={data().research.configured && data().research.contract}>
                  {(contract) => (
                    <section class="session-trace__result" aria-label="Generated research result">
                      <header class="session-trace__result-head">
                        <div>
                          <span>Generated research result</span>
                          <h3>{contract().objective}</h3>
                        </div>
                        <span class="session-trace__result-status" data-status={data().research.status}>
                          {data().research.status}
                        </span>
                      </header>

                      <div class="session-trace__result-grid">
                        <div class="session-trace__readiness">
                          <svg viewBox="0 0 44 44" role="img" aria-label={`${data().research.readiness}% ready`}>
                            <circle class="session-trace__ring-track" cx="22" cy="22" r="15.9" pathLength="100" />
                            <circle
                              class="session-trace__ring-value"
                              cx="22"
                              cy="22"
                              r="15.9"
                              pathLength="100"
                              stroke-dasharray={`${data().research.readiness} 100`}
                            />
                            <text x="22" y="21" text-anchor="middle">
                              {data().research.readiness}
                            </text>
                            <text class="session-trace__ring-unit" x="22" y="27" text-anchor="middle">
                              ready
                            </text>
                          </svg>
                          <div>
                            <span>{contract().domain}</span>
                            <strong>{contract().template} contract</strong>
                            <small>
                              {data().research.failedCandidates} failed{" "}
                              {data().research.failedCandidates === 1 ? "candidate" : "candidates"} ·{" "}
                              {data().research.openFindings} open major{" "}
                              {data().research.openFindings === 1 ? "finding" : "findings"}
                            </small>
                          </div>
                        </div>
                        <ResultGraph trace={data()} />
                      </div>

                      <div class="session-trace__gates" aria-label="Research readiness gates">
                        <For each={data().research.gates}>
                          {(gate) => {
                            const width = () => (gate.total ? Math.round((gate.complete / gate.total) * 100) : 100)
                            return (
                              <div data-status={gate.status}>
                                <span>
                                  <strong>{gate.label}</strong>
                                  <small>{gate.detail}</small>
                                </span>
                                <i aria-hidden="true">
                                  <b style={{ width: `${width()}%` }} />
                                </i>
                              </div>
                            )
                          }}
                        </For>
                      </div>

                      <div class="session-trace__stages" aria-label="Research stages">
                        <For each={contract().stages}>
                          {(stage, index) => (
                            <div data-status={stage.status ?? "pending"}>
                              <span>{String(index() + 1).padStart(2, "0")}</span>
                              <strong>{stage.label}</strong>
                            </div>
                          )}
                        </For>
                      </div>

                      <footer class="session-trace__review">
                        <div>
                          <strong>Independent reviewer</strong>
                          <span>
                            {reviewState() === "started"
                              ? "Review queued. Findings will appear in this trace."
                              : reviewState() === "error"
                                ? "Review could not be started. Check the active model and try again."
                                : "Audit the exact Results and record finding lifecycle."}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={reviewing() || data().session.status !== "idle"}
                          onClick={() => void review()}
                        >
                          {reviewing() ? "Starting review…" : "Run independent review"}
                        </button>
                      </footer>
                    </section>
                  )}
                </Show>

                <section class="session-trace__activity" aria-label="Observable activity">
                  <div class="session-trace__section-title">
                    <h3>Observable activity</h3>
                    <span>{activity().length}</span>
                  </div>
                  <Show
                    when={activity().length > 0}
                    fallback={
                      <p class="session-trace__empty">
                        No model, tool, approval, or result events have been recorded yet.
                      </p>
                    }
                  >
                    <ol>
                      <For each={activity()}>
                        {(item) => (
                          <li data-kind={item.kind} data-status={item.status}>
                            <time datetime={new Date(item.at).toISOString()}>{formatClock(item.at)}</time>
                            <span class="session-trace__mark" aria-hidden="true" />
                            <div>
                              <strong>{item.label}</strong>
                              <span>{item.detail}</span>
                            </div>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </section>

                <footer class="session-trace__privacy">
                  <span>Local to this machine</span>
                  <span>Gateway not required</span>
                  <span>No chain-of-thought</span>
                </footer>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  )
}

function ResultGraph(props: { trace: SessionTraceResponse }): JSX.Element {
  const points = createMemo(() => resultTrend(props.trace))
  return (
    <div class="session-trace__trend">
      <header>
        <strong>Result build-up</strong>
        <span>
          <i data-series="verified" /> Results + checks
          <i data-series="risks" /> risks surfaced
        </span>
      </header>
      <svg viewBox="0 0 100 46" preserveAspectRatio="none" role="img" aria-label="Observable result progress">
        <path d="M0 42H100M0 25H100M0 8H100" />
        <polyline data-series="risks" points={resultPolyline(points(), "risks")} />
        <polyline data-series="verified" points={resultPolyline(points(), "verified")} />
      </svg>
      <footer>
        <span>start</span>
        <span>now</span>
      </footer>
    </div>
  )
}

function TraceState(props: { title: string; detail: string; action?: () => void }): JSX.Element {
  return (
    <div class="session-trace__state">
      <span aria-hidden="true">···</span>
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
      <Show when={props.action}>
        {(action) => (
          <button type="button" onClick={action()}>
            Try again
          </button>
        )}
      </Show>
    </div>
  )
}
