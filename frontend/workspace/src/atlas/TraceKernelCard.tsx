import { Show, type JSX } from "solid-js"
import type { ObservableKernelActivity } from "@/atlas/session-trace-model"

const statusLabel = (value: ObservableKernelActivity["status"]) => {
  if (value === "completed") return "Completed"
  if (value === "running") return "Running"
  if (value === "pending") return "Waiting"
  return "Failed"
}

const statusTone = (value: ObservableKernelActivity["status"]) => {
  if (value === "completed") return "succeeded"
  if (value === "error") return "failed"
  return value
}

/** A deliberately compact trace fallback; durable runs use ExecutionCard. */
export function TraceKernelCard(props: { activity: ObservableKernelActivity }): JSX.Element {
  return (
    <article class="activity-card trace-kernel-card" data-state={props.activity.status} data-source="session-trace">
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <span class="activity-card__kind">{props.activity.language}</span>
          <div class="kernel-card__copy">
            <strong title={props.activity.label}>{props.activity.label}</strong>
            <span>{props.activity.detail}</span>
          </div>
        </div>
        <Show when={props.activity.status !== "completed"}>
          <span class="activity-card__status" data-tone={statusTone(props.activity.status)}>
            {statusLabel(props.activity.status)}
          </span>
        </Show>
      </header>
    </article>
  )
}
