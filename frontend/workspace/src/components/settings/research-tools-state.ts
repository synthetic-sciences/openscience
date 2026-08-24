export interface ResearchToolsStatus {
  signedIn: boolean
  wallet: {
    mode: "payg"
    balanceUsd: number | null
  }
  search: {
    route: "enhanced" | "community"
    enhancedAvailable: boolean
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
  if (search.route === "enhanced") {
    return {
      label: "Enhanced",
      detail: "Available through your connected Synthetic Sciences account, with basic search as a fallback.",
      tone: "success" as const,
    }
  }
  return {
    label: "Community",
    detail: "Basic search remains available without wallet credits or a connected account.",
    tone: "neutral" as const,
  }
}

export function walletStatus(status: ResearchToolsStatus) {
  if (!status.signedIn) return { label: "Not connected", tone: "neutral" as const }
  if (status.wallet.balanceUsd === null) return { label: "Balance unavailable", tone: "neutral" as const }
  const balance = status.wallet.balanceUsd
  return {
    label: `$${balance.toFixed(balance >= 100 ? 0 : 2)} ${balance >= 0 ? "available" : "balance"}`,
    tone: balance > 0 ? ("success" as const) : ("warning" as const),
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
