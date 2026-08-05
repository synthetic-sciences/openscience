import { describe, expect, test } from "bun:test"
import { groupBySession, sessionLabel, sortArtifacts } from "./artifact-groups"
import type { StoredArtifact } from "@/artifacts/store"

const artifact = (title: string, session: string, createdAt: number): StoredArtifact =>
  ({
    schemaVersion: 1,
    id: `art_${title}`,
    projectID: "prj_1",
    title,
    kind: "file",
    currentVersionID: "ver_1",
    createdAt,
    updatedAt: createdAt,
    state: "active",
    versionCount: 1,
    current: {
      id: "ver_1",
      artifactID: `art_${title}`,
      version: 1,
      filename: title,
      mimeType: "text/plain",
      size: 10,
      sha256: "abc",
      sessionID: session,
      sourcePath: `/tmp/${title}`,
      captureQuality: "exact",
      createdAt,
    },
  }) as StoredArtifact

const titles = new Map([["ses_alpha", "CNN training on CIFAR-10"]])

describe("artifact grouping", () => {
  test("sorts by name, and by newest first for created", () => {
    const list = [artifact("b.py", "ses_alpha", 10), artifact("a.py", "ses_alpha", 30)]

    expect(sortArtifacts(list, "name").map((item) => item.title)).toEqual(["a.py", "b.py"])
    expect(sortArtifacts(list, "created").map((item) => item.title)).toEqual(["a.py", "b.py"])
    expect(sortArtifacts([artifact("z.py", "ses_alpha", 99)].concat(list), "created")[0]!.title).toBe("z.py")
  })

  test("names a session from the sync store, and never invents one", () => {
    expect(sessionLabel("ses_alpha", titles, undefined)).toBe("CNN training on CIFAR-10")
    expect(sessionLabel("ses_alpha", titles, "ses_alpha")).toBe("This session")
    expect(sessionLabel("ses_02d73b21cffe3ckJ7JzqSdXPQ9", new Map(), undefined)).toBe("ses_…SdXPQ9")
    expect(sessionLabel("ses_beta", new Map([["ses_beta", "   "]]), undefined)).toBe("ses_…s_beta")
  })

  // The session you are working in is the one you just saved into, so it leads
  // regardless of whether another session holds something newer.
  test("pins the current session first and orders the rest by their newest", () => {
    const list = [
      artifact("old.py", "ses_current", 1),
      artifact("newest.py", "ses_beta", 100),
      artifact("middle.py", "ses_alpha", 50),
    ]

    const groups = groupBySession(list, titles, "ses_current")

    expect(groups.map((group) => group.label)).toEqual(["This session", "ses_…s_beta", "CNN training on CIFAR-10"])
    expect(groups[0]!.artifacts).toHaveLength(1)
    expect(groups[1]!.newest).toBe(100)
  })
})
