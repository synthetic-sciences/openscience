import type { Agent } from "@synsci/sdk/v2/client"

const SYSTEM_AGENTS = new Set(["title", "compaction"])

export type SpecialistGroup = "research" | "review" | "workspace"

export const SPECIALIST_GROUPS: ReadonlyArray<{
  id: SpecialistGroup
  title: string
  description: string
}> = [
  {
    id: "research",
    title: "Research",
    description: "Core scientific roles for investigation, analysis, and synthesis.",
  },
  {
    id: "review",
    title: "Review and writing",
    description: "Independent critique, result checking, and scientific communication.",
  },
  {
    id: "workspace",
    title: "Workspace support",
    description: "Focused helpers for exploration and bounded delegated tasks.",
  },
]

const REVIEW_SPECIALISTS = new Set(["critique", "physics-critique", "reviewer", "literature-review", "write"])
const WORKSPACE_SPECIALISTS = new Set(["explore", "task"])

export function specialistGroupFor(agent: Pick<Agent, "name">): SpecialistGroup {
  if (REVIEW_SPECIALISTS.has(agent.name)) return "review"
  if (WORKSPACE_SPECIALISTS.has(agent.name)) return "workspace"
  return "research"
}

export function isVisibleSpecialist(agent: Pick<Agent, "name" | "hidden">) {
  return !SYSTEM_AGENTS.has(agent.name) && agent.name !== "plan" && !agent.hidden
}
