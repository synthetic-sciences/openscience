import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { ComputeLaunch, ComputeLaunchTool } from "../../src/tool/compute"
import { Global } from "../../src/global"
import type { Tool } from "../../src/tool/tool"

// Real HTTP throughout (AGENTS.md forbids mocks): every test stands up a Bun
// server that speaks the three Atlas endpoints this tool touches, and points
// the client at it through the same `base` seam Task 1 documented. Nothing
// here stubs `fetch`, and nothing stubs the clock — the poll really sleeps,
// just on a schedule compressed from seconds to milliseconds. The arithmetic
// under test (an interval, a growth factor, a ceiling, and a bound taken from
// the launch response) is identical either way.

const SESSION = path.join(Global.Path.data, "openscience-session.json")
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n"

const LAUNCH = {
  lease_id: "lease_abc123",
  provider: "runpod",
  requested_sku: "NVIDIA H100 80GB HBM3",
  status: "provisioning",
  funding: "managed",
  gpu_model: "H100-SXM",
  gpu_name: "NVIDIA H100 80GB HBM3",
  gpu_count: 1,
  hourly_rate_cents: 699,
  // Integer cents — this is what `_redact_lease` actually sends.
  price_cents_per_hour_display: 699,
  effective_budget_cents: 3000,
  // Overridden per test; the tool must read the bound from HERE and nowhere
  // else, so every timing test states its own.
  provisioning_timeout_seconds: 600,
  ssh_user: "root",
  ssh_port: 22,
  // Null at launch, always. The SSH coordinates only exist on /connection.
  ssh_host: null,
  ssh_private_key: KEY,
}

/** A RunPod-shaped ready connection: the real host, and the high NATed port
 *  that makes `-p` mandatory rather than decorative. */
const READY = { state: "ready", status: "running", ssh_host: "1.2.3.4", ssh_port: 22065 }
const PROVISIONING = { state: "provisioning", status: "provisioning", ssh_host: null, ssh_port: 22 }

const SPEC = { gpu: "H100-SXM", count: 1, budget_cents: 3000 }

/** Production is 5s/1.25×/30s; these keep the suite honest about the shape of
 *  the schedule while running in milliseconds. */
const FAST = { first: 5, factor: 1.5, max: 20 }

interface Plan {
  launch?: () => Response | Promise<Response>
  poll?: (n: number) => Response | Promise<Response>
  release?: () => Response | Promise<Response>
  timeout?: number
}

interface Seen {
  launches: number
  polls: number
  releases: number
  bodies: unknown[]
  at: number[]
  keyBeforeFirstPoll?: boolean
}

function keypath(id = LAUNCH.lease_id) {
  return path.join(Global.Path.config, "compute", `${id}.pem`)
}

async function exists(file: string) {
  return Bun.file(file).exists()
}

/** A fake Atlas speaking POST /leases, GET /leases/{id}/connection and
 *  POST /leases/{id}/release, recording enough to assert on ordering, call
 *  counts and poll spacing. */
function atlas(plan: Plan = {}) {
  const seen: Seen = { launches: 0, polls: 0, releases: 0, bodies: [], at: [] }
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/api/compute/leases") {
        seen.launches++
        seen.bodies.push(await req.json())
        if (plan.launch) return plan.launch()
        return Response.json({ ...LAUNCH, provisioning_timeout_seconds: plan.timeout ?? 600 }, { status: 201 })
      }
      if (url.pathname.endsWith("/connection")) {
        seen.polls++
        seen.at.push(Date.now())
        // The key must already be on disk the first time we are asked for
        // coordinates: a crash mid-poll must not strand a billing box whose
        // key was never saved.
        if (seen.keyBeforeFirstPoll === undefined) seen.keyBeforeFirstPoll = await exists(keypath())
        return plan.poll ? plan.poll(seen.polls) : Response.json(PROVISIONING)
      }
      if (url.pathname.endsWith("/release")) {
        seen.releases++
        return plan.release ? plan.release() : Response.json({ status: "released", terminated: true })
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

beforeEach(async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(SESSION, JSON.stringify({ api_key: "thk_test.secret", user_id: "u1" }))
  await fs.rm(path.join(Global.Path.config, "compute"), { recursive: true, force: true })
})

afterEach(async () => {
  await fs.rm(SESSION, { force: true })
  await fs.rm(path.join(Global.Path.config, "compute"), { recursive: true, force: true })
})

describe("compute_launch: the key file", () => {
  test("the one-time key is on disk, 0600, under the config dir, before the first poll", async () => {
    using fake = atlas({ poll: (n) => Response.json(n === 1 ? PROVISIONING : READY) })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("ready")
    expect(result.metadata.key_path).toBe(keypath())
    expect(await Bun.file(keypath()).text()).toBe(KEY)
    // `ssh` refuses a group-readable key outright, so the mode is functional,
    // not decorative.
    expect((await fs.stat(keypath())).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.join(Global.Path.config, "compute"))).mode & 0o777).toBe(0o700)
    expect(fake.seen.keyBeforeFirstPoll).toBe(true)
  })

  test("a stale loose-permission key is re-tightened, not left readable", async () => {
    // writeFile's `mode` is ignored when the file already exists, so without
    // an explicit chmod a re-fetch over an old 0644 .pem stays 0644 and ssh
    // refuses it.
    await fs.mkdir(path.join(Global.Path.config, "compute"), { recursive: true })
    await fs.writeFile(keypath(), "stale", { mode: 0o644 })
    await fs.chmod(keypath(), 0o644)

    using fake = atlas({ poll: () => Response.json(READY) })
    await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(await Bun.file(keypath()).text()).toBe(KEY)
    expect((await fs.stat(keypath())).mode & 0o777).toBe(0o600)
  })

  test("a lease id that would climb out of the directory cannot", async () => {
    // Atlas mints `lease_<hex>`, but a lease id becomes a filename here and a
    // path join is not where you want to discover that changed.
    using fake = atlas({
      launch: () => Response.json({ ...LAUNCH, lease_id: "../../escape" }, { status: 201 }),
      poll: () => Response.json(READY),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    const dir = path.join(Global.Path.config, "compute")
    expect(path.dirname(result.metadata.key_path!)).toBe(dir)
    expect(await exists(path.join(Global.Path.config, "escape.pem"))).toBe(false)
    await fs.rm(result.metadata.key_path!, { force: true })
  })

  test("the key path is derived from the lease id, so several leases coexist", async () => {
    using fake = atlas({
      launch: () => Response.json({ ...LAUNCH, lease_id: "lease_second" }, { status: 201 }),
      poll: () => Response.json(READY),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.key_path).toBe(keypath("lease_second"))
    expect(await exists(keypath("lease_second"))).toBe(true)
    await fs.rm(keypath("lease_second"), { force: true })
  })
})

describe("compute_launch: refusals are never retried", () => {
  test("insufficient credit surfaces the affordable budget and stops", async () => {
    using fake = atlas({
      launch: () =>
        Response.json(
          {
            error: "insufficient_cli_credit",
            affordable_budget_cents: 450,
            detail: "Not enough wallet credit to provision this compute (6.99 USD/hr needed).",
          },
          { status: 402 },
        ),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("refused")
    expect(result.metadata.error).toBe("insufficient_credit")
    expect(result.metadata.affordable_budget_cents).toBe(450)
    expect(result.output).toContain("450")
    // Exactly one launch, ever. A truncated training run is not a cheaper
    // result, it is a discarded one.
    expect(fake.seen.launches).toBe(1)
    expect(fake.seen.bodies).toEqual([SPEC])
  })

  test("a budget below the hourly rate is a distinct refusal, also final", async () => {
    using fake = atlas({
      launch: () =>
        Response.json({ error: "budget_below_hourly_rate", affordable_budget_cents: 1500 }, { status: 402 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.error).toBe("budget_too_low")
    expect(result.metadata.affordable_budget_cents).toBe(1500)
    expect(fake.seen.launches).toBe(1)
  })

  test("a refused launch writes no key file and reports no lease", async () => {
    using fake = atlas({
      launch: () => Response.json({ error: "insufficient_cli_credit", affordable_budget_cents: 0 }, { status: 402 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.lease_id).toBeUndefined()
    expect(result.metadata.key_path).toBeUndefined()
    expect(await exists(keypath())).toBe(false)
    expect(fake.seen.polls).toBe(0)
  })

  test("the concurrency cap is surfaced, never retried", async () => {
    using fake = atlas({
      launch: () => Response.json({ detail: "Managed GPU concurrency cap reached (2/2)." }, { status: 429 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("refused")
    expect(result.metadata.error).toBe("concurrency_capped")
    expect(fake.seen.launches).toBe(1)
    // Retrying can never beat the cap; releasing something can.
    expect(result.output).toContain("compute_release")
    expect(result.output.toLowerCase()).not.toContain("try again")
  })

  test("the rate limiter says wait, and still does not retry inside the tool", async () => {
    using fake = atlas({
      launch: () => Response.json({ detail: "Rate limit exceeded." }, { status: 429, headers: { "retry-after": "7" } }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.error).toBe("rate_limited")
    expect(fake.seen.launches).toBe(1)
    expect(result.output).toContain("7")
  })

  test("a malformed 201 writes no key and reports no lease", async () => {
    using fake = atlas({
      launch: () => Response.json({ ...LAUNCH, ssh_private_key: undefined }, { status: 201 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.outcome).toBe("refused")
    expect(result.metadata.error).toBe("malformed")
    expect(await exists(keypath())).toBe(false)
    expect(fake.seen.polls).toBe(0)
  })
})

describe("compute_launch: structured launch refusals (400/503) surface what Atlas tried", () => {
  test("VERBATIM: a live no_capacity 503 renders the provider, sku and reason — not the bare HTTP reason phrase", async () => {
    // Captured verbatim from a live compute_launch { gpu: "RTX-3090", count:
    // 1, budget_cents: 200 } against real Atlas holding real provider keys,
    // when RunPod genuinely had no capacity.
    using fake = atlas({
      launch: () =>
        Response.json(
          {
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
          },
          { status: 503 },
        ),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("refused")
    expect(result.metadata.error).toBe("no_capacity")
    expect(result.output).toContain("runpod")
    expect(result.output).toContain("NVIDIA GeForce RTX 3090")
    expect(result.output).toContain("does not have the resources")
    // The defect: this used to render the bare HTTP reason phrase instead.
    expect(result.output).not.toContain("Service Unavailable")
    expect(result.title).not.toContain("unexpected")
    expect(result.metadata.attempted?.length).toBe(1)
    // The opposite-advice pairing this whole fix exists to get right: a
    // no_capacity refusal says retrying shortly is reasonable...
    expect(result.output).toContain("may work later")
    // ...and must NOT say what no_matching_offer says instead.
    expect(result.output).not.toContain("Ask for a different model")
  })

  test("no_matching_offer (400) never suggests retrying — nothing about the request changed", async () => {
    using fake = atlas({
      launch: () =>
        Response.json(
          {
            detail: {
              error: "no_matching_offer",
              gpu: "H100-SXM",
              count: 8,
              max_hourly_cents: 50,
              attempted: [],
              rate_limited: [],
              retry_after_s: null,
              message: "No listed offer matches 8x H100-SXM under 50c/hr.",
            },
          },
          { status: 400 },
        ),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.error).toBe("no_matching_offer")
    expect(result.metadata.attempted).toEqual([])
    // The kind-specific advice, not just "no crash" — this is the one that
    // must NOT appear here (it belongs to no_capacity, the opposite case).
    expect(result.output).not.toContain("may work later")
    // And the one that must: getting these two backwards is the defect.
    expect(result.output).toContain("Ask for a different model")
  })

  test("rate_limited providers and a measured retry_after_s are surfaced, never invented", async () => {
    using fake = atlas({
      launch: () =>
        Response.json(
          {
            detail: {
              error: "no_capacity",
              gpu: "A100-80GB",
              count: 2,
              max_hourly_cents: null,
              attempted: [{ provider: "runpod", sku: "NVIDIA A100 80GB", reason: "out of stock" }],
              rate_limited: ["vast"],
              retry_after_s: 12.5,
              message: "Tried 1 offer(s) for 2x A100-80GB and every one refused to launch.",
            },
          },
          { status: 503 },
        ),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.output).toContain("vast")
    expect(result.output).toContain("12.5")
    expect(result.metadata.rate_limited).toEqual(["vast"])
    expect(result.metadata.retry_after_seconds).toBe(12.5)
  })

  test("an unrecognised 503 body still reports sensibly — never [object Object], never a throw", async () => {
    using fake = atlas({ launch: () => Response.json({ detail: "Upstream overloaded." }, { status: 503 }) })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.error).toBe("unexpected")
    expect(result.output).not.toContain("[object Object]")
    expect(result.output).toContain("Upstream overloaded.")
  })
})

describe("compute_launch: the poll", () => {
  test("ready on the second poll returns the real coordinates and a pasteable ssh command", async () => {
    using fake = atlas({ poll: (n) => Response.json(n === 1 ? PROVISIONING : READY) })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("ready")
    expect(result.metadata.polls).toBe(2)
    expect(result.metadata.ssh_host).toBe("1.2.3.4")
    // -p is required, not optional: RunPod NATs SSH to a high public port and
    // Vast routes through an ssh-proxy port. The launch payload's port is
    // always 22, so this can only come from /connection.
    expect(result.metadata.ssh_port).toBe(22065)
    // accept-new because the agent's next step is a non-interactive bash call
    // and a freshly minted box has a host key nobody has seen.
    const command = `ssh -i ${keypath()} -p 22065 -o StrictHostKeyChecking=accept-new root@1.2.3.4`
    expect(result.metadata.ssh_command).toBe(command)
    expect(result.output).toContain(command)
    expect(result.metadata.lease_id).toBe("lease_abc123")
    expect(result.metadata.provider).toBe("runpod")
    expect(result.metadata.gpu_model).toBe("H100-SXM")
    expect(result.metadata.gpu_name).toBe("NVIDIA H100 80GB HBM3")
    expect(result.metadata.gpu_count).toBe(1)
    expect(result.metadata.hourly_cents).toBe(699)
    expect(result.metadata.effective_cap_cents).toBe(3000)
  })

  test("a byok lease has no cap, and is not described as having one", async () => {
    // `effective_budget_cents` is null whenever Atlas is not billing the lease
    // — there is nothing for it to cap. Printing "capped at null" would be a
    // number the user could act on that does not exist.
    using fake = atlas({
      launch: () => Response.json({ ...LAUNCH, funding: "byok", effective_budget_cents: null }, { status: 201 }),
      poll: () => Response.json(READY),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.outcome).toBe("ready")
    expect(result.metadata.effective_cap_cents).toBeNull()
    expect(result.output).not.toContain("null")
  })

  test("ready without a host is not ready", async () => {
    // The server can promote a lease before a host is backfilled; `ready`
    // with no coordinates is not usable.
    using fake = atlas({
      poll: (n) => Response.json(n === 1 ? { ...READY, ssh_host: null, ssh_port: 22 } : READY),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.polls).toBe(2)
    expect(result.metadata.ssh_host).toBe("1.2.3.4")
    expect(result.metadata.ssh_port).toBe(22065)
  })

  test("a raw status of running does not end the poll — only the normalised state does", async () => {
    // The raw vocabularies are disjoint across providers. Poll 1 below carries
    // a plausible host AND status:"running", so an implementation reading
    // `status` returns 9.9.9.9 and one poll.
    using fake = atlas({
      poll: (n) =>
        Response.json(
          n === 1 ? { state: "provisioning", status: "running", ssh_host: "9.9.9.9", ssh_port: 22 } : READY,
        ),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.polls).toBe(2)
    expect(result.metadata.ssh_host).toBe("1.2.3.4")
  })

  test("unknown is not readiness", async () => {
    using fake = atlas({
      poll: (n) =>
        Response.json(n === 1 ? { state: "unknown", status: "unhealthy", ssh_host: "9.9.9.9", ssh_port: 22 } : READY),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.polls).toBe(2)
    expect(result.metadata.ssh_host).toBe("1.2.3.4")
  })

  test("a transient poll failure does not abandon a live box", async () => {
    using fake = atlas({
      poll: (n) => (n === 1 ? new Response("upstream hiccup", { status: 500 }) : Response.json(READY)),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })
    expect(result.metadata.outcome).toBe("ready")
    expect(result.metadata.polls).toBe(2)
    expect(fake.seen.releases).toBe(0)
  })

  test("the first poll waits — a launch that just returned provisioning has nothing to say", async () => {
    const started = Date.now()
    using fake = atlas({ timeout: 0.35, poll: () => Response.json(PROVISIONING) })
    await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: { first: 150, factor: 2, max: 1000 } })
    expect(fake.seen.at.length).toBeGreaterThan(0)
    expect(fake.seen.at[0]! - started).toBeGreaterThanOrEqual(120)
  })

  test("the poll backs off instead of hammering the provider", async () => {
    // Every poll is an uncached provider HTTP call on Atlas's side. Over a
    // 500ms window a flat 5ms poller makes ~100 calls; a 3x backoff makes ~5.
    using fake = atlas({ timeout: 0.5, poll: () => Response.json(PROVISIONING) })
    const result = await ComputeLaunch.run(SPEC, context(), {
      base: fake.url,
      poll: { first: 5, factor: 3, max: 10_000 },
    })
    expect(result.metadata.polls).toBeGreaterThan(1)
    expect(result.metadata.polls).toBeLessThanOrEqual(8)
  })

  test("the bound comes from the launch response, not a constant of the client's own", async () => {
    const flat = { first: 20, factor: 1, max: 20 }
    using brief = atlas({ timeout: 0.15, poll: () => Response.json(PROVISIONING) })
    const short = await ComputeLaunch.run(SPEC, context(), { base: brief.url, poll: flat })
    using patient = atlas({ timeout: 0.8, poll: () => Response.json(PROVISIONING) })
    const long = await ComputeLaunch.run(SPEC, context(), { base: patient.url, poll: flat })

    // A client bound shorter than the server's abandons launches the server
    // was still completing; a hardcoded bound gives these two the same count.
    expect(long.metadata.polls!).toBeGreaterThan(short.metadata.polls! + 5)
  })
})

describe("compute_launch: timeout and death", () => {
  test("a lease that never becomes ready is released, not left billing", async () => {
    using fake = atlas({ timeout: 0.15, poll: () => Response.json(PROVISIONING) })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("timed_out")
    expect(result.metadata.released).toBe("released")
    expect(fake.seen.releases).toBe(1)
    expect(result.metadata.lease_id).toBe("lease_abc123")
    expect(result.output).toContain("lease_abc123")
    // The lease is gone; its key is litter with a 0600 mode.
    expect(await exists(keypath())).toBe(false)
  })

  test("a lease the server already reaped is reported, not released twice", async () => {
    using fake = atlas({
      timeout: 0.15,
      poll: () => Response.json(PROVISIONING),
      release: () => Response.json({ detail: "Lease already released" }, { status: 409 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("timed_out")
    expect(result.metadata.released).toBe("already_released")
    expect(fake.seen.releases).toBe(1)
    expect(await exists(keypath())).toBe(false)
  })

  test("an unconfirmed teardown is not reported as money stopped", async () => {
    // Atlas answers 2xx with a `release_state` (and, when it reached the
    // provider, nested `provider_result.warning` prose) when the teardown was
    // not confirmed — the box may still be running, billing, and holding a
    // concurrency slot. Swallowing that reintroduces the bug the server side
    // just fixed. Shape verified against LeaseManager.release_lease (atlas
    // backend/app/compute/lease_manager.py) — there is no top-level `warning`.
    using fake = atlas({
      timeout: 0.15,
      poll: () => Response.json(PROVISIONING),
      release: () =>
        Response.json({
          status: "released",
          terminated: false,
          unconfirmed: true,
          release_state: "unconfirmed",
          provider_result: { status: "unknown", warning: "provider teardown returned 403" },
        }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("timed_out")
    expect(result.metadata.warning).toBe("provider teardown returned 403")
    expect(result.metadata.release_state).toBe("unconfirmed")
    expect(result.output).toContain("provider teardown returned 403")
    expect(result.output).not.toContain("nothing is billing")
    // Possibly still alive, so the key it needs stays.
    expect(await exists(keypath())).toBe(true)
  })

  test("a release_state with no provider prose is still surfaced as unconfirmed", async () => {
    // `not_configured`/`provider_unavailable` never call the provider at all,
    // so there is no `provider_result.warning` to quote — but the box is
    // exactly as unconfirmed as the case above, and a client keyed off
    // "is there a warning string" rather than `release_state` would silently
    // discard a live key here.
    using fake = atlas({
      timeout: 0.15,
      poll: () => Response.json(PROVISIONING),
      release: () =>
        Response.json({
          status: "released",
          terminated: false,
          unconfirmed: true,
          release_state: "not_configured",
          provider_result: { status: "not_configured" },
        }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("timed_out")
    expect(result.metadata.release_state).toBe("not_configured")
    expect(result.metadata.warning).toBeTruthy()
    expect(await exists(keypath())).toBe(true)
  })

  test("a release that fails keeps the key and tells the agent to finish the job", async () => {
    using fake = atlas({
      timeout: 0.15,
      poll: () => Response.json(PROVISIONING),
      release: () => new Response("gateway down", { status: 502 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.released).toBe("failed")
    expect(result.output).toContain("compute_release")
    expect(result.output).toContain("lease_abc123")
    // Still possibly alive, so the key it needs stays.
    expect(await exists(keypath())).toBe(true)
  })

  test("a lease whose state cannot be read is handed back, not ground at for the whole bound", async () => {
    // Signing out between the launch and the first poll: the client can no
    // longer poll, and could not release either, so waiting out a ten-minute
    // bound would only delay telling anyone about a box that is already
    // billing.
    using fake = atlas({
      timeout: 30,
      launch: async () => {
        await fs.rm(SESSION, { force: true })
        return Response.json(LAUNCH, { status: 201 })
      },
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("unpollable")
    expect(result.metadata.lease_id).toBe("lease_abc123")
    expect(result.metadata.key_path).toBe(keypath())
    expect(fake.seen.releases).toBe(0)
    // The box is live; the key it needs must survive.
    expect(await exists(keypath())).toBe(true)
  })

  test("a launch that dies during provisioning is reported and not released again", async () => {
    using fake = atlas({
      poll: () => Response.json({ state: "terminated", status: "exited", ssh_host: null, ssh_port: 22 }),
    })
    const result = await ComputeLaunch.run(SPEC, context(), { base: fake.url, poll: FAST })

    expect(result.metadata.outcome).toBe("terminated")
    expect(result.metadata.released).toBeUndefined()
    expect(fake.seen.releases).toBe(0)
    expect(result.metadata.polls).toBe(1)
    expect(await exists(keypath())).toBe(false)
  })
})

describe("compute_launch: the approval gate", () => {
  test("it asks before it spends, and the ask precedes the launch", async () => {
    const order: string[] = []
    const asked: unknown[] = []
    using fake = atlas({
      poll: () => {
        order.push("poll")
        return Response.json(READY)
      },
      launch: () => {
        order.push("launch")
        return Response.json(LAUNCH, { status: 201 })
      },
    })
    const ctx = context(async (request) => {
      order.push("ask")
      asked.push(request)
    })
    await ComputeLaunch.run({ ...SPEC, max_hourly_cents: 800 }, ctx, { base: fake.url, poll: FAST })

    expect(order[0]).toBe("ask")
    expect(order[1]).toBe("launch")
    expect(asked.length).toBe(1)
    expect((asked[0] as { permission: string }).permission).toBe("compute_launch")
    expect((asked[0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      gpu: "H100-SXM",
      count: 1,
      budget_cents: 3000,
      max_hourly_cents: 800,
    })
  })

  test("a rejected ask spends nothing", async () => {
    using fake = atlas({ poll: () => Response.json(READY) })
    const ctx = context(async () => {
      throw new Error("rejected")
    })
    await expect(ComputeLaunch.run(SPEC, ctx, { base: fake.url, poll: FAST })).rejects.toThrow("rejected")
    expect(fake.seen.launches).toBe(0)
    expect(await exists(keypath())).toBe(false)
  })
})

describe("compute_launch: the registered tool", () => {
  test("it is named compute_launch and requires an explicit budget", async () => {
    const tool = await ComputeLaunchTool.init({})
    expect(ComputeLaunchTool.id).toBe("compute_launch")
    expect(tool.parameters.safeParse({ gpu: "H100-SXM", count: 1 }).success).toBe(false)
    expect(tool.parameters.safeParse({ gpu: "H100-SXM", count: 1, budget_cents: 3000 }).success).toBe(true)
  })

  test("executing it really calls Atlas at API_BASE", async () => {
    // The suite pins API_BASE at http://127.0.0.1:9, which nothing can serve,
    // so a tool genuinely wired to the client reports a network failure —
    // and one that is not, cannot.
    const asked: unknown[] = []
    const tool = await ComputeLaunchTool.init({})
    const result = await tool.execute(
      { ...SPEC, max_hourly_cents: 900 },
      context(async (r) => void asked.push(r)),
    )
    expect(result.metadata.outcome).toBe("refused")
    expect(result.metadata.error).toBe("network")
    expect(await exists(keypath())).toBe(false)
    // …and forwards what it was called with, rather than a shape of its own.
    expect((asked[0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      gpu: "H100-SXM",
      count: 1,
      budget_cents: 3000,
      max_hourly_cents: 900,
    })
  })
})

describe("compute_launch: interruption", () => {
  test("an interrupted poll hands back the lease rather than destroying it", async () => {
    const controller = new AbortController()
    using fake = atlas({
      timeout: 5,
      poll: () => {
        controller.abort()
        return Response.json(PROVISIONING)
      },
    })
    const ctx = context()
    const result = await ComputeLaunch.run(
      SPEC,
      { ...ctx, abort: controller.signal },
      {
        base: fake.url,
        poll: FAST,
      },
    )

    expect(result.metadata.outcome).toBe("interrupted")
    expect(fake.seen.releases).toBe(0)
    expect(result.metadata.lease_id).toBe("lease_abc123")
    expect(result.output).toContain("compute_release")
    // The box may still be coming up; the key it needs stays on disk.
    expect(await exists(keypath())).toBe(true)
  })
})
