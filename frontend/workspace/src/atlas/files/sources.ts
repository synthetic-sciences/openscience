import { fileSourceName, type FilesystemGrant } from "@/atlas/file-sources"

export type SourceGroup = "Artifacts" | "This computer" | "Remote"

export interface PaneSource {
  id: string
  group: SourceGroup
  name: string
  sub?: string
  root: string
  kind: "artifacts" | "trash" | "project" | "session" | "connected"
  readonly?: boolean
  live?: boolean
}

const ORDER: SourceGroup[] = ["Artifacts", "This computer", "Remote"]

export function buildSources(input: {
  projectRoot: string
  projectName: string
  grants: FilesystemGrant[]
  sessionRoot?: string
}): PaneSource[] {
  const list: PaneSource[] = [
    { id: "artifacts", group: "Artifacts", name: "All artifacts", root: "", kind: "artifacts" },
    // Listed unconditionally: a trash entry that appears only once something
    // is in it is a recovery path nobody can find in advance, and the delete
    // dialog promises this surface before anything has been deleted.
    { id: "trash", group: "Artifacts", name: "Trash", root: "", kind: "trash" },
    {
      id: "project",
      group: "This computer",
      name: input.projectName,
      sub: input.projectRoot,
      root: input.projectRoot,
      kind: "project",
    },
  ]
  if (input.sessionRoot) {
    list.push({
      id: "session",
      group: "This computer",
      name: "Session files",
      sub: input.sessionRoot,
      root: input.sessionRoot,
      kind: "session",
    })
  }
  for (const grant of input.grants) {
    list.push({
      id: grant.id,
      group: "This computer",
      name: fileSourceName(grant.path),
      sub: grant.path,
      root: grant.path,
      kind: "connected",
      readonly: grant.access === "read",
    })
  }
  return list
}

export function groupSources(list: PaneSource[]) {
  return ORDER.flatMap((group) => {
    const items = list.filter((source) => source.group === group)
    return items.length ? [{ group, items }] : []
  })
}
