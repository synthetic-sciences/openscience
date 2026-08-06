import { fileSourceName, type FilesystemGrant } from "@/atlas/file-sources"

export type SourceGroup = "Artifacts" | "This computer" | "Remote"

export interface PaneSource {
  id: string
  group: SourceGroup
  name: string
  sub?: string
  root: string
  kind: "artifacts" | "trash" | "project" | "session" | "connected" | "modal"
  readonly?: boolean
  live?: boolean
}

const ORDER: SourceGroup[] = ["Artifacts", "This computer", "Remote"]

export function buildSources(input: {
  projectRoot: string
  projectName: string
  grants: FilesystemGrant[]
  sessionRoot?: string
  /** Modal Volume names, once they have been fetched. Absent until then. */
  volumes?: string[]
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
  // A volume browses and downloads but never writes: the pane reaches it over
  // the Modal API, not a mount, so there is nothing to save back through.
  for (const volume of input.volumes ?? []) {
    list.push({
      id: `modal:${volume}`,
      group: "Remote",
      name: volume,
      sub: "Modal Volume",
      // Empty, not "/": the pane joins a source's root with the folders walked
      // into it, and a "/" root would ask the volume for "//data".
      root: "",
      kind: "modal",
      readonly: true,
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
