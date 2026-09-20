import { describe, expect, test } from "bun:test"
import type { FilesystemGrant } from "@/atlas/file-sources"
import { buildSources, defaultSource, groupSources, primarySources } from "./sources"
import { middle } from "./truncate"

const grant = (
  id: string,
  path: string,
  access: "read" | "write",
  over: Partial<FilesystemGrant> = {},
): FilesystemGrant => ({
  id,
  path,
  access,
  scope: "session",
  source: "permission",
  time: { created: 0 },
  ...over,
})

describe("pane sources", () => {
  test("puts shared project files first, saved Results next, and recovery last", () => {
    const list = buildSources({
      projectRoot: "/home/keertan/codes/openscience-demoo",
      projectName: "openscience-demoo",
      grants: [grant("g1", "/home/keertan/data/pdebench", "read")],
    })

    expect(list.map((s) => s.id)).toEqual(["project", "artifacts", "g1", "trash"])
    expect(list[0]).toMatchObject({ group: "Working files", name: "Project files" })
    expect(list[0]?.sub).toBe("/home/keertan/codes/openscience-demoo")
    expect(list[1]).toMatchObject({ group: "Results", name: "Results" })
    expect(list.at(-1)?.group).toBe("Recovery")
  })

  test("always offers trash so the delete dialog's 30-day recovery promise has a surface", () => {
    const list = buildSources({ projectRoot: "/p", projectName: "p", grants: [] })
    const entry = list.find((s) => s.kind === "trash")

    expect(entry?.id).toBe("trash")
    expect(entry?.group).toBe("Recovery")
    expect(entry?.detail).toContain("30 days")
  })

  // A delegated conversation is handed its lead's working folder. It browses
  // it like any other connected folder, but the grant is the lead's, so the
  // pane must not offer to end it from here.
  test("marks a folder inherited from a lead session rather than presenting it as one connected here", () => {
    const list = buildSources({
      projectRoot: "/p",
      projectName: "p",
      grants: [grant("g_own", "/data/rinr", "write"), grant("g_lead", "/data/lead", "write", { source: "parent" })],
    })

    expect(list.find((s) => s.id === "g_lead")).toMatchObject({ kind: "connected", inherited: true })
    expect(list.find((s) => s.id === "g_own")?.inherited).toBe(false)
  })

  // Revoking reaches exactly as far as the grant does, so the row has to carry
  // how far that is — an installation-wide folder looked like a project one.
  test("carries the grant's own scope on the folder it lists", () => {
    const list = buildSources({
      projectRoot: "/p",
      projectName: "p",
      grants: [
        grant("g_session", "/data/one", "write"),
        grant("g_project", "/data/two", "write", { scope: "project" }),
        grant("g_wide", "/data/three", "write", { scope: "installation" }),
      ],
    })

    expect(list.find((s) => s.id === "g_session")?.scope).toBe("session")
    expect(list.find((s) => s.id === "g_project")?.scope).toBe("project")
    expect(list.find((s) => s.id === "g_wide")?.scope).toBe("installation")
    // Nothing else in the pane is a grant, so nothing else claims a reach.
    expect(list.find((s) => s.kind === "project")?.scope).toBeUndefined()
  })

  test("marks a read grant read-only so the badge has something true to show", () => {
    const list = buildSources({
      projectRoot: "/p",
      projectName: "p",
      grants: [grant("r", "/data/ro", "read"), grant("w", "/data/rw", "write")],
    })

    expect(list.find((s) => s.id === "r")?.readonly).toBe(true)
    expect(list.find((s) => s.id === "w")?.readonly).toBe(false)
  })

  test("includes the session workspace only when one exists", () => {
    const without = buildSources({ projectRoot: "/p", projectName: "p", grants: [] })
    const with_ = buildSources({ projectRoot: "/p", projectName: "p", grants: [], sessionRoot: "/p/.session" })

    expect(without.some((s) => s.kind === "session")).toBe(false)
    expect(with_.find((s) => s.kind === "session")?.root).toBe("/p/.session")
    expect(with_.find((s) => s.kind === "session")).toMatchObject({
      name: "This session",
      detail: "Temporary working files for this conversation",
    })
  })

  test("does not relabel the project directory as session scratch space", () => {
    const exact = buildSources({
      projectRoot: "/work/OpenScience",
      projectName: "OpenScience",
      grants: [],
      sessionRoot: "/work/OpenScience",
    })
    const normalized = buildSources({
      projectRoot: "/work/OpenScience/",
      projectName: "OpenScience",
      grants: [],
      sessionRoot: "/work/./OpenScience",
    })

    expect(exact.filter((source) => source.kind === "session")).toHaveLength(0)
    expect(normalized.filter((source) => source.kind === "session")).toHaveLength(0)
    expect(exact.filter((source) => source.root === "/work/OpenScience")).toHaveLength(1)
  })

  test("keeps a genuinely distinct session workspace visible", () => {
    const list = buildSources({
      projectRoot: "/work/OpenScience",
      projectName: "OpenScience",
      grants: [],
      sessionRoot: "/app-data/workspaces/prj_1/ses_1",
    })

    expect(list.find((source) => source.kind === "session")).toMatchObject({
      name: "This session",
      detail: "Temporary working files for this conversation",
      root: "/app-data/workspaces/prj_1/ses_1",
    })
  })

  test("groups in a fixed order and drops empty groups", () => {
    const groups = groupSources(buildSources({ projectRoot: "/p", projectName: "p", grants: [] }))

    expect(groups.map((g) => g.group)).toEqual(["Working files", "Results", "Recovery"])
  })

  // One entry per provider. Remote will hold AWS, GCP and the rest, and an
  // account with forty Volumes listed individually would bury the local sources.
  test("offers Modal as one remote source, not one per Volume", () => {
    const remote = buildSources({ projectRoot: "/p", projectName: "p", grants: [], modal: true }).filter(
      (source) => source.kind === "modal",
    )

    expect(remote).toHaveLength(1)
    expect(remote[0]!.id).toBe("modal")
    expect(remote[0]!.name).toBe("Modal Volumes")
    expect(remote[0]!.group).toBe("Remote")
    // Browsable and downloadable, never writable: it is an API, not a mount.
    expect(remote[0]!.readonly).toBe(true)
    // Empty root: the pane joins root with the walked path, and the first level
    // inside this source is the Volume list.
    expect(remote[0]!.root).toBe("")
  })

  test("omits the remote group entirely when Modal is not connected", () => {
    const groups = groupSources(buildSources({ projectRoot: "/p", projectName: "p", grants: [], modal: false }))

    expect(groups.map((g) => g.group)).not.toContain("Remote")
  })

  test("keeps remote sources after local ones so the picker order is stable", () => {
    const groups = groupSources(buildSources({ projectRoot: "/p", projectName: "p", grants: [], modal: true }))

    expect(groups.map((g) => g.group)).toEqual(["Working files", "Results", "Remote", "Recovery"])
  })
})

describe("where the pane opens", () => {
  const list = buildSources({
    projectRoot: "/home/keertan/.openscience/projects/prj_1",
    projectName: "RINR",
    grants: [grant("g1", "/home/keertan/data/pdebench", "read"), grant("g2", "/home/keertan/codes/RINR", "write")],
  })

  // The project root is a managed directory that stays empty until something
  // writes there, so it is the last answer, not the first.
  test("lands on the conversation's working folder when nothing has been picked", () => {
    expect(defaultSource(list, { workingRoot: "/home/keertan/codes/RINR" }).id).toBe("g2")
  })

  test("prefers the pick someone made over the computed default", () => {
    expect(defaultSource(list, { remembered: "artifacts", workingRoot: "/home/keertan/codes/RINR" }).id).toBe(
      "artifacts",
    )
  })

  test("falls back past a pick that no longer names a source, as a revoked grant does not", () => {
    expect(defaultSource(list, { remembered: "g_revoked", workingRoot: "/home/keertan/codes/RINR" }).id).toBe("g2")
    expect(defaultSource(list, { remembered: "g_revoked" }).id).toBe("project")
  })

  test("uses project files when the session works in no connected folder", () => {
    expect(defaultSource(list, {}).id).toBe("project")
    // A working root that names no listed location at all leaves the default
    // where it was rather than selecting nothing.
    expect(defaultSource(list, { workingRoot: "/data/elsewhere" }).id).toBe("project")
  })

  // Pinning "Scratch" in the composer moves the conversation into the session's
  // own temporary directory. That location has a tab of its own, so the pane
  // opens on it rather than falling through to the empty project root.
  test("opens on This session when the conversation works in its own scratch", () => {
    const withScratch = buildSources({
      projectRoot: "/home/keertan/.openscience/projects/prj_1",
      projectName: "RINR",
      grants: [grant("g2", "/home/keertan/codes/RINR", "write")],
      sessionRoot: "/scratch/ses_1",
    })

    expect(defaultSource(withScratch, { workingRoot: "/scratch/ses_1" }).id).toBe("session")
    // The tab strip is unchanged by it: This session already has a permanent
    // tab, so nothing is promoted in its name.
    expect(primarySources(withScratch, "/scratch/ses_1").map((source) => source.id)).toEqual([
      "project",
      "g2",
      "session",
      "artifacts",
    ])
  })

  test("matches the working folder through path spelling rather than string equality", () => {
    expect(defaultSource(list, { workingRoot: "/home/keertan/codes/RINR/" }).id).toBe("g2")
    expect(defaultSource(list, { workingRoot: "/home/keertan/codes/./RINR" }).id).toBe("g2")
  })

  // A Windows volume is case-insensitive, so the server's spelling of the
  // working folder and the grant's need not agree letter for letter. They did
  // have to, and a pane on Windows opened on the empty project root instead.
  test("matches a Windows working folder the server spelled in another case", () => {
    const windows = buildSources({
      projectRoot: "C:\\Users\\keertan\\.openscience\\projects\\prj_1",
      projectName: "RINR",
      grants: [grant("g1", "C:\\Research\\RINR", "write")],
    })

    expect(defaultSource(windows, { workingRoot: "c:/research/rinr" }).id).toBe("g1")
    expect(primarySources(windows, "c:/research/rinr").map((source) => source.id)).toEqual([
      "project",
      "g1",
      "artifacts",
    ])
    // POSIX paths keep their case: /Data and /data are two different folders.
    expect(defaultSource(list, { workingRoot: "/home/keertan/codes/rinr" }).id).toBe("project")
  })
})

describe("primary locations", () => {
  const withGrants = (paths: string[]) =>
    buildSources({
      projectRoot: "/p",
      projectName: "p",
      grants: paths.map((path, index) => grant(`g${index}`, path, "write")),
      sessionRoot: "/scratch/ses_1",
    })

  test("gives connected folders tabs beside project files instead of hiding them behind More", () => {
    const tabs = primarySources(withGrants(["/data/rinr", "/data/notes"]), "/data/rinr")

    expect(tabs.map((source) => source.id)).toEqual(["project", "g0", "g1", "session", "artifacts"])
  })

  test("leads with the folder this conversation works in, so the default location is always a tab", () => {
    const tabs = primarySources(withGrants(["/data/a", "/data/b", "/data/c"]), "/data/c")

    expect(tabs.map((source) => source.id)).toEqual(["project", "g2", "g0", "g1", "session", "artifacts"])
  })

  test("promotes at most three folders and leaves the rest to the overflow menu", () => {
    const tabs = primarySources(withGrants(["/data/a", "/data/b", "/data/c", "/data/d"]), "/data/d")

    expect(tabs.filter((source) => source.kind === "connected").map((source) => source.id)).toEqual(["g3", "g0", "g1"])
  })

  test("keeps the permanent locations when there is nothing connected", () => {
    expect(primarySources(withGrants([])).map((source) => source.id)).toEqual(["project", "session", "artifacts"])
  })
})

describe("middle truncation", () => {
  test("keeps the head and the extension so sibling files stay distinguishable", () => {
    expect(middle("proteomics_dock_gpu.py", 18)).toBe("proteo…ock_gpu.py")
    expect(middle("short.py", 18)).toBe("short.py")
  })

  test("never returns more characters than asked for", () => {
    for (const keep of [6, 10, 18, 30]) {
      expect(middle("modal_env_parser_test.ipynb", keep).length).toBeLessThanOrEqual(keep)
    }
  })
})
