import type { StoredArtifact } from "@/artifacts/store"

export type Sort = "created" | "name"

export interface Group {
  key: string
  label: string
  artifacts: StoredArtifact[]
  newest: number
}

export const sortArtifacts = (list: StoredArtifact[], sort: Sort): StoredArtifact[] =>
  [...list].sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title) : b.createdAt - a.createdAt))

// Enough of the id to tell two untitled sessions apart, short enough for a
// group header at the docked width.
export function sessionLabel(id: string, titles: Map<string, string>, current: string | undefined): string {
  if (current && id === current) return "This session"
  const title = titles.get(id)?.trim()
  return title || `ses_…${id.slice(-6)}`
}

export function groupBySession(
  list: StoredArtifact[],
  titles: Map<string, string>,
  current: string | undefined,
): Group[] {
  const groups = new Map<string, StoredArtifact[]>()
  for (const item of list) {
    const key = item.current.sessionID
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()]
    .map(([key, artifacts]) => ({
      key,
      label: sessionLabel(key, titles, current),
      artifacts: sortArtifacts(artifacts, "created"),
      newest: Math.max(...artifacts.map((item) => item.createdAt)),
    }))
    .sort((a, b) => {
      if (current && a.key === current) return -1
      if (current && b.key === current) return 1
      return b.newest - a.newest
    })
}
