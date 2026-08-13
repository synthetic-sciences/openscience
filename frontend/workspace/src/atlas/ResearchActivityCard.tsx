import type { JSX } from "solid-js"
import type { ObservableResearchActivity } from "@/atlas/session-trace-model"

const kindLabel = (value: ObservableResearchActivity["kind"]) => {
  if (value === "agent") return "Agent"
  if (value === "search") return "Search"
  if (value === "shell") return "Shell"
  return "Source"
}

const statusLabel = (value: ObservableResearchActivity["status"]) => {
  if (value === "completed") return "Completed"
  if (value === "running") return "Working"
  if (value === "pending") return "Waiting"
  return "Needs attention"
}

const statusTone = (value: ObservableResearchActivity["status"]) => {
  if (value === "completed") return "succeeded"
  if (value === "error") return "failed"
  return value
}

export function ResearchActivityCard(props: { activity: ObservableResearchActivity }): JSX.Element {
  return (
    <article class="activity-card research-activity-card" data-state={props.activity.status}>
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <span class="activity-card__kind">{kindLabel(props.activity.kind)}</span>
          <strong title={props.activity.label}>{props.activity.label}</strong>
        </div>
        <span class="activity-card__status" data-tone={statusTone(props.activity.status)}>
          {statusLabel(props.activity.status)}
        </span>
      </header>
      <p class="activity-card__summary">{props.activity.detail}</p>
    </article>
  )
}
