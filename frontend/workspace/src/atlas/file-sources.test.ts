import { describe, expect, test } from "bun:test"
import {
  connectedFilesystemGrants,
  containsFilePath,
  findFilesystemGrant,
  parseFilesystemSnapshot,
  sessionFilesystemRoot,
  type FilesystemSnapshot,
} from "./file-sources"

const snapshot = {
  version: 1,
  revision: 4,
  sessionID: "ses_alpha",
  projectID: "prj_alpha",
  directory: "/work/alpha",
  grants: [
    {
      id: "fsg_workspace",
      path: "/work/alpha",
      access: "write",
      scope: "session",
      source: "workspace",
      time: { created: 1 },
    },
    {
      id: "fsg_read",
      path: "/data/reference",
      access: "read",
      scope: "session",
      source: "api",
      time: { created: 2 },
    },
    {
      id: "fsg_publish",
      path: "/data/publish",
      access: "write",
      scope: "project",
      source: "permission",
      time: { created: 3 },
    },
    {
      id: "fsg_installation",
      path: "/data/shared",
      access: "read",
      scope: "installation",
      source: "permission",
      time: { created: 4 },
    },
    {
      id: "fsg_revoked",
      path: "/data/old",
      access: "read",
      scope: "session",
      source: "api",
      time: { created: 5, revoked: 6 },
    },
  ],
  enforcement: {
    broker: "enforced",
    processWrite: "grant_only",
    processRead: "policy_only",
  },
} satisfies FilesystemSnapshot

describe("filesystem source isolation", () => {
  test("accepts only the matching session, project, and project directory", () => {
    expect(
      parseFilesystemSnapshot(snapshot, {
        sessionID: "ses_alpha",
        projectID: "prj_alpha",
        directory: "/work/alpha",
      }),
    ).toEqual(snapshot)
    expect(
      parseFilesystemSnapshot(snapshot, {
        sessionID: "ses_beta",
        projectID: "prj_alpha",
        directory: "/work/alpha",
      }),
    ).toBeUndefined()
    expect(
      parseFilesystemSnapshot(snapshot, {
        sessionID: "ses_alpha",
        projectID: "prj_beta",
        directory: "/work/alpha",
      }),
    ).toBeUndefined()
    expect(
      parseFilesystemSnapshot(snapshot, {
        sessionID: "ses_alpha",
        projectID: "prj_alpha",
        directory: "/work/beta",
      }),
    ).toBeUndefined()
  })

  test("shows only active connected folders and preserves read versus publish authority", () => {
    const grants = connectedFilesystemGrants(snapshot)

    expect(grants.map((grant) => grant.id)).toEqual(["fsg_read", "fsg_publish", "fsg_installation"])
    expect(findFilesystemGrant(snapshot, "/data/reference/genes.csv", "read")?.id).toBe("fsg_read")
    expect(findFilesystemGrant(snapshot, "/data/reference/genes.csv", "write")).toBeUndefined()
    expect(findFilesystemGrant(snapshot, "/data/publish/report.pdf", "write")?.id).toBe("fsg_publish")
    expect(findFilesystemGrant(snapshot, "/data/shared/reference.csv", "read")?.id).toBe("fsg_installation")
    expect(findFilesystemGrant(snapshot, "/data/old/result.csv", "read")).toBeUndefined()
  })

  test("accepts internal tool authority without exposing it as a connected folder", () => {
    const mixed = {
      ...snapshot,
      enforcement: { ...snapshot.enforcement, processRead: "grant_only" as const },
      grants: [
        snapshot.grants[0],
        {
          id: "fsg_tool",
          path: "/work/alpha/.scratch/tool-output",
          access: "read",
          scope: "session",
          source: "tool",
          time: { created: 2 },
        },
        snapshot.grants[1],
      ],
    } satisfies FilesystemSnapshot

    const parsed = parseFilesystemSnapshot(mixed, {
      sessionID: "ses_alpha",
      projectID: "prj_alpha",
      directory: "/work/alpha",
    })

    expect(parsed?.grants.map((grant) => grant.source)).toEqual(["workspace", "tool", "api"])
    expect(connectedFilesystemGrants(parsed).map((grant) => grant.id)).toEqual(["fsg_read"])
  })

  test("uses the durable session workspace grant as the Session files root", () => {
    expect(sessionFilesystemRoot(snapshot)).toBe("/work/alpha")
    expect(sessionFilesystemRoot()).toBeUndefined()
  })

  test("treats the filesystem root as containing its descendants", () => {
    expect(containsFilePath("/", "/outputs/model.pt")).toBe(true)
    expect(containsFilePath("/", "relative/model.pt")).toBe(false)
  })

  test("parses project-persistent folder grants without weakening project identity checks", () => {
    const parsed = parseFilesystemSnapshot(snapshot, {
      sessionID: "ses_alpha",
      projectID: "prj_alpha",
      directory: "/work/alpha",
    })
    expect(parsed?.grants.find((grant) => grant.id === "fsg_publish")?.scope).toBe("project")
    expect(
      parseFilesystemSnapshot(snapshot, {
        sessionID: "ses_alpha",
        projectID: "prj_other",
        directory: "/work/alpha",
      }),
    ).toBeUndefined()
  })
})
