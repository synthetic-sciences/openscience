import { describe, expect, test } from "bun:test"
import type { FilesystemGrant } from "@/atlas/file-sources"
import { buildSources, groupSources } from "./sources"
import { middle } from "./truncate"

const grant = (id: string, path: string, access: "read" | "write"): FilesystemGrant => ({
  id,
  path,
  access,
  scope: "session",
  source: "permission",
  time: { created: 0 },
})

describe("pane sources", () => {
  test("puts Results first, working files next, and recovery last", () => {
    const list = buildSources({
      projectRoot: "/home/keertan/codes/openscience-demoo",
      projectName: "openscience-demoo",
      grants: [grant("g1", "/home/keertan/data/pdebench", "read")],
    })

    expect(list.map((s) => s.id)).toEqual(["artifacts", "project", "g1", "trash"])
    expect(list[0]).toMatchObject({ group: "Results", name: "Results" })
    expect(list[1]?.group).toBe("Working files")
    expect(list[1]?.sub).toBe("/home/keertan/codes/openscience-demoo")
    expect(list.at(-1)?.group).toBe("Recovery")
  })

  test("always offers trash so the delete dialog's 30-day recovery promise has a surface", () => {
    const list = buildSources({ projectRoot: "/p", projectName: "p", grants: [] })
    const entry = list.find((s) => s.kind === "trash")

    expect(entry?.id).toBe("trash")
    expect(entry?.group).toBe("Recovery")
    expect(entry?.detail).toContain("30 days")
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
      name: "Session workspace",
      detail: "Scratch files for this session",
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
      name: "Session workspace",
      detail: "Scratch files for this session",
      root: "/app-data/workspaces/prj_1/ses_1",
    })
  })

  test("groups in a fixed order and drops empty groups", () => {
    const groups = groupSources(buildSources({ projectRoot: "/p", projectName: "p", grants: [] }))

    expect(groups.map((g) => g.group)).toEqual(["Results", "Working files", "Recovery"])
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

    expect(groups.map((g) => g.group)).toEqual(["Results", "Working files", "Remote", "Recovery"])
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
