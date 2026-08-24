export interface ResearchToolsStatus {
  signedIn: boolean
  search: {
    route: "credits" | "community"
    state: "available" | "basic" | "conditional"
    enabled: boolean
    balanceCredits: number | null
    communityFlagEnabled: boolean
  }
  telemetry: {
    analyticsEnabled: boolean
    researchContentEnabled: boolean
    source: "default" | "account"
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
  if (search.state === "basic") {
    return {
      label: "Basic",
      detail:
        search.balanceCredits === null
          ? "Basic community search is available. Enhanced search status could not be checked."
          : "Basic community search is available. Add credits for enhanced search.",
      tone: "neutral" as const,
    }
  }
  const balance = search.balanceCredits ?? 0
  return {
    label: "Ready",
    detail: `${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits available for managed models and search.`,
    tone: "success" as const,
  }
}

export function dataSharingDetail(status: ResearchToolsStatus) {
  if (status.telemetry.corrupt) return "Off until you choose this setting again."
  if (!status.telemetry.analyticsEnabled || !status.telemetry.researchContentEnabled)
    return "Off. New activity stays on this device."
  if (status.telemetry.pending) return "Saved on this device. It will sync when OpenScience reconnects."
  if (status.telemetry.source === "default") return "On by default for this account."
  return "On for this account."
}
