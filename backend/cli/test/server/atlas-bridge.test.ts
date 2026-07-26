import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import {
  AtlasBridgeRoutes,
  classifyInitFailure,
  computeDedupeKey,
  initProjectDetailed,
  parseStageNodeInput,
  pinMatchesKey,
} from "../../src/server/routes/atlas-bridge"

const realFetch = globalThis.fetch
const sessionPath = path.join(Global.Path.data, "openscience-session.json")

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.unlink(sessionPath).catch(() => {})
})

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

describe("stage node bridge", () => {
  test("validates and trims the mutation payload", () => {
    expect(
      parseStageNodeInput({ title: "  result  ", directory: " /repo ", parent_id: " parent-1 " }),
    ).toEqual({ title: "result", directory: "/repo", parentID: "parent-1" })
    expect(() => parseStageNodeInput({ title: "x", directory: "/repo" })).toThrow("parent_id is required")
  })

  test("creates a staged child with repository context", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))

    let requestURL = ""
    let requestBody: any
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestURL = String(input)
      requestBody = JSON.parse(String(init?.body))
      return Response.json(
        {
          node_id: "staged-1",
          title: "result",
          lifecycle: "staged",
          parent_ids: ["parent-1"],
        },
        { status: 201 },
      )
    }) as typeof fetch

    const response = await AtlasBridgeRoutes().request("/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "result", directory: process.cwd(), parent_id: "parent-1" }),
    })

    expect(response.status).toBe(201)
    expect(requestURL).toEndWith("/api/nodes/stage-create")
    expect(requestBody.parent_ids).toEqual(["parent-1"])
    expect(requestBody.title).toBe("result")
    expect(requestBody.branch_name).toBeTruthy()
    expect(await response.json()).toMatchObject({
      node_id: "staged-1",
      lifecycle: "staged",
      parent_ids: ["parent-1"],
    })
  })

  test("propagates Atlas failures instead of fabricating a node id", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    globalThis.fetch = (async () =>
      Response.json({ detail: "database unavailable" }, { status: 503 })) as unknown as typeof fetch

    const response = await AtlasBridgeRoutes().request("/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "result", directory: process.cwd(), parent_id: "parent-1" }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: "database unavailable" })
  })

  test("rejects malformed mutations before calling Atlas", async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return Response.json({})
    }) as unknown as typeof fetch
    const response = await AtlasBridgeRoutes().request("/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "result", directory: process.cwd() }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "parent_id is required" })
    expect(called).toBe(false)
  })
})

describe("initProjectDetailed", () => {
  // The XDG data dir is isolated per-process, not per-test, so an earlier test
  // in the suite may leave a session file behind — that makes token() non-null
  // and defeats the no-session assertion below (it fails "unreachable" instead
  // of "unauthenticated"). Clear it first so this test is order-independent.
  beforeEach(async () => {
    await fs.unlink(sessionPath).catch(() => {})
  })

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
