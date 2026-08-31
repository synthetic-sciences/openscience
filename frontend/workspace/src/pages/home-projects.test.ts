import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const file = fileURLToPath(new URL("./home-projects.ts", import.meta.url))

const load = async () => {
  const exists = await Bun.file(file).exists()
  expect(exists).toBe(true)
  if (!exists) return
  return import("./home-projects")
}

describe("home project preparation", () => {
  test("deduplicates project IDs, honors legacy hidden paths, and sorts by recency", async () => {
    const subject = await load()
    if (!subject) return

    const projects = subject.prepareProjects(
      [
        { id: "prj_older", worktree: "/work/older", origin: "openscience" as const, time: { created: 10 } },
        {
          id: "prj_newer",
          worktree: "/work/newer",
          origin: "openscience" as const,
          time: { created: 20, updated: 50, activity: 50 },
        },
        {
          id: "prj_older",
          worktree: "/work/older",
          origin: "openscience" as const,
          time: { created: 10, updated: 70, activity: 70 },
        },
        { id: "prj_hidden", worktree: "/work/hidden", origin: "openscience" as const, time: { created: 100 } },
        {
          id: "prj_archived",
          worktree: "/work/archived",
          origin: "openscience" as const,
          time: { created: 200, archived: 201 },
        },
      ],
      new Set(["/work/hidden"]),
    )

    expect(projects).toEqual([
      {
        id: "prj_older",
        worktree: "/work/older",
        origin: "openscience",
        time: { created: 10, updated: 70, activity: 70 },
        updatedAt: 70,
        pinned: false,
      },
      {
        id: "prj_newer",
        worktree: "/work/newer",
        origin: "openscience",
        time: { created: 20, updated: 50, activity: 50 },
        updatedAt: 50,
        pinned: false,
      },
    ])
  })

  test("keeps pinned projects above newer recent projects", async () => {
    const subject = await load()
    if (!subject) return

    const projects = subject.prepareProjects(
      [
        { id: "prj_pinned", worktree: "/work/pinned", origin: "openscience", time: { created: 10 } },
        { id: "prj_recent", worktree: "/work/recent", origin: "openscience", time: { created: 100 } },
      ],
      new Set(),
      new Set(["prj_pinned"]),
    )

    expect(projects.map((project) => [project.id, project.pinned])).toEqual([
      ["prj_pinned", true],
      ["prj_recent", false],
    ])
  })

  test("keeps newer activity independently of metadata ordering and resolves archives before filtering", async () => {
    const subject = await load()
    if (!subject) return
    const base = {
      id: "prj_study",
      worktree: "/study",
      origin: "openscience" as const,
      time: { created: 10, updated: 20, activity: 30 },
    }
    const active = { ...base, time: { ...base.time, activity: 100 } }
    for (const records of [
      [base, active],
      [active, base],
    ]) {
      expect(subject.prepareProjects(records, new Set())[0].updatedAt).toBe(100)
    }
    const archived = { ...base, time: { ...base.time, updated: 150, archived: 150 } }
    for (const records of [
      [active, archived],
      [archived, active],
    ]) {
      expect(subject.prepareProjects(records, new Set())).toEqual([])
      expect(subject.prepareArchivedProjects(records)).toHaveLength(1)
      expect(subject.prepareArchivedProjects(records)[0].time.activity).toBe(100)
    }
    const restored = { ...base, time: { ...base.time, updated: 160 } }
    expect(subject.prepareArchivedProjects([archived, restored])).toEqual([])
  })

  test("does not use polluted metadata updates for recency, including legacy records", async () => {
    const subject = await load()
    if (!subject) return
    const projects = subject.prepareProjects(
      [
        { id: "prj_idle", worktree: "/idle", origin: "openscience", time: { created: 10, updated: 9999 } },
        {
          id: "prj_active",
          worktree: "/active",
          origin: "openscience",
          time: { created: 20, updated: 30, activity: 200 },
        },
        { id: "prj_new", worktree: "/new", origin: "openscience", time: { created: 100, updated: 100 } },
      ],
      new Set(),
    )
    expect(projects.map((project) => [project.id, project.updatedAt])).toEqual([
      ["prj_active", 200],
      ["prj_new", 100],
      ["prj_idle", 10],
    ])
  })

  test("keeps arbitrary resolved directories out and orders equal activity deterministically", async () => {
    const subject = await load()
    if (!subject) return

    const projects = subject.prepareProjects(
      [
        { id: "prj_random", worktree: "/work/random-repo", time: { created: 100 } },
        {
          id: "prj_zeta",
          name: "Zeta study",
          worktree: "/data/projects/zeta",
          origin: "openscience",
          time: { created: 50, updated: 100, activity: 100 },
        },
        {
          id: "prj_alpha",
          name: "Alpha study",
          worktree: "/data/projects/alpha",
          origin: "openscience",
          time: { created: 40, updated: 100, activity: 100 },
        },
      ],
      new Set(),
    )

    expect(projects.map((project) => project.id)).toEqual(["prj_alpha", "prj_zeta"])
  })

  test("keeps archived projects recoverable without mixing them into active projects", async () => {
    const subject = await load()
    if (!subject) return

    const projects = [
      { id: "prj_active", worktree: "/work/active", origin: "openscience" as const, time: { created: 30 } },
      {
        id: "prj_old",
        worktree: "/work/old",
        origin: "openscience" as const,
        time: { created: 10, archived: 40 },
      },
      {
        id: "prj_new",
        name: "Archived study",
        worktree: "/work/new",
        origin: "openscience" as const,
        time: { created: 20, archived: 60 },
      },
    ]

    expect(subject.prepareProjects(projects, new Set()).map((project) => project.id)).toEqual(["prj_active"])
    expect(subject.prepareArchivedProjects(projects).map((project) => project.id)).toEqual(["prj_new", "prj_old"])
  })

  test("filters case-insensitively by project name, folder path, or opaque ID", async () => {
    const subject = await load()
    if (!subject) return

    const projects = subject.prepareProjects(
      [
        {
          id: "prj_protein",
          name: "Protein Folding",
          worktree: "/Users/aayam/Research/Protein-Folding",
          origin: "openscience",
          time: { created: 30 },
        },
        {
          id: "prj_weather",
          worktree: "/Users/aayam/Labs/Weather",
          origin: "openscience",
          time: { created: 20 },
        },
      ],
      new Set(),
    )

    expect(subject.filterProjects(projects, "protein")).toEqual([projects[0]])
    expect(subject.filterProjects(projects, "PRJ_WEATHER")).toEqual([projects[1]])
    expect(subject.filterProjects(projects, "labs")).toEqual([projects[1]])
    expect(subject.filterProjects(projects, "   ")).toEqual(projects)
  })

  test("uses a readable label while keeping raw paths out of project identity", async () => {
    const subject = await load()
    if (!subject) return

    const project = {
      id: "prj_1234567890abcdefghijkl",
      name: "Gateway Research",
      worktree: "/Users/aayam/Research/atlas",
      time: { created: 10 },
    }
    expect(subject.projectName(project)).toBe("Gateway Research")
    expect(subject.projectName(project)).not.toContain(project.worktree)
  })

  test("falls back to the folder when stored project metadata is corrupt", async () => {
    const subject = await load()
    if (!subject) return

    expect(
      subject.projectName({
        id: "prj_corrupt",
        name: "���\u007f^��",
        worktree: "/Users/aayam/Research/valid-project",
        time: { created: 10 },
      }),
    ).toBe("valid-project")
  })
})

describe("home launcher state", () => {
  test("distinguishes loading, error, empty, and recent states", async () => {
    const subject = await load()
    if (!subject) return

    expect(subject.launcherState({ ready: false, healthy: undefined, projectCount: 0 })).toBe("loading")
    expect(subject.launcherState({ ready: true, healthy: false, projectCount: 0 })).toBe("error")
    expect(subject.launcherState({ ready: true, healthy: true, error: new Error("offline"), projectCount: 0 })).toBe(
      "error",
    )
    expect(subject.launcherState({ ready: true, healthy: true, projectCount: 0 })).toBe("empty")
    expect(subject.launcherState({ ready: false, healthy: false, projectCount: 1 })).toBe("recent")
  })
})
