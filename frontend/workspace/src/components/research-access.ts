export type ResearchAccessMode = "ask" | "approve" | "full"

export type ResearchAccessState = {
  mode: ResearchAccessMode
}

export const DEFAULT_RESEARCH_ACCESS_MODE: ResearchAccessMode = "approve"

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
    description: "Warning: disables the sandbox for files, commands, and internet",
  },
] as const satisfies ReadonlyArray<{
  value: ResearchAccessMode
  label: string
  description: string
}>

export function researchAccessMode(state: ResearchAccessState): ResearchAccessMode {
  return state.mode
}

export function researchAccessLabel(mode: ResearchAccessMode): string {
  return RESEARCH_ACCESS_OPTIONS.find((option) => option.value === mode)?.label ?? "Full access"
}

export function researchAccessContract(mode: ResearchAccessMode) {
  if (mode === "ask") return { sandbox: "workspace-write", approval: "on-request", review: "user" } as const
  if (mode === "approve") return { sandbox: "workspace-write", approval: "on-request", review: "auto_review" } as const
  return { sandbox: "danger-full-access", approval: "never", review: "none" } as const
}
