import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Lease } from "../../src/compute/lease"
import { Global } from "../../src/global"

// Real HTTP, no `fetch` stubbing (AGENTS.md forbids mocks): every test below
// stands up a Bun.serve instance on an OS-assigned port and points the client
// at it via the `base` override, which defaults to API_BASE in production and
// exists so this module is testable without either a root-owned port or a
// module-load-order-fragile env override (see lease.ts's header comment).

const SESSION = path.join(Global.Path.data, "openscience-session.json")

async function signIn() {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(SESSION, JSON.stringify({ api_key: "thk_test.secret", user_id: "u1" }))
}

async function signOut() {
  await fs.rm(SESSION, { force: true })
}

beforeEach(signIn)
afterEach(signOut)

const SPEC = { gpu: "H100-SXM", count: 1, budget_cents: 3000 }

const GOOD_LAUNCH = {
  lease_id: "lease_abc123",
  provider: "vast",
  requested_sku: "vast:offer-9981",
  status: "provisioning",
  funding: "managed",
  gpu_model: "H100-SXM",
  gpu_name: "NVIDIA H100 SXM",
  gpu_count: 1,
  hourly_rate_cents: 194,
  // An INTEGER, not a formatted string. `_redact_lease` assigns
  // `credits_service.to_display_cents(rate)`, which is `int(raw_cents)`
  // (atlas backend/app/billing/credits_service.py:14), and
  // docs/specs/compute-design.md:231 says the same ("0 when that provider
  // resolves to BYOK"). The original "$1.94" here was invented, and the
  // z.string() it justified rejected every genuine 201 as malformed.
  price_cents_per_hour_display: 194,
  effective_budget_cents: 3000,
  provisioning_timeout_seconds: 600,
  ssh_user: "root",
  ssh_port: 22,
  ssh_host: null,
  ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
}

describe("Lease.launch", () => {
  test("a good 201 becomes a launch, with the one-time key intact", async () => {
    using server = Bun.serve({ port: 0, fetch: () => Response.json(GOOD_LAUNCH, { status: 201 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.lease_id).toBe("lease_abc123")
    expect(result.value.ssh_private_key).toBe(GOOD_LAUNCH.ssh_private_key)
    expect(result.value.ssh_host).toBeNull()
    expect(result.value.provisioning_timeout_seconds).toBe(600)
    expect(result.value.price_cents_per_hour_display).toBe(194)
  })

  test("a gpu_model Atlas could not place is null, not a reason to lose the lease", async () => {
    // `gpu_models.canonical()` returns None for a display name it cannot map,
    // deliberately ("honest-unknown, never a guessed model"), and the launch
    // route passes that straight through to `create_lease(gpu_model=...)`.
    // A running, billing box must not be thrown away over a taxonomy miss.
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ...GOOD_LAUNCH, gpu_model: null }, { status: 201 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.gpu_model).toBeNull()
    expect(result.value.ssh_private_key).toBe(GOOD_LAUNCH.ssh_private_key)
  })

  test("a byok lease's null effective_budget_cents is a lease, not a malformed response", async () => {
    // `effective_budget_cents` is None whenever the charge rate is 0 — i.e.
    // every BYOK-funded lease (atlas routes/compute.py:963-966), which the
    // resolver can pick whenever the user has their own provider key. There
    // is nothing for Atlas to cap there, and no budget is not a bad response.
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ...GOOD_LAUNCH, funding: "byok", effective_budget_cents: null }, { status: 201 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.effective_budget_cents).toBeNull()
  })

  test("sends an authenticated POST with the request body, never a query string of secrets", async () => {
    let seen: { method: string; path: string; auth: string | null; body: unknown } | undefined
    using server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen = {
          method: req.method,
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body: await req.json(),
        }
        return Response.json(GOOD_LAUNCH, { status: 201 })
      },
    })
    await Lease.launch({ gpu: "H100-SXM", count: 2, budget_cents: 1500 }, server.url.origin)
    expect(seen?.method).toBe("POST")
    expect(seen?.path).toBe("/api/compute/leases")
    expect(seen?.auth).toBe("Bearer thk_test.secret")
    expect(seen?.body).toEqual({ gpu: "H100-SXM", count: 2, budget_cents: 1500 })
  })

  test("a 201 missing ssh_private_key is not a launch", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ...GOOD_LAUNCH, ssh_private_key: undefined }, { status: 201 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("malformed")
    expect(result.error.message).toInclude("ssh_private_key")
  })

  test("a 201 whose body is not JSON is not a launch", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("not json", { status: 201 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("malformed")
  })

  test("insufficient_cli_credit carries affordable_budget_cents", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "insufficient_cli_credit", affordable_budget_cents: 450 }, { status: 402 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("insufficient_credit")
    if (result.error.kind !== "insufficient_credit") throw new Error("expected insufficient_credit")
    expect(result.error.affordable_budget_cents).toBe(450)
  })

  test("budget_below_hourly_rate carries affordable_budget_cents and is distinct from insufficient_cli_credit", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "budget_below_hourly_rate", affordable_budget_cents: 900 }, { status: 402 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("budget_too_low")
    if (result.error.kind !== "budget_too_low") throw new Error("expected budget_too_low")
    expect(result.error.affordable_budget_cents).toBe(900)
  })

  test("a 429 rate limiter means wait and retry", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { detail: "Rate limit exceeded, try again shortly." },
          { status: 429, headers: { "retry-after": "3" } },
        ),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("rate_limited")
    if (result.error.kind !== "rate_limited") throw new Error("expected rate_limited")
    expect(result.error.retry_after_seconds).toBe(3)
  })

  test("a 429 concurrency cap means stop, never retry", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail: "Managed GPU concurrency cap reached (2/2)." }, { status: 429 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("concurrency_capped")
  })

  test("an unrecognised 429 defaults to the cap, the safer of the two outcomes", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail: "Something changed upstream." }, { status: 429 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("concurrency_capped")
  })

  test("a 429 with an unparseable body also defaults to the cap", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 429 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("concurrency_capped")
  })

  test("VERIFIED (source): a 402 whose detail is nested — the real Atlas shape — still classifies correctly", async () => {
    // Verified against `_payment_required` (~/codes/InkVell/atlas
    // backend/app/routes/compute.py): every field lives under
    // `HTTPException(status_code=402, detail={"error": ..., "message": ...})`,
    // nested exactly like the 400/503 shapes below — not at the top level,
    // which is what the two 402 tests above (predating this discovery) use.
    // `classify` now unwraps `detail` generically rather than only for the
    // two new kinds, so this nested shape has to work too.
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            detail: {
              error: "insufficient_cli_credit",
              needed_cents: 699,
              available_cents: 120,
              affordable_budget_cents: 120,
              actions: ["byok", "topup"],
              message: "Not enough wallet credit to provision this compute (6.99 USD/hr needed).",
            },
          },
          { status: 402 },
        ),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("insufficient_credit")
    if (result.error.kind !== "insufficient_credit") throw new Error("expected insufficient_credit")
    expect(result.error.affordable_budget_cents).toBe(120)
    expect(result.error.message).toBe("Not enough wallet credit to provision this compute (6.99 USD/hr needed).")
  })

  test("a non-JSON error body still surfaces a typed failure carrying the HTTP status", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("internal error", { status: 500 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("unexpected")
    if (result.error.kind !== "unexpected") throw new Error("expected unexpected")
    expect(result.error.status).toBe(500)
  })

  test("a connection that fails outright is reported, not thrown", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const url = server.url.origin
    server.stop(true)
    const result = await Lease.launch(SPEC, url)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("network")
  })

  test("no session is unauthenticated and never touches the network", async () => {
    await signOut()
    let count = 0
    using server = Bun.serve({
      port: 0,
      fetch: () => {
        count++
        return Response.json(GOOD_LAUNCH, { status: 201 })
      },
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("unauthenticated")
    expect(count).toBe(0)
  })
})

describe("Lease.launch: no_matching_offer (400) and no_capacity (503)", () => {
  // Atlas answers both with FastAPI's `HTTPException(detail={...})`, which
  // ALWAYS serialises as `{"detail": {...}}` regardless of what `detail` is
  // — confirmed by reading `_no_offer` in ~/codes/InkVell/atlas
  // backend/app/routes/compute.py. The live 503 body below is captured
  // verbatim from a real `compute_launch` against real Atlas + RunPod; the
  // rest are constructed from the same function's source, not imagined —
  // each comment below says which.

  test("VERBATIM: the live 503 no_capacity body captured against real Atlas + RunPod", async () => {
    const LIVE_503 = {
      detail: {
        error: "no_capacity",
        gpu: "RTX-3090",
        count: 1,
        max_hourly_cents: null,
        attempted: [
          {
            provider: "runpod",
            sku: "NVIDIA GeForce RTX 3090",
            reason:
              "create pod: This machine does not have the resources to deploy your pod. Please try a different machine",
          },
        ],
        rate_limited: [],
        retry_after_s: null,
        message:
          "Tried 1 offer(s) for 1x RTX-3090 and every one refused to launch. GPU capacity moves by the second -- try again shortly, or name a different GPU.",
      },
    }
    using server = Bun.serve({ port: 0, fetch: () => Response.json(LIVE_503, { status: 503 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("no_capacity")
    if (result.error.kind !== "no_capacity") throw new Error("expected no_capacity")
    expect(result.error.gpu).toBe("RTX-3090")
    expect(result.error.count).toBe(1)
    expect(result.error.max_hourly_cents).toBeNull()
    expect(result.error.attempted).toEqual([
      {
        provider: "runpod",
        sku: "NVIDIA GeForce RTX 3090",
        reason:
          "create pod: This machine does not have the resources to deploy your pod. Please try a different machine",
      },
    ])
    expect(result.error.rate_limited).toEqual([])
    expect(result.error.retry_after_seconds).toBeUndefined()
    expect(result.error.message).toBe(LIVE_503.detail.message)
  })

  test("VERIFIED (source): a 400 no_matching_offer always has an empty attempted list", async () => {
    // `_no_offer`'s `if not tried:` branch returns 400 with `attempted: []`
    // unconditionally — nothing in the catalog matched, so nothing was ever
    // asked to launch. This is what distinguishes it from no_capacity below.
    const BODY = {
      detail: {
        error: "no_matching_offer",
        gpu: "H100-SXM",
        count: 8,
        max_hourly_cents: 50,
        attempted: [],
        rate_limited: [],
        retry_after_s: null,
        message:
          "No listed offer matches 8x H100-SXM under 50c/hr. See /api/compute/options for what is available right now.",
      },
    }
    using server = Bun.serve({ port: 0, fetch: () => Response.json(BODY, { status: 400 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("no_matching_offer")
    if (result.error.kind !== "no_matching_offer") throw new Error("expected no_matching_offer")
    expect(result.error.attempted).toEqual([])
    expect(result.error.max_hourly_cents).toBe(50)
    expect(result.error.message).toContain("No listed offer matches")
  })

  test("VERIFIED (source): rate_limited providers and a measured retry_after_s survive onto a no_capacity refusal", async () => {
    // Verified against `_no_offer`'s `rate_limited` parameter and
    // `_launch_requirement`'s collection of it: a provider whose CATALOG
    // FETCH was throttled is named separately from `attempted` (which only
    // ever holds candidates actually asked to launch), and `retry_after_s`
    // is `max()` over the waits it published — a measured number from the
    // provider, never invented client-side.
    const BODY = {
      detail: {
        error: "no_capacity",
        gpu: "A100-80GB",
        count: 2,
        max_hourly_cents: null,
        attempted: [{ provider: "runpod", sku: "NVIDIA A100 80GB", reason: "out of stock" }],
        rate_limited: ["vast"],
        retry_after_s: 12.5,
        message:
          "Tried 1 offer(s) for 2x A100-80GB and every one refused to launch. GPU capacity moves by the second -- try again shortly, or name a different GPU. vast did not answer in time (rate-limited, not out of offers) -- try again in about 12.5s.",
      },
    }
    using server = Bun.serve({ port: 0, fetch: () => Response.json(BODY, { status: 503 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("no_capacity")
    if (result.error.kind !== "no_capacity") throw new Error("expected no_capacity")
    expect(result.error.rate_limited).toEqual(["vast"])
    expect(result.error.retry_after_seconds).toBe(12.5)
    expect(result.error.attempted.length).toBe(1)
  })

  test("an unrecognised 400 body (detail.error matches neither known code) is unexpected, not guessed at", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail: { error: "something_else_entirely" } }, { status: 400 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("unexpected")
  })

  test("a 503 whose detail is a plain string (not the no_capacity shape) is unexpected, not thrown or guessed at", async () => {
    // Defensive: server prose and shapes can change. A 503 that is not this
    // documented shape must still produce a sensible message.
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail: "Service temporarily overloaded." }, { status: 503 }),
    })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("unexpected")
    if (result.error.kind !== "unexpected") throw new Error("expected unexpected")
    expect(result.error.message).toBe("Service temporarily overloaded.")
    expect(result.error.status).toBe(503)
  })

  test("a 503 with an unparseable body is unexpected, never throws", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("gateway timeout", { status: 503 }) })
    const result = await Lease.launch(SPEC, server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("unexpected")
  })
})

describe("Lease.connection", () => {
  test("a ready connection reports the normalised state and real coordinates", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        expect(new URL(req.url).pathname).toBe("/api/compute/leases/lease_abc123/connection")
        return Response.json({ state: "ready", status: "running", ssh_host: "1.2.3.4", ssh_port: 22065 })
      },
    })
    const result = await Lease.connection("lease_abc123", server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.state).toBe("ready")
    expect(result.value.ssh_host).toBe("1.2.3.4")
    expect(result.value.ssh_port).toBe(22065)
  })

  test("an unmapped provider status still normalises through state, never through status", async () => {
    using server = Bun.serve({
      port: 0,
      // Lambda passes its raw upstream string through unmapped on `status`;
      // `state` is what a poller must read.
      fetch: () =>
        Response.json({ state: "provisioning", status: "booting-lambda-specific", ssh_host: null, ssh_port: 22 }),
    })
    const result = await Lease.connection("lease_abc123", server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.state).toBe("provisioning")
  })

  test("a connection body missing the coordinates a poller needs is malformed, not ready", async () => {
    using server = Bun.serve({ port: 0, fetch: () => Response.json({ state: "ready" }) })
    const result = await Lease.connection("lease_abc123", server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("malformed")
  })
})

describe("Lease.list", () => {
  test("a valid list of leases parses", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        expect(new URL(req.url).pathname).toBe("/api/compute/leases")
        expect(req.method).toBe("GET")
        return Response.json([
          {
            lease_id: "a",
            provider: "vast",
            requested_sku: "s",
            status: "ready",
            ssh_host: "1.2.3.4",
            ssh_port: 22,
            hourly_rate_cents: 194,
            effective_budget_cents: 3000,
          },
        ])
      },
    })
    const result = await Lease.list(server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.length).toBe(1)
    expect(result.value[0]?.lease_id).toBe("a")
  })

  test("the rows Atlas actually sends parse — no cap field, and null columns", async () => {
    // `GET /leases` is `SELECT *` over compute_leases plus a display price.
    // There is no `effective_budget_cents` COLUMN — the launch route computes
    // that one and attaches it to its own response — and `requested_sku` /
    // `ssh_host` / `ssh_port` are nullable columns that are genuinely null on
    // the CPU-sandbox and agent-spawn rows this same endpoint returns.
    // Requiring any of them made every real list response malformed.
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json([
          {
            lease_id: "lease_gpu",
            user_id: "u1",
            provider: "vast",
            status: "ready",
            requested_sku: "offer-9981",
            region: "us-east",
            hourly_rate_cents: 194,
            total_spent_cents: 388,
            ssh_host: "1.2.3.4",
            ssh_port: 22065,
            ssh_user: "root",
            category: "gpu",
            funding: "managed",
            price_cents_per_hour_display: 194,
          },
          {
            lease_id: "lease_cpu",
            user_id: "u1",
            provider: "modal",
            status: "provisioning",
            requested_sku: null,
            hourly_rate_cents: 0,
            total_spent_cents: 0,
            ssh_host: null,
            ssh_port: null,
            category: "cpu",
            funding: "byok",
            price_cents_per_hour_display: 0,
          },
        ]),
    })
    const result = await Lease.list(server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.length).toBe(2)
    expect(result.value[1]?.ssh_port).toBeNull()
    expect(result.value[1]?.requested_sku).toBeNull()
    expect(result.value[0]?.hourly_rate_cents).toBe(194)
  })

  test("an empty list is a valid, empty answer", async () => {
    using server = Bun.serve({ port: 0, fetch: () => Response.json([]) })
    const result = await Lease.list(server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value).toEqual([])
  })

  test("a non-array list body is malformed, not silently empty", async () => {
    using server = Bun.serve({ port: 0, fetch: () => Response.json({ leases: [] }) })
    const result = await Lease.list(server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("malformed")
  })
})

describe("Lease.release", () => {
  test("a clean release reports no warning", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        expect(new URL(req.url).pathname).toBe("/api/compute/leases/lease_abc123/release")
        expect(req.method).toBe("POST")
        return Response.json({ status: "released" })
      },
    })
    const result = await Lease.release("lease_abc123", server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.warning).toBeUndefined()
  })

  test("an unconfirmed teardown surfaces its warning rather than reporting a clean release", async () => {
    // The real shape, verified against LeaseManager.release_lease (atlas
    // backend/app/compute/lease_manager.py): there is no top-level `warning`
    // — `release_state` names why, and prose (when Atlas has any) is nested
    // under `provider_result.warning`.
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          status: "released",
          terminated: false,
          unconfirmed: true,
          release_state: "unconfirmed",
          actual_cents: 120,
          provider_result: { status: "unknown", warning: "provider teardown returned 403" },
        }),
    })
    const result = await Lease.release("lease_abc123", server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.warning).toBe("provider teardown returned 403")
    expect(result.value.release_state).toBe("unconfirmed")
  })

  test("a release_state with no provider prose still surfaces as unconfirmed", async () => {
    // `not_configured` and `provider_unavailable` never call the provider at
    // all, so `provider_result` carries no `warning` — but the teardown is
    // exactly as unconfirmed as the transport-failure case above, and a
    // client that only checked for `warning` would miss it.
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          status: "released",
          terminated: false,
          unconfirmed: true,
          release_state: "not_configured",
          actual_cents: 0,
          provider_result: { status: "not_configured" },
        }),
    })
    const result = await Lease.release("lease_abc123", server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.release_state).toBe("not_configured")
    expect(result.value.warning).toBeUndefined()
  })

  test("credential_unavailable leaves the lease at its prior status, not released", async () => {
    // The one release_state where `status` on this same object is NOT
    // "released" — the row was left exactly as it was, because the
    // credential that owns the box could not be loaded and the provider was
    // never asked at all.
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          lease_id: "lease_abc123",
          status: "ready",
          terminated: false,
          error: "credential_unavailable",
          release_state: "credential_unavailable",
          actual_cents: null,
          provider_result: {},
        }),
    })
    const result = await Lease.release("lease_abc123", server.url.origin)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.status).toBe("ready")
    expect(result.value.release_state).toBe("credential_unavailable")
  })

  test("409 on an already-released lease surfaces as a conflict, not thrown", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail: "Lease already released." }, { status: 409 }),
    })
    const result = await Lease.release("lease_zzz", server.url.origin)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.kind).toBe("conflict")
  })
})
