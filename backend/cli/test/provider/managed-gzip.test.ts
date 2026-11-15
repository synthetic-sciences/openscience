import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { ManagedGzip } from "../../src/provider/managed-gzip"
import { Provider } from "../../src/provider/provider"

const GATEWAY = "https://gateway.test/api/llm/proxy/openrouter/v1/chat/completions"
const BIG = JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "hello ".repeat(4000) }] })
const ADVERTISES = { "x-openscience-request-encoding": "gzip" }

type Seen = { body: unknown; headers: Headers }

function gateway(replies: Array<{ status?: number; headers?: Record<string, string>; json?: unknown }>) {
  const seen: Seen[] = []
  const fetchFn = async (_input: unknown, init?: RequestInit) => {
    seen.push({ body: init?.body, headers: new Headers(init?.headers) })
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!
    if (reply.json !== undefined)
      return Response.json(reply.json, { status: reply.status ?? 200, headers: reply.headers })
    return new Response("ok", { status: reply.status ?? 200, headers: reply.headers })
  }
  const send = (body: string, managed = true, endpoint = GATEWAY) =>
    Provider.fetchWithIdleWatchdog(
      fetchFn,
      endpoint,
      { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length) } },
      { providerID: "openrouter", modelID: "fixture", managed },
    ).then(async (response) => Object.assign(response, { text_: await response.text() }))
  return { seen, send }
}

const inflate = (body: unknown) => gunzipSync(body as Uint8Array).toString()

let saved: string | undefined
beforeEach(() => {
  saved = process.env["OPENSCIENCE_MANAGED_GZIP"]
  process.env["OPENSCIENCE_MANAGED_GZIP"] = "1"
  ManagedGzip.reset()
})
afterEach(() => {
  if (saved === undefined) delete process.env["OPENSCIENCE_MANAGED_GZIP"]
  else process.env["OPENSCIENCE_MANAGED_GZIP"] = saved
  ManagedGzip.reset()
})

describe("managed request gzip", () => {
  test("the first call is plain; once the gateway advertises gzip, large bodies are compressed", async () => {
    const { seen, send } = gateway([{ headers: ADVERTISES }])
    await send(BIG)
    await send(BIG)
    expect(seen[0]!.body).toBe(BIG)
    expect(seen[0]!.headers.get("content-encoding")).toBeNull()
    expect(seen[1]!.headers.get("content-encoding")).toBe("gzip")
    expect(seen[1]!.headers.get("content-length")).toBeNull()
    expect(inflate(seen[1]!.body)).toBe(BIG)
    expect((seen[1]!.body as Uint8Array).byteLength).toBeLessThan(BIG.length / 2)
  })

  test("small bodies, other gateways, BYOK calls and a switched-off flag stay plain", async () => {
    const { seen, send } = gateway([{ headers: ADVERTISES }])
    await send(BIG)
    await send('{"model":"fixture","messages":[]}')
    await send(BIG, true, "https://other-gateway.test/api/llm/proxy/openrouter/v1/chat/completions")
    await send(BIG, false)
    process.env["OPENSCIENCE_MANAGED_GZIP"] = "0"
    await send(BIG)
    for (const call of seen.slice(1)) expect(call.headers.get("content-encoding")).toBeNull()
  })

  test("a gateway that refuses gzip with 415 gets the plain body and is not sent gzip again", async () => {
    const { seen, send } = gateway([{ headers: ADVERTISES }, { status: 415 }, {}])
    await send(BIG)
    const response = await send(BIG)
    await send(BIG)
    expect(response.status).toBe(200)
    expect(seen[1]!.headers.get("content-encoding")).toBe("gzip")
    expect(seen[2]!.body).toBe(BIG)
    expect(seen[2]!.headers.get("content-encoding")).toBeNull()
    expect(seen[3]!.headers.get("content-encoding")).toBeNull()
  })

  test("a gateway without gzip support (400 invalid_json) gets the plain body once, then plain only", async () => {
    // An Ace that predates gzip (rollback, or old machines mid-deploy) reads
    // the compressed bytes as broken JSON before it claims the idempotency key.
    const { seen, send } = gateway([
      { headers: ADVERTISES },
      { status: 400, json: { detail: { error: "invalid_json" } } },
      {},
      { headers: ADVERTISES },
      {},
    ])
    await send(BIG)
    const response = await send(BIG)
    expect(response.status).toBe(200)
    expect(seen[1]!.headers.get("content-encoding")).toBe("gzip")
    expect(seen[2]!.body).toBe(BIG)
    // A new machine advertising again does not switch gzip back on at once.
    await send(BIG)
    await send(BIG)
    expect(seen[3]!.headers.get("content-encoding")).toBeNull()
    expect(seen[4]!.headers.get("content-encoding")).toBeNull()
  })

  test("a gateway that cannot read the gzip body (400 invalid_content_encoding) gets the plain body", async () => {
    const { seen, send } = gateway([
      { headers: ADVERTISES },
      { status: 400, json: { detail: { error: "invalid_content_encoding" } } },
      {},
    ])
    await send(BIG)
    expect((await send(BIG)).status).toBe(200)
    expect(seen[2]!.body).toBe(BIG)
  })

  test("other 400s are returned as they are, without a resend", async () => {
    const { seen, send } = gateway([
      { headers: ADVERTISES },
      { status: 400, json: { error: { message: "nonexistent/model is not a valid model ID", code: 400 } } },
    ])
    await send(BIG)
    const response = await send(BIG)
    expect(response.status).toBe(400)
    expect(response.text_).toContain("not a valid model ID")
    expect(seen).toHaveLength(2)
  })
})
