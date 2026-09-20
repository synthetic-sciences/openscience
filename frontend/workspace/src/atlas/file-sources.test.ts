import { describe, expect, test } from "bun:test"
import {
  connectedFilesystemGrants,
  containsFilePath,
  findFilesystemGrant,
  parseFilesystemSnapshot,
  sessionFilesystemRoot,
  workingFilesystemRoot,
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

    // A legacy installation-wide grant is not this project's working folder.
    expect(grants.map((grant) => grant.id)).toEqual(["fsg_read", "fsg_publish"])
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

  test("keeps the project's own roots and skill directories out of Working files", () => {
    const mixed = {
      ...snapshot,
      grants: [
        snapshot.grants[0],
        {
          id: "fsg_project",
          path: "/work/alpha-worktree",
          access: "write",
          scope: "session",
          source: "project",
          time: { created: 2 },
        },
        {
          id: "fsg_skill",
          path: "/opt/openscience/skills/ml-training/ml-benchmark-evaluation",
          access: "read",
          scope: "session",
          source: "skill",
          time: { created: 3 },
        },
        snapshot.grants[1],
      ],
    } satisfies FilesystemSnapshot

    const parsed = parseFilesystemSnapshot(mixed, {
      sessionID: "ses_alpha",
      projectID: "prj_alpha",
      directory: "/work/alpha",
    })

    expect(parsed?.grants.map((grant) => grant.source)).toEqual(["workspace", "project", "skill", "api"])
    expect(connectedFilesystemGrants(parsed).map((grant) => grant.id)).toEqual(["fsg_read"])
    // Both still authorize reads for the viewer.
    expect(findFilesystemGrant(parsed, "/work/alpha-worktree/results/out.csv", "write")?.id).toBe("fsg_project")
    expect(
      findFilesystemGrant(parsed, "/opt/openscience/skills/ml-training/ml-benchmark-evaluation/SKILL.md", "read")?.id,
    ).toBe("fsg_skill")
  })

  test("accepts delegated handoff authority without presenting it as a connected folder", () => {
    const mixed = {
      ...snapshot,
      enforcement: { ...snapshot.enforcement, processRead: "grant_only" as const },
      grants: [
        snapshot.grants[0],
        {
          id: "fsg_handoff",
          path: "/work/parent/evidence",
          access: "read",
          scope: "session",
          source: "handoff",
          time: { created: 2 },
        },
      ],
    } satisfies FilesystemSnapshot

    const parsed = parseFilesystemSnapshot(mixed, {
      sessionID: "ses_alpha",
      projectID: "prj_alpha",
      directory: "/work/alpha",
    })

    expect(parsed?.grants.map((grant) => grant.source)).toEqual(["workspace", "handoff"])
    expect(findFilesystemGrant(parsed, "/work/parent/evidence/table.csv", "read")?.id).toBe("fsg_handoff")
    expect(connectedFilesystemGrants(parsed)).toEqual([])
  })

  test("uses the durable session workspace grant as the Session files root", () => {
    expect(sessionFilesystemRoot(snapshot)).toBe("/work/alpha")
    expect(sessionFilesystemRoot()).toBeUndefined()
  })

  const newest = {
    id: "fsg_newest",
    path: "/data/rinr",
    access: "write",
    scope: "project",
    source: "permission",
    time: { created: 9 },
  } as const

  // The composer's "Working in …" chip reads the server's `toolDirectory`. A
  // folder pinned there leaves no trace in the grants, so recomputing from them
  // contradicts the chip the moment anyone pins an older folder.
  test("names the working folder the server resolved, not the newest grant", () => {
    const pinned = {
      ...snapshot,
      toolDirectory: "/data/publish",
      grants: [...snapshot.grants, newest],
    } satisfies FilesystemSnapshot

    expect(workingFilesystemRoot(pinned)).toBe("/data/publish")
  })

  // Pinning "Scratch" puts the conversation in its own temporary directory —
  // the session workspace grant, which the pane offers as "This session" and
  // never as a connected folder.
  test("names the session scratch root when the conversation is pinned to Scratch", () => {
    const scratch = {
      ...snapshot,
      toolDirectory: "/work/alpha",
      grants: [...snapshot.grants, newest],
    } satisfies FilesystemSnapshot

    expect(workingFilesystemRoot(scratch)).toBe("/work/alpha")
    expect(sessionFilesystemRoot(scratch)).toBe("/work/alpha")
  })

  // Older servers send no `toolDirectory`, and then the pane has to guess.
  test("falls back to the newest writable connected folder when none is sent", () => {
    const newer = { ...snapshot, grants: [...snapshot.grants, newest] } satisfies FilesystemSnapshot

    expect(workingFilesystemRoot(snapshot)).toBe("/data/publish")
    expect(workingFilesystemRoot(newer)).toBe("/data/rinr")
    expect(workingFilesystemRoot()).toBeUndefined()
  })

  // The guess weighs what the server weighs: a folder inherited from a parent
  // session is a working folder there, and an installation-wide grant is not
  // disqualified from being one, while a one-shot grant never is.
  test("weighs the candidates the server weighs when it has to guess", () => {
    const inherited = {
      ...snapshot,
      grants: [snapshot.grants[0], { ...newest, id: "fsg_parent", path: "/data/inherited", source: "parent" }],
    } satisfies FilesystemSnapshot
    const installation = {
      ...snapshot,
      grants: [snapshot.grants[0], { ...newest, id: "fsg_wide", path: "/data/shared", scope: "installation" }],
    } satisfies FilesystemSnapshot
    const transient = {
      ...snapshot,
      grants: [snapshot.grants[0], { ...newest, id: "fsg_once", path: "/data/drop", scope: "once" }],
    } satisfies FilesystemSnapshot

    expect(workingFilesystemRoot(inherited)).toBe("/data/inherited")
    expect(workingFilesystemRoot(installation)).toBe("/data/shared")
    expect(workingFilesystemRoot(transient)).toBeUndefined()
  })

  test("carries the resolved working folder through the guard in the pane's path spelling", () => {
    const identity = { sessionID: "ses_alpha", projectID: "prj_alpha", directory: "/work/alpha" }

    expect(parseFilesystemSnapshot({ ...snapshot, toolDirectory: "/data/publish/." }, identity)?.toolDirectory).toBe(
      "/data/publish",
    )
    // A working folder that is not a path makes the payload malformed, and the
    // guard rejects a malformed payload whole rather than half-trusting it.
    expect(parseFilesystemSnapshot({ ...snapshot, toolDirectory: 7 }, identity)).toBeUndefined()
  })

  test("leaves a read-only grant out of the working folder", () => {
    const readOnly = { ...snapshot, grants: [snapshot.grants[0], snapshot.grants[1]] } satisfies FilesystemSnapshot

    expect(connectedFilesystemGrants(readOnly).map((grant) => grant.id)).toEqual(["fsg_read"])
    expect(workingFilesystemRoot(readOnly)).toBeUndefined()
  })

  test("treats the filesystem root as containing its descendants", () => {
    expect(containsFilePath("/", "/outputs/model.pt")).toBe(true)
    expect(containsFilePath("/", "relative/model.pt")).toBe(false)
    expect(containsFilePath("C:\\Research\\CERBench", "c:\\research\\cerbench\\results.csv")).toBe(true)
    expect(containsFilePath("C:\\Research\\CERBench", "C:\\Research\\CERBench-old\\results.csv")).toBe(false)
  })

  test("accepts a Windows filesystem snapshot when only path casing differs", () => {
    const windows = {
      ...snapshot,
      directory: "C:\\Research\\CERBench",
      grants: snapshot.grants.map((grant) => ({
        ...grant,
        path: grant.path.replace("/work/alpha", "C:\\Research\\CERBench"),
      })),
    }

    expect(
      parseFilesystemSnapshot(windows, {
        sessionID: "ses_alpha",
        projectID: "prj_alpha",
        directory: "c:\\research\\cerbench",
      })?.directory,
    ).toBe("c:/Research/CERBench")
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
