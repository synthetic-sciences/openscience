import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import {
  ComputeLaunch,
  ComputeList,
  ComputeListTool,
  ComputeRelease,
  ComputeReleaseTool,
  ComputeTools,
} from "../../src/tool/compute"
import { Global } from "../../src/global"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { Tool } from "../../src/tool/tool"

// Real HTTP throughout (AGENTS.md forbids mocks), same pattern Tasks 1/2 use:
// a Bun.serve fake Atlas speaking GET /leases and POST /leases/{id}/release,
// pointed at through the same `base` seam. Every fixture below is shaped from
// the verified route/repo source (atlas backend/app/routes/compute.py,
// backend/app/compute/lease_manager.py, backend/app/db/migrations.py's
// compute_leases table) — see the task-3 report for what was checked and how.

const SESSION = path.join(Global.Path.data, "openscience-session.json")

interface Plan {
  list?: () => Response | Promise<Response>
  release?: (id: string) => Response | Promise<Response>
}

interface Seen {
  lists: number
  releases: number
  releasedIds: string[]
}

function atlas(plan: Plan = {}) {
  const seen: Seen = { lists: 0, releases: 0, releasedIds: [] }
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/api/compute/leases") {
        seen.lists++
        return plan.list ? plan.list() : Response.json([])
      }
      const match = url.pathname.match(/^\/api\/compute\/leases\/([^/]+)\/release$/)
      if (req.method === "POST" && match) {
        seen.releases++
        const id = decodeURIComponent(match[1]!)
        seen.releasedIds.push(id)
        return plan.release ? plan.release(id) : Response.json({ status: "released", terminated: true })
      }
      return new Response("unexpected request", { status: 599 })
    },
  })
  return {
    seen,
    url: server.url.origin,
    [Symbol.dispose]: () => {
      server.stop(true)
    },
  }
}

function context(ask?: Tool.Context["ask"]): Tool.Context {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: ask ?? (async () => {}),
  }
}

function keypath(id: string) {
  return ComputeLaunch.keypath(id)
}

async function exists(file: string) {
  return Bun.file(file).exists()
}

beforeEach(async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(SESSION, JSON.stringify({ api_key: "thk_test.secret", user_id: "u1" }))
  await fs.rm(path.join(Global.Path.config, "compute"), { recursive: true, force: true })
})

afterEach(async () => {
  await fs.rm(SESSION, { force: true })
  await fs.rm(path.join(Global.Path.config, "compute"), { recursive: true, force: true })
})

describe("compute_list", () => {
  test("no leases is an empty, valid answer", async () => {
    using fake = atlas({ list: () => Response.json([]) })
    const result = await ComputeList.run(fake.url)
    expect(result.metadata.leases).toEqual([])
    expect(result.output.toLowerCase()).toContain("no unfinished lease")
  })

  test("several leases: only the unfinished ones (not released or failed) are reported", async () => {
    using fake = atlas({
      list: () =>
        Response.json([
          {
            lease_id: "lease_ready",
            provider: "runpod",
            requested_sku: "H100",
            status: "ready",
            ssh_host: "1.2.3.4",
            ssh_port: 22065,
            hourly_rate_cents: 699,
            total_spent_cents: 233,
            gpu_model: "H100-SXM",
            gpu_name: "NVIDIA H100 80GB HBM3",
            gpu_count: 1,
            price_cents_per_hour_display: 699,
          },
          {
            lease_id: "lease_provisioning",
            provider: "vast",
            requested_sku: "offer-42",
            status: "provisioning",
            ssh_host: null,
            ssh_port: null,
            hourly_rate_cents: 120,
            total_spent_cents: 0,
            gpu_model: null,
            gpu_name: null,
            gpu_count: null,
            price_cents_per_hour_display: 120,
          },
          {
            lease_id: "lease_done",
            provider: "runpod",
            requested_sku: "H100",
            status: "released",
            ssh_host: "5.6.7.8",
            ssh_port: 22,
            hourly_rate_cents: 699,
            total_spent_cents: 1500,
            gpu_model: "H100-SXM",
            gpu_name: "NVIDIA H100 80GB HBM3",
            gpu_count: 1,
            price_cents_per_hour_display: 699,
          },
          {
            lease_id: "lease_dead",
            provider: "lambda",
            requested_sku: "a100",
            status: "failed",
            ssh_host: null,
            ssh_port: null,
            hourly_rate_cents: 250,
            total_spent_cents: 0,
            gpu_model: "A100-80GB",
            gpu_name: "A100 80GB",
            gpu_count: 1,
            price_cents_per_hour_display: 250,
          },
        ]),
    })
    const result = await ComputeList.run(fake.url)
    const ids = result.metadata.leases.map((l) => l.lease_id)
    expect(ids).toEqual(["lease_ready", "lease_provisioning"])
    expect(ids).not.toContain("lease_done")
    expect(ids).not.toContain("lease_dead")
  })

  test("a nullable gpu_model and a not-yet-assigned ssh_host surface as null, not guessed", async () => {
    using fake = atlas({
      list: () =>
        Response.json([
          {
            lease_id: "lease_cpu",
            provider: "modal",
            requested_sku: null,
            status: "provisioning",
            ssh_host: null,
            ssh_port: null,
            hourly_rate_cents: 0,
            total_spent_cents: 0,
            gpu_model: null,
            gpu_name: null,
            gpu_count: null,
            price_cents_per_hour_display: 0,
          },
        ]),
    })
    const result = await ComputeList.run(fake.url)
    expect(result.metadata.leases[0]?.gpu_model).toBeNull()
    expect(result.metadata.leases[0]?.gpu_name).toBeNull()
    expect(result.metadata.leases[0]?.ssh_host).toBeNull()
    expect(result.metadata.leases[0]?.ssh_port).toBeNull()
  })

  test("reports the honest substitutes for a cap — never a per-lease budget field", async () => {
    // effective_budget_cents is computed by the LAUNCH route and attached
    // only to ITS OWN response; GET /leases (SELECT * over compute_leases)
    // has no such column. Inventing or guessing one here would be exactly
    // the fixture bug the task-2 brief flagged for Launched.
    using fake = atlas({
      list: () =>
        Response.json([
          {
            lease_id: "lease_ready",
            provider: "runpod",
            requested_sku: "H100",
            status: "ready",
            ssh_host: "1.2.3.4",
            ssh_port: 22065,
            hourly_rate_cents: 699,
            total_spent_cents: 233,
            gpu_model: "H100-SXM",
            gpu_name: "NVIDIA H100 80GB HBM3",
            gpu_count: 1,
            price_cents_per_hour_display: 699,
          },
        ]),
    })
    const result = await ComputeList.run(fake.url)
    expect(Object.keys(result.metadata.leases[0]!)).not.toContain("effective_budget_cents")
    expect(Object.keys(result.metadata.leases[0]!)).not.toContain("cap")
    // Rate and spend ARE on the row — the honest substitutes.
    expect(result.metadata.leases[0]?.hourly_rate_cents).toBe(699)
    expect(result.metadata.leases[0]?.total_spent_cents).toBe(233)
  })

  test("a failure (e.g. signed out) is surfaced, not thrown", async () => {
    await fs.rm(SESSION, { force: true })
    using fake = atlas()
    const result = await ComputeList.run(fake.url)
    expect(result.metadata.error).toBe("unauthenticated")
    expect(result.metadata.leases).toEqual([])
  })

  test("the registered tool takes no parameters", async () => {
    const tool = await ComputeListTool.init({})
    expect(ComputeListTool.id).toBe("compute_list")
    expect(tool.parameters.safeParse({}).success).toBe(true)
  })
})

describe("compute_release", () => {
  test("releasing a live lease reports success and that billing has stopped", async () => {
    using fake = atlas({ release: () => Response.json({ status: "released", terminated: true }) })
    const result = await ComputeRelease.run({ lease_id: "lease_abc123" }, fake.url)
    expect(result.metadata.outcome).toBe("released")
    expect(result.metadata.lease_id).toBe("lease_abc123")
    expect(result.output.toLowerCase()).toContain("billing has stopped")
    expect(fake.seen.releasedIds).toEqual(["lease_abc123"])
  })

  test("releasing a live lease discards its persisted key file", async () => {
    await fs.mkdir(path.join(Global.Path.config, "compute"), { recursive: true })
    await Bun.write(keypath("lease_abc123"), "secret-key-bytes")
    using fake = atlas({ release: () => Response.json({ status: "released", terminated: true }) })
    await ComputeRelease.run({ lease_id: "lease_abc123" }, fake.url)
    expect(await exists(keypath("lease_abc123"))).toBe(false)
  })

  test("releasing an already-released lease (409) discards its key file too", async () => {
    // A 409 means the lease is unambiguously terminal server-side, even
    // though this call did not learn that from a fresh 2xx — the same
    // reasoning ComputeLaunch.expired applies to its own already_released
    // ending. Leaving a stale key on disk here would be litter.
    await fs.mkdir(path.join(Global.Path.config, "compute"), { recursive: true })
    await Bun.write(keypath("lease_zzz"), "secret-key-bytes")
    using fake = atlas({
      release: () => Response.json({ detail: "Lease already released" }, { status: 409 }),
    })
    const result = await ComputeRelease.run({ lease_id: "lease_zzz" }, fake.url)
    expect(result.metadata.outcome).toBe("already_released")
    expect(result.metadata.lease_id).toBe("lease_zzz")
    expect(await exists(keypath("lease_zzz"))).toBe(false)
    expect(result.output.toLowerCase()).toContain("already")
  })

  test("a release whose teardown was unconfirmed surfaces the warning to the agent", async () => {
    // Shape verified against LeaseManager.release_lease: `release_state`
    // names why, and prose (when Atlas has any) is nested under
    // `provider_result.warning` — never a top-level `warning` field.
    using fake = atlas({
      release: () =>
        Response.json({
          status: "released",
          terminated: false,
          unconfirmed: true,
          release_state: "unconfirmed",
          provider_result: { status: "unknown", warning: "provider teardown returned 403" },
        }),
    })
    const result = await ComputeRelease.run({ lease_id: "lease_abc123" }, fake.url)
    expect(result.metadata.outcome).toBe("unconfirmed")
    expect(result.metadata.warning).toBe("provider teardown returned 403")
    expect(result.metadata.release_state).toBe("unconfirmed")
    expect(result.output).toContain("provider teardown returned 403")
    // Rendering an unconfirmed teardown as plain success is exactly the bug
    // the server side was fixed to stop doing — this must not claim it.
    expect(result.output.toLowerCase()).not.toContain("nothing is billing")
  })

  test("an unconfirmed teardown with no provider prose still surfaces, and keeps the key", async () => {
    await fs.mkdir(path.join(Global.Path.config, "compute"), { recursive: true })
    await Bun.write(keypath("lease_abc123"), "secret-key-bytes")
    using fake = atlas({
      release: () =>
        Response.json({
          status: "released",
          terminated: false,
          unconfirmed: true,
          release_state: "not_configured",
          provider_result: { status: "not_configured" },
        }),
    })
    const result = await ComputeRelease.run({ lease_id: "lease_abc123" }, fake.url)
    expect(result.metadata.outcome).toBe("unconfirmed")
    expect(result.metadata.release_state).toBe("not_configured")
    expect(result.metadata.warning).toBeTruthy()
    // Possibly still alive, so the key it needs stays on disk.
    expect(await exists(keypath("lease_abc123"))).toBe(true)
  })

  test("credential_unavailable is reported as not released at all", async () => {
    // The one release_state where `status` stays whatever it already was —
    // the provider was never even asked, so claiming "released" here would
    // be worse than an unconfirmed teardown: it would be a straightforward
    // lie about a box still fully live.
    using fake = atlas({
      release: () =>
        Response.json({
          lease_id: "lease_abc123",
          status: "ready",
          terminated: false,
          error: "credential_unavailable",
          release_state: "credential_unavailable",
          provider_result: {},
        }),
    })
    const result = await ComputeRelease.run({ lease_id: "lease_abc123" }, fake.url)
    expect(result.metadata.outcome).toBe("not_released")
    expect(result.metadata.status).toBe("ready")
    // Never claims the box is released or billing has stopped — it wasn't
    // touched at all.
    expect(result.output.toLowerCase()).not.toContain("billing has stopped")
    expect(result.output.toLowerCase()).not.toContain("the provider confirmed")
  })

  test("a failure other than conflict (e.g. signed out) is surfaced, not thrown", async () => {
    await fs.rm(SESSION, { force: true })
    using fake = atlas()
    const result = await ComputeRelease.run({ lease_id: "lease_abc123" }, fake.url)
    expect(result.metadata.outcome).toBe("refused")
    expect(result.metadata.error).toBe("unauthenticated")
  })

  test("requires no approval — ctx.ask is never called", async () => {
    const tool = await ComputeReleaseTool.init({})
    const asked: unknown[] = []
    const ctx = context(async (r) => void asked.push(r))
    // No fake Atlas is started; API_BASE is pinned to an unreachable address
    // by the suite's preload, so this proves the tool never even tries to
    // gate the call on an ask before hitting the network.
    await tool.execute({ lease_id: "lease_abc123" }, ctx)
    expect(asked.length).toBe(0)
  })

  test("the registered tool is named compute_release and requires a lease_id", async () => {
    const tool = await ComputeReleaseTool.init({})
    expect(ComputeReleaseTool.id).toBe("compute_release")
    expect(tool.parameters.safeParse({}).success).toBe(false)
    expect(tool.parameters.safeParse({ lease_id: "" }).success).toBe(false)
    expect(tool.parameters.safeParse({ lease_id: "lease_abc123" }).success).toBe(true)
  })
})

describe("the whole compute surface, registered", () => {
  test("ComputeTools is exactly four distinct tools, compute_launch the only money-spender", async () => {
    const ids = ComputeTools.map((t) => t.id)
    expect(ids).toEqual(["compute_status", "compute_launch", "compute_list", "compute_release"])
    expect(new Set(ids).size).toBe(4)
  })

  test("compute_status is unchanged by this registration", async () => {
    const tool = await ComputeTools.find((t) => t.id === "compute_status")!.init({})
    expect(tool.parameters.safeParse({}).success).toBe(true)
  })

  test("all four ids reach the tool registry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("compute_status")
        expect(ids).toContain("compute_launch")
        expect(ids).toContain("compute_list")
        expect(ids).toContain("compute_release")
      },
    })
  })
})
