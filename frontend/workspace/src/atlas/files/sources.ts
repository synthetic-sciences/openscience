import { fileSourceName, normalizeFilePath, type FilesystemGrant } from "@/atlas/file-sources"

/**
 * The picker is an information architecture, not a list of storage backends.
 * A saved deliverable, a working folder, and a recovery location have
 * materially different lifetimes, so they do not share one ambiguous bucket.
 */
export type SourceGroup = "Results" | "Working files" | "Remote" | "Recovery"

export interface PaneSource {
  id: string
  group: SourceGroup
  name: string
  /** A short, truthful description shown when a source has no useful path. */
  detail?: string
  sub?: string
  root: string
  kind: "artifacts" | "trash" | "project" | "session" | "connected" | "modal"
  readonly?: boolean
  live?: boolean
}

const ORDER: SourceGroup[] = ["Working files", "Results", "Remote", "Recovery"]

export function buildSources(input: {
  projectRoot: string
  projectName: string
  grants: FilesystemGrant[]
  sessionRoot?: string
  /** Whether Modal is connected and enabled. Its Volumes are browsed, not listed here. */
  modal?: boolean
}): PaneSource[] {
  const list: PaneSource[] = [
    {
      id: "project",
      group: "Working files",
      name: "Project files",
      detail: `Shared working files for ${input.projectName}`,
      sub: input.projectRoot,
      root: input.projectRoot,
      kind: "project",
    },
  ]
  // Legacy sessions may report the project directory itself as their workspace
  // grant. That is not isolated scratch space, and listing the same path twice
  // under two lifetimes would be actively misleading. Only a distinct,
  // normalized location earns the Session workspace source.
  if (input.sessionRoot && normalizeFilePath(input.sessionRoot) !== normalizeFilePath(input.projectRoot)) {
    list.push({
      id: "session",
      group: "Working files",
      name: "This session",
      detail: "Temporary working files for this conversation",
      sub: input.sessionRoot,
      root: input.sessionRoot,
      kind: "session",
    })
  }
  list.push({
    id: "artifacts",
    group: "Results",
    name: "Results",
    detail: "Saved deliverables from every session in this project",
    root: "",
    kind: "artifacts",
  })
  for (const grant of input.grants) {
    list.push({
      id: grant.id,
      group: "Working files",
      name: fileSourceName(grant.path),
      sub: grant.path,
      root: grant.path,
      kind: "connected",
      readonly: grant.access === "read",
    })
  }
  // One entry per provider, not one per volume: Remote is where every cloud
  // connector will land, and an account with forty Volumes would bury the local
  // sources under them. The Volumes are the first level inside this source.
  //
  // It browses and downloads but never writes: the pane reaches Modal over its
  // API, not a mount, so there is nothing to save back through.
  if (input.modal) {
    list.push({
      id: "modal",
      group: "Remote",
      name: "Modal Volumes",
      detail: "Connected remote storage",
      root: "",
      kind: "modal",
      readonly: true,
    })
  }

  // Listed unconditionally and last: recovery should remain discoverable, but
  // it should not sit between the primary saved destination and working files.
  // The delete flow promises this location before the first item is deleted.
  list.push({
    id: "trash",
    group: "Recovery",
    name: "Trash",
    detail: "Recoverable for 30 days",
    root: "",
    kind: "trash",
  })
  return list
}

export function groupSources(list: PaneSource[]) {
  return ORDER.flatMap((group) => {
    const items = list.filter((source) => source.group === group)
    return items.length ? [{ group, items }] : []
  })
}
