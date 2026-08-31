import { describe, expect, test } from "bun:test"
import type { Project } from "@synsci/sdk/v2/client"
import {
  migrateServerProjects,
  normalizeServerUrl,
  resolveServerProjects,
  serverDisplayName,
  serverCatalogKey,
  visibleServerProjects,
} from "./server"

const project: Project = {
  id: "prj_atlas",
  worktree: "/research/atlas",
  time: {
    created: 1,
    updated: 2,
  },
  sandboxes: ["/private/tmp/atlas-linked"],
}

describe("server project persistence", () => {
  test("never shares a live catalog between desktop and development servers", () => {
    expect(serverCatalogKey("http://localhost:4096")).not.toBe(serverCatalogKey("http://localhost:5555"))
    expect(serverCatalogKey("http://127.0.0.1:4096")).not.toBe(serverCatalogKey("http://127.0.0.1:5555"))
    expect(serverCatalogKey("http://localhost:4096/")).toBe(serverCatalogKey("http://localhost:4096"))
  })

  test("does not render unverified legacy folders from another server or deleted projects", () => {
    expect(visibleServerProjects([], [{ worktree: "/unrelated", expanded: true }], [project])).toEqual([])
    expect(visibleServerProjects([{ projectID: project.id, expanded: true }], [], [])).toEqual([])
  })
  test("normalizes adversarial slash-heavy server input without a regular expression", () => {
    const slashes = "/".repeat(100_000)
    expect(normalizeServerUrl(` example.com${slashes}`)).toBe("http://example.com")
    expect(serverDisplayName(`https://example.com${slashes}`)).toBe("example.com")
  })

  test("extracts legacy path keys without writing them back to persisted state", () => {
    const migrated = migrateServerProjects({
      projects: {
        local: [
          { worktree: "/research/atlas", expanded: false },
          { worktree: "/private/tmp/atlas-linked", expanded: true },
          { projectID: "prj_current", expanded: true },
        ],
      },
      lastProject: {
        local: "/private/tmp/atlas-linked",
        remote: "prj_remote",
      },
    })

    expect(migrated.state).toEqual({
      projects: {
        local: [{ projectID: "prj_current", expanded: true }],
      },
      lastProject: {
        remote: "prj_remote",
      },
    })
    expect(migrated.legacy).toEqual({
      projects: {
        local: [
          { worktree: "/research/atlas", expanded: false },
          { worktree: "/private/tmp/atlas-linked", expanded: true },
        ],
      },
      lastProject: {
        local: "/private/tmp/atlas-linked",
      },
    })
    expect(JSON.stringify(migrated.state)).not.toContain("/research/atlas")
    expect(JSON.stringify(migrated.state)).not.toContain("/private/tmp/atlas-linked")
  })

  test("collapses linked worktrees onto one opaque canonical project identity", () => {
    const migrated = migrateServerProjects({
      projects: {
        local: [
          { worktree: project.worktree, expanded: false },
          { worktree: project.sandboxes[0], expanded: true },
        ],
      },
      lastProject: {
        local: project.sandboxes[0],
      },
    })
    const resolved = resolveServerProjects("local", migrated.state, migrated.legacy, [project])

    expect(resolved).toEqual({
      projects: [{ projectID: project.id, expanded: true }],
      unresolved: [],
      lastProject: project.id,
      legacyLastProject: undefined,
    })
    expect(visibleServerProjects(resolved.projects, resolved.unresolved, [project])).toEqual([
      {
        projectID: project.id,
        worktree: project.worktree,
        expanded: true,
      },
    ])
  })
})
