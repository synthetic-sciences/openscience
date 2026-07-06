import { describe, expect, test } from "bun:test"
import {
  classifyInitFailure,
  computeDedupeKey,
  initProjectDetailed,
  pinMatchesKey,
} from "../../src/server/routes/atlas-bridge"

describe("computeDedupeKey", () => {
  test("derives repo:<host>/<owner>/<name> from a GitHub https remote", () => {
    expect(computeDedupeKey("/anything", "https://github.com/owner/name")).toBe("repo:github.com/owner/name")
  })

  test("strips a trailing .git", () => {
    expect(computeDedupeKey("/anything", "https://github.com/owner/name.git")).toBe("repo:github.com/owner/name")
  })

  test("keeps nested group paths (e.g. gitlab subgroups)", () => {
    expect(computeDedupeKey("/anything", "https://gitlab.com/group/sub/name")).toBe("repo:gitlab.com/group/sub/name")
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

describe("classifyInitFailure", () => {
  test("401/403 are unauthenticated (key rejected)", () => {
    expect(classifyInitFailure(401, "").kind).toBe("unauthenticated")
    expect(classifyInitFailure(403, "").kind).toBe("unauthenticated")
    expect(classifyInitFailure(401, "").host).toBeTruthy()
  })

  test("402 with the backend's plan_quota_exhausted payload is a plan failure", () => {
    const body = JSON.stringify({
      detail: { code: "plan_quota_exhausted", message: "Monthly quota exhausted", upgrade_url: "/billing" },
    })
    const failure = classifyInitFailure(402, body)
    expect(failure.kind).toBe("plan")
    expect(failure.message).toBe("Monthly quota exhausted")
    expect(failure.status).toBe(402)
  })

  test("a plan-worded 4xx is a plan failure even without a 402 status", () => {
    const failure = classifyInitFailure(400, JSON.stringify({ detail: "no active subscription" }))
    expect(failure.kind).toBe("plan")
    expect(failure.message).toBe("no active subscription")
  })

  test("5xx means the service could not be reached", () => {
    expect(classifyInitFailure(500, "").kind).toBe("unreachable")
    expect(classifyInitFailure(503, "upstream down").kind).toBe("unreachable")
  })

  test("other 4xx pass the backend message through", () => {
    const failure = classifyInitFailure(404, JSON.stringify({ detail: "project not found" }))
    expect(failure.kind).toBe("backend")
    expect(failure.status).toBe(404)
    expect(failure.message).toBe("project not found")
  })

  test("non-JSON bodies fall back to trimmed raw text", () => {
    expect(classifyInitFailure(500, "  Bad Gateway  ").message).toBe("Bad Gateway")
    expect(classifyInitFailure(500, "").message).toBeUndefined()
  })
})

describe("pinMatchesKey", () => {
  test("honours a legacy pin with no dedupe key (back-compat)", () => {
    expect(pinMatchesKey({ project_id: "p1" }, "repo:github.com/o/n")).toBe(true)
  })

  test("trusts a pin whose key matches the repo's computed key", () => {
    const key = "repo:github.com/o/n"
    expect(pinMatchesKey({ project_id: "p1", dedupe_key: key }, key)).toBe(true)
  })

  test("rejects a pin whose key belongs to a different repo identity", () => {
    const pin = { project_id: "p1", dedupe_key: "repo:github.com/o/OLD" }
    expect(pinMatchesKey(pin, "repo:github.com/o/NEW")).toBe(false)
  })

  test("rejects a local-folder pin that no longer matches the resolved key", () => {
    const pin = { project_id: "p1", dedupe_key: "local-folder:/old/path" }
    expect(pinMatchesKey(pin, "local-folder:/new/path")).toBe(false)
  })
})

describe("initProjectDetailed", () => {
  test("fails fast as unauthenticated with no managed session (no network)", async () => {
    // Test env is XDG-isolated (see test/preload.ts) so no session file exists.
    const result = await initProjectDetailed(process.cwd())
    expect(result.projectId).toBeNull()
    expect(result.failure?.kind).toBe("unauthenticated")
    expect(result.failure?.host).toBeTruthy()
  })

  test("reports a backend failure for an empty directory instead of throwing", async () => {
    const result = await initProjectDetailed("")
    expect(result.projectId).toBeNull()
    expect(result.failure?.kind).toBe("backend")
  })
})
