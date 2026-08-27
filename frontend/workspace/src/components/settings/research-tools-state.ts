import { formatCreditBalance } from "./credit-balance"

export interface ResearchToolsStatus {
  signedIn: boolean
  search: {
    route: "credits" | "community"
    state: "available" | "basic" | "conditional"
    enabled: boolean
    balanceUsd: number | null
    communityFlagEnabled: boolean
  }
  telemetry: {
    analyticsEnabled: boolean
    researchContentEnabled: boolean
    userOwnedContentEnabled: boolean
    source: "default" | "account"
    signedIn: boolean
    consentVersion: string
    pending: boolean
    corrupt: boolean
    deletionAvailable: boolean
    queuedEvents: number
    quarantinedEvents: number
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
        search.balanceUsd === null
          ? "Basic community search is available. Enhanced search status could not be checked."
          : "Basic community search is available. Add credits for enhanced search.",
      tone: "neutral" as const,
    }
  }
  const balance = search.balanceUsd ?? 0
  return {
    label: "Ready",
    detail: `${formatCreditBalance(balance)} available for credit-backed models and enhanced search.`,
    tone: "success" as const,
  }
}

export function userOwnedSharingDetail(status: ResearchToolsStatus) {
  if (status.telemetry.corrupt) return "Unavailable until you choose this setting again. Ace managed traces remain on."
  if (status.telemetry.pending && !status.telemetry.userOwnedContentEnabled)
    return "Off on this device. The setting will sync when OpenScience reconnects. Ace remains on."
  if (!status.telemetry.userOwnedContentEnabled)
    return "Off for API keys, ChatGPT/Codex, provider subscriptions, and local models. Ace remains on."
  if (status.telemetry.pending) return "Saved on this device. It will sync when OpenScience reconnects."
  if (status.telemetry.source === "default")
    return "On by default for API keys, ChatGPT/Codex, provider subscriptions, and local models."
  return "On for API keys, ChatGPT/Codex, provider subscriptions, and local models."
}

export function userOwnedSharingEnabled(status: ResearchToolsStatus) {
  return !status.telemetry.corrupt && status.telemetry.userOwnedContentEnabled
}
