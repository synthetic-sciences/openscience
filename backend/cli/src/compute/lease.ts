import z from "zod"
import { API_BASE, OpenScience } from "@/openscience"

/**
 * The Atlas lease client shared by `compute_launch`, `compute_list` and
 * `compute_release`. This module owns exactly two things: the four HTTP
 * calls, and the error vocabulary that tells those three tools apart. It
 * owns no polling loop, no key-file persistence and no permission gate —
 * those are tool-level behaviour (Task 2/3) built on top of what this module
 * returns.
 *
 * WHY A DISCRIMINATED UNION, NOT EXCEPTIONS: every non-2xx response here
 * needs different handling from its caller (surface-and-stop vs
 * wait-and-retry vs release-something), and a `catch` clause's type is
 * `unknown` — recovering the distinction would mean re-deriving it from a
 * thrown value's shape at every call site. A `Result<T>` return makes the
 * distinction part of the type: a caller cannot read `.value` without first
 * narrowing on `.ok`, and cannot forget a `Failure.kind` without TypeScript
 * catching the unhandled case in a switch.
 *
 * WHY EVERY FUNCTION TAKES A `base` PARAMETER DEFAULTING TO `API_BASE`:
 * `API_BASE` is a top-level constant resolved once at import time
 * (`src/endpoints.ts`), and the test suite's `preload.ts` pins it to
 * `http://127.0.0.1:9` — an address nothing ever listens on, so an
 * accidental real call fails in milliseconds instead of hanging. Port 9 is
 * privileged (confirmed: `Bun.serve({ port: 9 })` throws `EACCES` without
 * root), so a test cannot make that address real by serving on it, and
 * overriding the env var per-test cannot work either: `API_BASE` is already
 * resolved by the time any test file's own code runs. Testing this module
 * honestly — a real `Bun.serve`, no `fetch` stub, per AGENTS.md — therefore
 * needs a seam the module accepts on purpose. `base` IS that seam: it
 * defaults to `API_BASE`, so every production call site (Task 2, Task 3)
 * calls these functions with one argument and gets exactly the mode.ts
 * pattern, while a test passes a live local server's own origin.
 */
export namespace Lease {
  // -------------------------------------------------------------------------
  // Wire shapes Atlas returns. Parsing IS the validation: constructing a
  // `Launched`/`Connection`/`Summary` value is only possible through these
  // schemas, so a response missing a required field (most importantly
  // `ssh_private_key`, which the server never resends after the 201) can
  // only ever become a `Failure`, never a lease.
  // -------------------------------------------------------------------------

  export const Spec = z.object({
    gpu: z.string(),
    count: z.number(),
    budget_cents: z.number(),
    max_hourly_cents: z.number().optional(),
  })
  export type Spec = z.infer<typeof Spec>

  export const Launched = z.object({
    lease_id: z.string().min(1),
    provider: z.string(),
    requested_sku: z.string(),
    status: z.string(),
    funding: z.string(),
    // NULLABLE, and verified so against Atlas rather than inferred:
    // `gpu_models.canonical()` returns None for a display name its taxonomy
    // cannot place — deliberately, "honest-unknown, never a guessed model" —
    // and the launch route passes that straight into the lease row. A running,
    // billing box must not be discarded over a taxonomy miss.
    gpu_model: z.string().nullable(),
    gpu_name: z.string(),
    gpu_count: z.number(),
    hourly_rate_cents: z.number(),
    // INTEGER cents, not a formatted string. `_redact_lease` assigns
    // `credits_service.to_display_cents(rate)`, whose body is `int(raw_cents)`;
    // docs/specs/compute-design.md:231 says the same ("0 when that provider
    // resolves to BYOK"). A `z.string()` here rejected every genuine 201 as
    // malformed — which is the worst failure this module has, because a
    // malformed launch writes no key while the box it describes is already
    // running and billing.
    price_cents_per_hour_display: z.number(),
    // NULL whenever the charge rate is 0 — i.e. every BYOK-funded lease, which
    // the resolver can pick for any user holding their own provider key. There
    // is nothing for Atlas to cap there, and "no cap" is not a bad response.
    effective_budget_cents: z.number().nullable(),
    provisioning_timeout_seconds: z.number(),
    ssh_user: z.string(),
    ssh_port: z.number(),
    // NULL at launch — the pod has no host yet. Never absent, always nullable.
    ssh_host: z.string().nullable(),
    // Returned exactly once, on this response, and never again on the launch
    // path. `.min(1)` so an empty string — as good as missing — fails too.
    ssh_private_key: z.string().min(1),
  })
  export type Launched = z.infer<typeof Launched>

  /**
   * `GET /leases/{id}/connection`. Only the fields a poller needs are
   * required: the normalised `state` (poll on this, never on `status` — the
   * raw vocabularies are disjoint across providers) and the real SSH
   * coordinates, which do not exist until this endpoint reports them.
   * `ssh_user` is deliberately not required here: it is constant per lease
   * and already known from the launch response, so its presence on this
   * endpoint is not a verified fact this module depends on.
   */
  export const Connection = z.object({
    state: z.enum(["provisioning", "ready", "terminated", "unknown"]),
    status: z.string(),
    ssh_host: z.string().nullable(),
    ssh_port: z.number(),
  })
  export type Connection = z.infer<typeof Connection>

  /** One row of `GET /leases` — the same lease table the launch response
   *  reads, minus the redacted key. This client does not filter to
   *  unfinished leases; `GET /leases` returns terminated ones too, and
   *  which rows count as "running" is a tool-level decision (`compute_list`),
   *  not this client's. */
  export const Summary = z.object({
    lease_id: z.string(),
    provider: z.string(),
    // Nullable columns on `compute_leases`, and genuinely null in practice:
    // `GET /leases` is `SELECT *` over EVERY lease the user has, which
    // includes CPU sandboxes and agent-spawn leases that never had an SSH
    // address or a resolved SKU. Requiring them would make one such row
    // reject the entire list.
    requested_sku: z.string().nullable(),
    status: z.string(),
    ssh_host: z.string().nullable(),
    ssh_port: z.number().nullable(),
    hourly_rate_cents: z.number(),
    /**
     * NOT on the wire today, and that is the point of `.nullish()`.
     * `effective_budget_cents` is computed by the LAUNCH route and attached to
     * its own response; it is not a column on `compute_leases`, so `SELECT *`
     * cannot return it and `_redact_lease` does not add it. Requiring it made
     * every real list response `malformed`. Left declared, and optional, so
     * the field flows through if Atlas ever starts sending it — but
     * `compute_list` cannot report a per-lease cap from this endpoint today.
     */
    effective_budget_cents: z.number().nullish(),
  })
  export type Summary = z.infer<typeof Summary>

  /**
   * `POST /leases/{id}/release`'s success shape is deliberately NOT
   * validated as strictly as `Launched`: a release carries no secret that
   * vanishes if lost, so a 2xx with an empty or unparsable body still
   * counts as success — worst case, an unconfirmed-teardown `warning` goes
   * unreported, which is degraded, not dangerous. `lease_id` is filled from
   * the input, not read back, because a release response is not guaranteed
   * to echo it.
   */
  export interface Released {
    lease_id: string
    status: string
    warning?: string
  }

  // -------------------------------------------------------------------------
  // The error vocabulary. Every kind below is a DISTINCT behaviour the tools
  // must take — this is the point of Task 1, not an afterthought.
  // -------------------------------------------------------------------------

  export type Failure =
    | { kind: "unauthenticated"; message: string }
    /** The wallet cannot fund an hour of the chosen SKU. */
    | { kind: "insufficient_credit"; affordable_budget_cents: number; message: string }
    /** The wallet is fine; the caller's own `budget_cents` is not. */
    | { kind: "budget_too_low"; affordable_budget_cents: number; message: string }
    /** The 20/min write limiter. Wait, then retry. */
    | { kind: "rate_limited"; retry_after_seconds?: number; message: string }
    /** `MANAGED_GPU_CONCURRENT` (default 2). Retrying never works — release
     *  something first. Also the DEFAULT for a 429 this client cannot
     *  identify: the safer of the two wrong guesses is the one that tells
     *  the caller to stop, not the one that invites a retry loop against a
     *  wall. */
    | { kind: "concurrency_capped"; message: string }
    /** Nothing matched the requirement — `400`. */
    | { kind: "no_matching_offer"; attempted: unknown[]; message: string }
    /** Candidates were tried and all refused — `503`. */
    | { kind: "no_capacity"; attempted: unknown[]; message: string }
    /** `409` — e.g. releasing an already-released lease. */
    | { kind: "conflict"; message: string }
    /** A 2xx whose body cannot be trusted as the thing it claims to be — a
     *  launch missing `ssh_private_key`, a connection missing coordinates, a
     *  list that is not an array. Never partially accepted. */
    | { kind: "malformed"; message: string }
    /** The request never reached Atlas, or the response never arrived. */
    | { kind: "network"; message: string }
    /** Any non-2xx this vocabulary does not otherwise name. Carries the raw
     *  HTTP status so a caller can at least log what happened. */
    | { kind: "unexpected"; status: number; message: string }

  export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure }

  // -------------------------------------------------------------------------
  // The four calls.
  // -------------------------------------------------------------------------

  export async function launch(spec: Spec, base = API_BASE): Promise<Result<Launched>> {
    const token = await bearer()
    if (!token) return failure({ kind: "unauthenticated", message: SIGNED_OUT })
    const res = await fetch(`${base}/api/compute/leases`, {
      method: "POST",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify(spec),
    }).catch((error: unknown) => error)
    if (!(res instanceof Response)) return failure({ kind: "network", message: reason(res) })
    const body = await json(res)
    if (res.status === 201) {
      const parsed = Launched.safeParse(body)
      if (parsed.success) return { ok: true, value: parsed.data }
      return failure({ kind: "malformed", message: `${MALFORMED_LAUNCH} Invalid or missing: ${issues(parsed.error)}.` })
    }
    return failure(classify(res, body))
  }

  export async function connection(id: string, base = API_BASE): Promise<Result<Connection>> {
    const token = await bearer()
    if (!token) return failure({ kind: "unauthenticated", message: SIGNED_OUT })
    const res = await fetch(`${base}/api/compute/leases/${encodeURIComponent(id)}/connection`, {
      headers: { Authorization: token },
    }).catch((error: unknown) => error)
    if (!(res instanceof Response)) return failure({ kind: "network", message: reason(res) })
    const body = await json(res)
    if (res.ok) {
      const parsed = Connection.safeParse(body)
      if (parsed.success) return { ok: true, value: parsed.data }
      return failure({
        kind: "malformed",
        message: `The /connection response did not match the expected shape. Invalid or missing: ${issues(parsed.error)}.`,
      })
    }
    return failure(classify(res, body))
  }

  export async function list(base = API_BASE): Promise<Result<Summary[]>> {
    const token = await bearer()
    if (!token) return failure({ kind: "unauthenticated", message: SIGNED_OUT })
    const res = await fetch(`${base}/api/compute/leases`, { headers: { Authorization: token } }).catch(
      (error: unknown) => error,
    )
    if (!(res instanceof Response)) return failure({ kind: "network", message: reason(res) })
    const body = await json(res)
    if (res.ok) {
      const parsed = Summary.array().safeParse(body)
      if (parsed.success) return { ok: true, value: parsed.data }
      return failure({
        kind: "malformed",
        message: `The lease list response was not an array of leases. Invalid or missing: ${issues(parsed.error)}.`,
      })
    }
    return failure(classify(res, body))
  }

  export async function release(id: string, base = API_BASE): Promise<Result<Released>> {
    const token = await bearer()
    if (!token) return failure({ kind: "unauthenticated", message: SIGNED_OUT })
    const res = await fetch(`${base}/api/compute/leases/${encodeURIComponent(id)}/release`, {
      method: "POST",
      headers: { Authorization: token },
    }).catch((error: unknown) => error)
    if (!(res instanceof Response)) return failure({ kind: "network", message: reason(res) })
    const body = await json(res)
    if (res.ok) {
      const fields = record(body)
      const status = typeof fields.status === "string" ? fields.status : "released"
      const warning = typeof fields.warning === "string" ? fields.warning : undefined
      return { ok: true, value: { lease_id: id, status, warning } }
    }
    return failure(classify(res, body))
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  const SIGNED_OUT = "No OpenScience session — sign in first."
  const MALFORMED_LAUNCH =
    "The 201 response did not match the launch shape (a required field, e.g. ssh_private_key, was missing or the wrong type)."

  function failure<T>(error: Failure): Result<T> {
    return { ok: false, error }
  }

  /** `session.api_key` shaped for the `Authorization` header, or
   *  `undefined` when signed out — mirrors mode.ts's `probe()`, which skips
   *  the network call entirely rather than sending a request known to
   *  fail. */
  async function bearer(): Promise<string | undefined> {
    const session = await OpenScience.getSession().catch(() => null)
    return session?.api_key ? `Bearer ${session.api_key}` : undefined
  }

  /** `Response.json()` types as `Promise<any>`; this pins the result to
   *  `unknown` at the one place it enters the module, and turns "not JSON"
   *  — including an empty body — into a value the caller can branch on
   *  instead of a thrown error. */
  async function json(res: Response): Promise<unknown> {
    return res.json().catch(() => undefined)
  }

  function record(body: unknown): Record<string, unknown> {
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {}
  }

  /** Which fields a schema rejected, for a message a maintainer can act on
   *  without reproducing the request. Never reaches the agent — only the
   *  `kind` does; this is diagnostic text carried on `message`. */
  function issues(error: z.ZodError): string {
    return error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")
  }

  function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Prose the server may attach under any of these keys, favouring the
   *  most human one first. `error` in a 402 body is a stable code
   *  (`insufficient_cli_credit`); using it as a last-resort message is
   *  still more useful than nothing. */
  function text(fields: Record<string, unknown>): string | undefined {
    const detail = fields.detail
    if (typeof detail === "string" && detail) return detail
    const message = fields.message
    if (typeof message === "string" && message) return message
    const error = fields.error
    if (typeof error === "string" && error) return error
    return undefined
  }

  function attempted(fields: Record<string, unknown>): unknown[] {
    return Array.isArray(fields.attempted) ? fields.attempted : []
  }

  function after(res: Response): number | undefined {
    const header = res.headers.get("retry-after")
    const seconds = header ? Number(header) : NaN
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
  }

  /** The two structured `402`s. Matched on the stable `error` code, not
   *  prose. A 402 whose `error` matches neither known code, or that lacks
   *  `affordable_budget_cents`, is a shape this vocabulary does not
   *  recognise — surfaced generically rather than guessed, unlike the 429
   *  split below where an unrecognised body still has a documented safe
   *  default. */
  function payment(fields: Record<string, unknown>, note: string): Failure {
    const cents = fields.affordable_budget_cents
    const budget = typeof cents === "number" ? cents : undefined
    if (fields.error === "insufficient_cli_credit" && budget !== undefined)
      return { kind: "insufficient_credit", affordable_budget_cents: budget, message: note }
    if (fields.error === "budget_below_hourly_rate" && budget !== undefined)
      return { kind: "budget_too_low", affordable_budget_cents: budget, message: note }
    return { kind: "unexpected", status: 402, message: note }
  }

  /**
   * The two `429`s. Matched defensively on prose, because the spec that
   * documents this endpoint calls out explicitly that provider and server
   * prose can change — the concurrency cap's detail today reads "Managed
   * GPU concurrency cap reached (n/m).", and only the
   * "concurrency"/"cap"-shaped vocabulary is trusted to survive a copy
   * edit, not the exact sentence.
   *
   * A single `RateLimited` case would be a defect: the rate limiter means
   * wait-and-retry, the concurrency cap means retrying never works. When
   * the body cannot be identified as either, this returns the cap — the
   * response that tells the caller to stop — because guessing "retry"
   * wrong produces a loop against a wall, and guessing "stop" wrong costs
   * one avoidable pause.
   */
  function limited(fields: Record<string, unknown>, res: Response): Failure {
    const cause = text(fields) ?? ""
    if (/concurrency/i.test(cause)) return { kind: "concurrency_capped", message: cause }
    if (/rate.?limit|too many/i.test(cause))
      return { kind: "rate_limited", message: cause, retry_after_seconds: after(res) }
    return { kind: "concurrency_capped", message: cause || `HTTP 429: ${res.statusText || "Too Many Requests"}` }
  }

  /** Shared by all four calls: turn a non-2xx response into a named
   *  `Failure`. Endpoint-agnostic on purpose — nothing here assumes it is
   *  only ever called from `launch()`, since a caller hammering any of
   *  these four could in principle hit the same limiter or the same
   *  conflict. */
  function classify(res: Response, body: unknown): Failure {
    const fields = record(body)
    const note = text(fields) ?? (res.statusText || `HTTP ${res.status}`)
    if (res.status === 401) return { kind: "unauthenticated", message: note }
    if (res.status === 402) return payment(fields, note)
    if (res.status === 409) return { kind: "conflict", message: note }
    if (res.status === 429) return limited(fields, res)
    if (res.status === 400 && fields.error === "no_matching_offer")
      return { kind: "no_matching_offer", attempted: attempted(fields), message: note }
    if (res.status === 503 && fields.error === "no_capacity")
      return { kind: "no_capacity", attempted: attempted(fields), message: note }
    return { kind: "unexpected", status: res.status, message: note }
  }
}
