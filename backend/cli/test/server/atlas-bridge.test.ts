import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import {
  AtlasBridgeRoutes,
  classifyInitFailure,
  computeDedupeKey,
  initProjectDetailed,
  mergeProjectRootsAndPin,
  parseStageNodeInput,
  pinMatchesKey,
} from "../../src/server/routes/atlas-bridge"
import { tmpdir } from "../fixture/fixture"

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

  test("402 with a legacy plan-coded payload is an account-access failure", () => {
    const body = JSON.stringify({
      detail: { code: "plan_quota_exhausted", message: "Monthly quota exhausted", upgrade_url: "/billing" },
    })
    const failure = classifyInitFailure(402, body)
    expect(failure.kind).toBe("access")
    expect(failure.message).toBeUndefined()
    expect(failure.status).toBe(402)
  })

  test("a legacy plan-worded 4xx is an account-access failure", () => {
    const failure = classifyInitFailure(400, JSON.stringify({ detail: "no active subscription" }))
    expect(failure.kind).toBe("access")
    expect(failure.message).toBeUndefined()
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

describe("project root merge", () => {
  test("uses the current merge endpoint and writes the pin only after success", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir()
    const requests: Array<{ path: string; body: unknown }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
      return Response.json({
        canonical_id: "project-a",
        absorbed: ["project-b"],
        reparented_edges: 2,
        deleted_nodes: 1,
      })
    }) as typeof fetch

    const result = await mergeProjectRootsAndPin(tmp.path, "repo:github.com/example/project", "project-a", [
      "project-b",
    ])

    expect(result).toMatchObject({ merge: { canonical_id: "project-a", deleted_nodes: 1 }, pinned: true })
    expect(requests).toEqual([
      {
        path: "/api/v1/projects/merge",
        body: { canonical_id: "project-a", duplicate_ids: ["project-b"] },
      },
    ])
    expect(JSON.parse(await fs.readFile(path.join(tmp.path, ".openscience/project.json"), "utf8"))).toMatchObject({
      project_id: "project-a",
      dedupe_key: "repo:github.com/example/project",
    })
  })

  test("falls back to the historical merge endpoint only when v1 is retired", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir()
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      requests.push(path)
      if (path === "/api/v1/projects/merge") return new Response("retired", { status: 404 })
      if (path === "/api/agent/projects/merge") {
        return Response.json({ canonical_id: "project-a", absorbed: ["project-b"], deleted_nodes: 1 })
      }
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch

    const result = await mergeProjectRootsAndPin(tmp.path, "local-folder:/project", "project-a", ["project-b"])

    expect(result.pinned).toBe(true)
    expect(requests).toEqual(["/api/v1/projects/merge", "/api/agent/projects/merge"])
  })

  test("does not fall back or write a pin for a real v1 merge failure", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir()
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      requests.push(path)
      return Response.json({ detail: "merge transaction failed" }, { status: 503 })
    }) as typeof fetch

    await expect(
      mergeProjectRootsAndPin(tmp.path, "local-folder:/project", "project-a", ["project-b"]),
    ).rejects.toThrow("HTTP 503")
    expect(requests).toEqual(["/api/v1/projects/merge"])
    expect(await fs.stat(path.join(tmp.path, ".openscience/project.json")).catch(() => null)).toBeNull()
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
    expect(parseStageNodeInput({ title: "  result  ", directory: " /repo ", parent_id: " parent-1 " })).toEqual({
      title: "result",
      directory: "/repo",
      parentID: "parent-1",
    })
    expect(() => parseStageNodeInput({ title: "x", directory: "/repo" })).toThrow("parent_id is required")
  })

  test("creates a staged child with repository context", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await $`git remote add origin https://github.com/synthetic-sciences/openscience.git`.cwd(tmp.path).quiet()
    const branch = (await $`git branch --show-current`.cwd(tmp.path).quiet().text()).trim()
    const head = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()

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
      body: JSON.stringify({ title: "result", directory: tmp.path, parent_id: "parent-1" }),
    })

    expect(response.status).toBe(201)
    expect(requestURL).toEndWith("/api/nodes/stage-create")
    expect(requestBody.parent_ids).toEqual(["parent-1"])
    expect(requestBody.title).toBe("result")
    expect(requestBody.repo_url).toBe("https://github.com/synthetic-sciences/openscience")
    expect(requestBody.branch_name).toBe(branch)
    expect(requestBody.head_commit_sha).toBe(head)
    expect(await response.json()).toMatchObject({
      node_id: "staged-1",
      lifecycle: "staged",
      parent_ids: ["parent-1"],
    })
  })

  test("drops an oversized repository-controlled remote instead of buffering it into the bridge request", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await fs.appendFile(
      path.join(tmp.path, ".git", "config"),
      `\n[remote "origin"]\n\turl = https://example.com/${"x".repeat(70 * 1024)}\n`,
    )

    const request = { body: {} as Record<string, unknown> }
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      request.body = JSON.parse(String(init?.body))
      return Response.json({ node_id: "staged-bounded", lifecycle: "staged" }, { status: 201 })
    }) as typeof fetch

    const response = await AtlasBridgeRoutes().request("/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "bounded context", directory: tmp.path, parent_id: "parent-1" }),
    })

    expect(response.status).toBe(201)
    expect(request.body.repo_url).toBeNull()
    expect(JSON.stringify(request.body).length).toBeLessThan(10_000)
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

describe("read bridge failures", () => {
  test("reports a missing Atlas session instead of impersonating an empty account", async () => {
    const response = await AtlasBridgeRoutes().request("/nodes")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Sign in to Synthetic Sciences to load the graph." })
  })

  test("propagates an Atlas backend failure instead of impersonating an empty account", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    globalThis.fetch = (async () =>
      Response.json({ detail: "database unavailable" }, { status: 503 })) as unknown as typeof fetch

    const response = await AtlasBridgeRoutes().request("/graphs")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: "database unavailable" })
  })

  test("project resolution propagates an Atlas outage instead of reporting an unlinked folder", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    globalThis.fetch = (async () =>
      Response.json({ detail: "project service unavailable" }, { status: 503 })) as unknown as typeof fetch

    const directory = `/tmp/openscience-atlas-project-route-${process.pid}`
    const response = await AtlasBridgeRoutes().request(`/project?directory=${encodeURIComponent(directory)}`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: "project service unavailable" })
  })

  test("returns 404 for an unknown bridge route", async () => {
    const response = await AtlasBridgeRoutes().request("/not-a-real-route")

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Synthetic Sciences bridge route not found" })
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

  test("dedupes two fresh clones through the current projects endpoint", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    for (const directory of [first.path, second.path]) {
      await $`git remote add origin https://github.com/synthetic-sciences/openscience.git`.cwd(directory).quiet()
    }
    let created = false
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`)
      if (url.pathname !== "/api/v1/projects") return new Response("unexpected", { status: 500 })
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ projects: created ? [{ project_id: "project-shared" }] : [] })
      }
      created = true
      return Response.json({ project_id: "project-shared", deduped: false }, { status: 201 })
    }) as typeof fetch

    expect(await initProjectDetailed(first.path)).toEqual({ projectId: "project-shared" })
    expect(await initProjectDetailed(second.path)).toEqual({ projectId: "project-shared" })
    expect(requests.filter((request) => request === "POST /api/v1/projects")).toHaveLength(1)
    expect(requests.some((request) => request.includes("/api/agent/projects"))).toBe(false)
    expect(requests.some((request) => request.includes("/api/v1/nodes/commit-new"))).toBe(false)
  })

  test("recovers a created project after its first response is lost without generic node fallback", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await $`git remote add origin https://github.com/synthetic-sciences/response-loss.git`.cwd(tmp.path).quiet()
    let created = false
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      requests.push(`${method} ${url.pathname}`)
      if (url.pathname !== "/api/v1/projects") return new Response("unexpected", { status: 500 })
      if (method === "GET") return Response.json({ projects: created ? [{ project_id: "project-recovered" }] : [] })
      created = true
      throw new TypeError("connection reset after commit")
    }) as typeof fetch

    const lost = await initProjectDetailed(tmp.path)
    expect(lost).toMatchObject({ projectId: null, failure: { kind: "unreachable" } })
    expect(await initProjectDetailed(tmp.path)).toEqual({ projectId: "project-recovered" })
    expect(requests.filter((request) => request === "POST /api/v1/projects")).toHaveLength(1)
    expect(requests.some((request) => request.includes("/api/v1/nodes/commit-new"))).toBe(false)
  })

  test("falls back to the legacy projects endpoint only when v1 is retired", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      requests.push(`${method} ${url.pathname}`)
      if (url.pathname === "/api/v1/projects") return new Response("retired", { status: 404 })
      if (url.pathname === "/api/agent/projects" && method === "GET") return Response.json({ projects: [] })
      if (url.pathname === "/api/agent/projects" && method === "POST") {
        return Response.json({ project_id: "project-legacy" }, { status: 201 })
      }
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch

    expect(await initProjectDetailed(tmp.path)).toEqual({ projectId: "project-legacy" })
    expect(requests).toEqual([
      "GET /api/v1/projects",
      "GET /api/agent/projects",
      "POST /api/v1/projects",
      "POST /api/agent/projects",
    ])
  })

  test("does not create a generic root when the project service fails", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`)
      if ((init?.method ?? "GET") === "GET") return Response.json({ projects: [] })
      return Response.json({ detail: "project service unavailable" }, { status: 503 })
    }) as typeof fetch

    const result = await initProjectDetailed(tmp.path)
    expect(result).toMatchObject({ projectId: null, failure: { kind: "unreachable", status: 503 } })
    expect(requests).toEqual(["GET /api/v1/projects", "POST /api/v1/projects"])
  })
})

describe("project init route", () => {
  test("returns an authenticated HTTP error with actionable detail instead of a 200 null", async () => {
    const directory = `/tmp/openscience-atlas-init-route-${process.pid}`
    const response = await AtlasBridgeRoutes().request(`/project/init?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      project_id: null,
      error: "unauthenticated",
      detail: "Sign in to Synthetic Sciences before initializing the project graph.",
    })
  })

  test("replaces a legacy plan error with neutral account-access guidance", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    globalThis.fetch = (async () =>
      Response.json(
        { detail: { code: "plan_quota_exhausted", message: "monthly quota exhausted" } },
        { status: 402 },
      )) as unknown as typeof fetch

    const directory = `/tmp/openscience-atlas-init-plan-${process.pid}`
    const response = await AtlasBridgeRoutes().request(`/project/init?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
    })

    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({
      project_id: null,
      error: "access",
      detail: "This account does not currently have access to initialize the project graph.",
    })
  })
})
