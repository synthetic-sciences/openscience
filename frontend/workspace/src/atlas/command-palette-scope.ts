import { projectName, type ProjectRecord } from "@/pages/home-projects"

function routeName(project: { worktree: string }) {
  const parts = project.worktree.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? "Current project"
}

/** The project the palette is searching, as the person knows it. A project
 * created in the app lives in a folder named by its id, so its folder is only
 * the label for a project the catalog does not hold (one opened from the CLI). */
export function scopeLabel(
  active: { projectID: string; project: { worktree: string } } | undefined,
  catalog: readonly ProjectRecord[],
) {
  if (!active) return "All projects"
  const record = catalog.find((item) => item.id === active.projectID)
  return record ? projectName(record) : routeName(active.project)
}
