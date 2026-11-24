import type { ProjectCreateInput } from "./dialog-create-project"

const FLAG = "import=conversations"

/** POST /global/project validates strictly, so the import choice never travels in the body. */
export function projectCreateBody(input: ProjectCreateInput): Omit<ProjectCreateInput, "importConversations"> {
  return { name: input.name, sources: input.sources }
}

/** The new project's URL, marked to import its Claude Code and Codex conversations once. */
export function importFlagUrl(path: string) {
  return `${path}${path.includes("?") ? "&" : "?"}${FLAG}`
}

const taken = new Set<string>()

/** True at most once per project per page load, so a remount never imports twice. */
export function takeImportFlag(projectID: string, search: string) {
  if (!new URLSearchParams(search).has("import")) return false
  if (new URLSearchParams(search).get("import") !== "conversations" || taken.has(projectID)) return false
  taken.add(projectID)
  return true
}

/** "2 created, 1 copied, 3 unchanged": the non-zero counts, in a fixed order. */
export function describeCounts(counts: Record<string, number>) {
  const order = ["created", "updated", "copied", "unchanged", "skipped", "failed"]
  const parts = order.filter((key) => counts[key]).map((key) => `${counts[key]} ${key}`)
  return parts.length ? parts.join(", ") : "nothing to import"
}
