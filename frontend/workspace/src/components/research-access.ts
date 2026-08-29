export type ResearchAccessMode = "ask" | "approve" | "full"

export type ResearchAccessState = {
  mode: ResearchAccessMode
}

export const DEFAULT_RESEARCH_ACCESS_MODE: ResearchAccessMode = "approve"

export const RESEARCH_ACCESS_OPTIONS = [
  {
    value: "ask",
    label: "Ask always",
    description: "Ask before actions that change files, use the network, run compute, or spend credits",
  },
  {
    value: "approve",
    label: "Ask risky",
    description: "Run contained, reversible work and ask before external, costly, or hard-to-reverse actions",
  },
  {
    value: "full",
    label: "Full access",
    description: "Run without routine prompts; paid and managed safety boundaries still apply",
  },
] as const satisfies ReadonlyArray<{
  value: ResearchAccessMode
  label: string
  description: string
}>

export function researchAccessMode(state: ResearchAccessState): ResearchAccessMode {
  return state.mode
}

export function researchAccessLabel(mode: string): string {
  return RESEARCH_ACCESS_OPTIONS.find((option) => option.value === mode)?.label ?? "Restricted access"
}

export function researchAccessContract(mode: ResearchAccessMode) {
  if (mode === "ask")
    return { sandbox: "workspace-write", approval: "every action", boundary: "standing grants ignored" } as const
  if (mode === "approve")
    return { sandbox: "workspace-write", approval: "risky actions", boundary: "contained work proceeds" } as const
  return {
    sandbox: "danger-full-access",
    approval: "managed boundaries",
    boundary: "routine prompts off",
  } as const
}
