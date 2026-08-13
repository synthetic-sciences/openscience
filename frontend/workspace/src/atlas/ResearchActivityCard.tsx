import { Show, type JSX } from "solid-js"
import type { ObservableResearchActivity } from "@/atlas/session-trace-model"

const kindLabel = (value: ObservableResearchActivity["kind"]) => {
  if (value === "agent") return "Agent"
  if (value === "search") return "Search"
  if (value === "shell") return "Shell"
  return "Source"
}

const statusLabel = (value: ObservableResearchActivity["status"]) => {
  if (value === "completed") return "Completed"
  if (value === "partial") return "Partial"
  if (value === "running") return "Working"
  if (value === "pending") return "Waiting"
  return "Failed"
}

const statusTone = (value: ObservableResearchActivity["status"]) => {
  if (value === "completed") return "succeeded"
  if (value === "error") return "failed"
  return value
}

const segment = (value: string) => {
  const decoded = (() => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  })()
  return decoded.replaceAll("_", " ").replaceAll("-", " ")
}

/** Keep encoded request payloads out of the scan path while retaining the exact URL as metadata. */
export function researchLabel(value: string) {
  const url = (() => {
    try {
      return new URL(value)
    } catch {
      return undefined
    }
  })()
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return value
  const path = url.pathname.split("/").find(Boolean)
  return path ? `${url.hostname} / ${segment(path)}` : url.hostname
}

export function ResearchActivityCard(props: { activity: ObservableResearchActivity }): JSX.Element {
  const label = () => researchLabel(props.activity.label)
  const failureDetail = () => (props.activity.status === "error" ? props.activity.detail.trim() : "")

  return (
    <article class="activity-card research-activity-card" data-state={props.activity.status}>
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <strong title={props.activity.label} aria-label={label()}>
            {label()}
          </strong>
        </div>
        <Show when={props.activity.status !== "completed"}>
          <span class="activity-card__status" data-tone={statusTone(props.activity.status)}>
            {statusLabel(props.activity.status)}
          </span>
        </Show>
      </header>
      <p class="activity-card__summary">
        {kindLabel(props.activity.kind)}
        <Show when={!failureDetail()}> · {props.activity.detail}</Show>
      </p>
      <Show when={failureDetail()}>
        {(detail) => (
          <div class="activity-card__disclosures">
            <details class="activity-disclosure research-activity-card__failure">
              <summary>Failure details</summary>
              <div class="activity-disclosure__body">
                <p class="activity-disclosure__note">{detail()}</p>
              </div>
            </details>
          </div>
        )}
      </Show>
    </article>
  )
}
