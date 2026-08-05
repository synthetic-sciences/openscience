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
  test("puts artifacts first, then the project, then granted folders", () => {
    const list = buildSources({
      projectRoot: "/home/keertan/codes/openscience-demoo",
      projectName: "openscience-demoo",
      grants: [grant("g1", "/home/keertan/data/pdebench", "read")],
    })

    expect(list.map((s) => s.id)).toEqual(["artifacts", "trash", "project", "g1"])
    expect(list[0]?.group).toBe("Artifacts")
    expect(list[2]?.group).toBe("This computer")
    expect(list[2]?.sub).toBe("/home/keertan/codes/openscience-demoo")
  })

  test("always offers trash so the delete dialog's 30-day recovery promise has a surface", () => {
    const list = buildSources({ projectRoot: "/p", projectName: "p", grants: [] })
    const entry = list.find((s) => s.kind === "trash")

    expect(entry?.id).toBe("trash")
    expect(entry?.group).toBe("Artifacts")
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
  })

  test("groups in a fixed order and drops empty groups", () => {
    const groups = groupSources(buildSources({ projectRoot: "/p", projectName: "p", grants: [] }))

    expect(groups.map((g) => g.group)).toEqual(["Artifacts", "This computer"])
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
