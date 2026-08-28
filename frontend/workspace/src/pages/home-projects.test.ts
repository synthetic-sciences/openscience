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
        { id: "prj_older", worktree: "/work/older", time: { created: 10 } },
        { id: "prj_newer", worktree: "/work/newer", time: { created: 20, updated: 50 } },
        { id: "prj_older", worktree: "/work/older", time: { created: 10, updated: 70 } },
        { id: "prj_hidden", worktree: "/work/hidden", time: { created: 100 } },
        { id: "prj_archived", worktree: "/work/archived", time: { created: 200, archived: 201 } },
      ],
      new Set(["/work/hidden"]),
    )

    expect(projects).toEqual([
      { id: "prj_older", worktree: "/work/older", time: { created: 10, updated: 70 }, updatedAt: 70, pinned: false },
      { id: "prj_newer", worktree: "/work/newer", time: { created: 20, updated: 50 }, updatedAt: 50, pinned: false },
    ])
  })

  test("keeps pinned projects above newer recent projects", async () => {
    const subject = await load()
    if (!subject) return

    const projects = subject.prepareProjects(
      [
        { id: "prj_pinned", worktree: "/work/pinned", time: { created: 10 } },
        { id: "prj_recent", worktree: "/work/recent", time: { created: 100 } },
      ],
      new Set(),
      new Set(["prj_pinned"]),
    )

    expect(projects.map((project) => [project.id, project.pinned])).toEqual([
      ["prj_pinned", true],
      ["prj_recent", false],
    ])
  })

  test("keeps archived projects recoverable without mixing them into active projects", async () => {
    const subject = await load()
    if (!subject) return

    const projects = [
      { id: "prj_active", worktree: "/work/active", time: { created: 30 } },
      { id: "prj_old", worktree: "/work/old", time: { created: 10, archived: 40 } },
      { id: "prj_new", name: "Archived study", worktree: "/work/new", time: { created: 20, archived: 60 } },
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
          time: { created: 30 },
        },
        { id: "prj_weather", worktree: "/Users/aayam/Labs/Weather", time: { created: 20 } },
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
