import { describe, expect, test } from "bun:test"
import { computeDedupeKey } from "../../src/server/routes/atlas-bridge"

describe("computeDedupeKey", () => {
  test("derives repo:<host>/<owner>/<name> from a GitHub https remote", () => {
    expect(computeDedupeKey("/anything", "https://github.com/owner/name")).toBe("repo:github.com/owner/name")
  })

  test("strips a trailing .git", () => {
    expect(computeDedupeKey("/anything", "https://github.com/owner/name.git")).toBe("repo:github.com/owner/name")
  })

  test("keeps nested group paths (e.g. gitlab subgroups)", () => {
    expect(computeDedupeKey("/anything", "https://gitlab.com/group/sub/name")).toBe(
      "repo:gitlab.com/group/sub/name",
    )
  })

  test("falls back to local-folder:<realpath> with no remote", () => {
    const key = computeDedupeKey(process.cwd(), null)
    expect(key.startsWith("local-folder:/")).toBe(true)
  })

  test("falls back to local-folder for an unparseable remote", () => {
    const key = computeDedupeKey(process.cwd(), "not a url")
    expect(key.startsWith("local-folder:/")).toBe(true)
  })

  test("is stable across repeated calls (repo case)", () => {
    const a = computeDedupeKey("/x", "https://github.com/o/n")
    const b = computeDedupeKey("/y", "https://github.com/o/n")
    expect(a).toBe(b)
  })
})
