export interface ResearchToolsStatus {
  signedIn: boolean
  plan: {
    id: string
    label: string
    status: string | null
  }
  search: {
    route: "managed" | "community"
    state: "available" | "near_limit" | "critical" | "exhausted" | "conditional" | "unavailable"
    enabled: boolean
    limit: number | null
    used: number | null
    remaining: number | null
    resetAt: string | null
    communityFlagEnabled: boolean
  }
  telemetry: {
    analyticsEnabled: boolean
    researchContentEnabled: false
    source: "default" | "local" | "account"
    signedIn: boolean
    consentVersion: string
    pending: boolean
    corrupt: boolean
    deletionAvailable: boolean
  }
}

export function searchStatus(status: ResearchToolsStatus) {
  const search = status.search
  if (search.route === "community") {
    return {
      label: "Community",
      detail: search.communityFlagEnabled
        ? "Available on supported community-search model routes."
        : "Available when the selected model route supports community search.",
      tone: "neutral" as const,
    }
  }
  if (search.state === "exhausted") {
    return { label: "Allowance used", detail: resetDetail(search.resetAt), tone: "warning" as const }
  }
  if (search.state === "unavailable") {
    return {
      label: "Allowance unavailable",
      detail: "The Gateway could not load the current allowance. Retry in a moment.",
      tone: "neutral" as const,
    }
  }
  const remaining = search.remaining ?? 0
  const limit = search.limit ?? 0
  return {
    label: `${remaining.toLocaleString()} left`,
    detail: `${remaining.toLocaleString()} of ${limit.toLocaleString()} managed searches remain${resetDetail(search.resetAt, true)}.`,
    tone: search.state === "near_limit" || search.state === "critical" ? ("warning" as const) : ("success" as const),
  }
}

export function dataSharingDetail(status: ResearchToolsStatus) {
  if (status.telemetry.corrupt) return "The consent record could not be read, so sharing is off until you choose again."
  if (!status.telemetry.analyticsEnabled)
    return "Off. Any queued structural usage has been removed from this installation."
  if (status.telemetry.source === "default") return "On by default. You can turn it off at any time."
  if (status.telemetry.pending) return "Saved locally and waiting to sync with your account."
  return status.telemetry.source === "account" ? "On for this account." : "On for this installation."
}

function resetDetail(value: string | null, inline = false) {
  if (!value) return inline ? "" : "The next allowance reset date is not available."
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return inline ? "" : "The next allowance reset date is not available."
  const label = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)
  return inline ? ` until ${label}` : `Resets ${label}.`
}
