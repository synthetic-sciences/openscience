export type ResearchAccessMode = "ask" | "approve" | "full"

export type ResearchAccessState = {
  trusted: boolean
  sandboxEnabled: boolean
}

export type ResearchAccessMutation = { kind: "sandbox"; enabled: boolean } | { kind: "trust"; trusted: boolean }

export const RESEARCH_ACCESS_OPTIONS = [
  {
    value: "ask",
    label: "Ask for approval",
    description: "Ask before project code or host access",
  },
  {
    value: "approve",
    label: "Approve for me",
    description: "Trust this project inside the sandbox",
  },
  {
    value: "full",
    label: "Full access",
    description: "Unrestricted files, commands, and internet",
  },
] as const satisfies ReadonlyArray<{
  value: ResearchAccessMode
  label: string
  description: string
}>

export function researchAccessMode(state: ResearchAccessState): ResearchAccessMode {
  if (!state.trusted) return "ask"
  return state.sandboxEnabled ? "approve" : "full"
}

/**
 * Keep every transition fail-closed. Moving toward less access establishes the
 * sandbox before revoking trust; moving to full access establishes trust while
 * containment is still active before disabling that boundary.
 */
export function researchAccessMutations(mode: ResearchAccessMode): ResearchAccessMutation[] {
  if (mode === "ask") {
    return [
      { kind: "sandbox", enabled: true },
      { kind: "trust", trusted: false },
    ]
  }
  if (mode === "approve") {
    return [
      { kind: "sandbox", enabled: true },
      { kind: "trust", trusted: true },
    ]
  }
  return [
    { kind: "trust", trusted: true },
    { kind: "sandbox", enabled: false },
  ]
}
