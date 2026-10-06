import { describe, expect, test } from "bun:test"
import { CallLink } from "../../src/provider/call-link"
import { Provider } from "../../src/provider/provider"

const context = (): Provider.RequestContext => ({ sessionID: "ses_link", messageID: "msg_link", attempt: 2 })

async function send(input: {
  managed: boolean
  response?: Headers
  request?: Request
  ctx?: Provider.RequestContext
  body?: string | null
}) {
  const seen: Headers[] = []
  const fetchFn = async (fetchInput: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers ?? (fetchInput instanceof Request ? fetchInput.headers : undefined)))
    return new Response(input.body === undefined ? "ok" : input.body, { headers: input.response })
  }
  const run = () =>
    Provider.fetchWithIdleWatchdog(fetchFn, input.request ?? "https://gateway.test", input.request ? undefined : {}, {
      providerID: "openrouter",
      modelID: "fixture",
      managed: input.managed,
    })
  const response = input.ctx ? await Provider.withRequestContext(input.ctx, run) : await run()
  await response.text()
  // The AI SDK hands a step its response headers as a lowercase record.
  const link = CallLink.fromResponse(Object.fromEntries(response.headers.entries()))
  return { sent: seen[0]!, link, response }
}

describe("call link", () => {
  test("managed requests carry the call identity and the response carries the same call and a valid hold", async () => {
    const { sent, link } = await send({
      managed: true,
      ctx: context(),
      response: new Headers({ "x-openscience-hold-id": "orgh_0123456789abcdef" }),
    })
    expect(sent.get("x-openscience-call")).toMatch(/^[0-9a-f-]{36}$/)
    expect(sent.get("x-openscience-message")).toBe("msg_link")
    expect(sent.get("x-openscience-attempt")).toBe("2")
    expect(sent.get("x-openscience-session")).toBe("ses_link")
    expect(link).toEqual({ id: sent.get("x-openscience-call")!, hold: "orgh_0123456789abcdef" })
  })

  test("a malformed hold id is dropped from the response", async () => {
    const { link, response } = await send({
      managed: true,
      ctx: context(),
      response: new Headers({ "x-openscience-hold-id": "Bearer secret" }),
    })
    expect(link?.id).toBeDefined()
    expect(link?.hold).toBeUndefined()
    expect(response.headers.get("x-openscience-hold-id")).toBeNull()
  })

  test("non-managed requests get a call id but send no link headers and keep no hold", async () => {
    const { sent, link, response } = await send({
      managed: false,
      ctx: context(),
      response: new Headers({ "x-openscience-hold-id": "hold_0123456789abcdef" }),
    })
    expect(sent.get("x-openscience-call")).toBeNull()
    expect(sent.get("x-openscience-message")).toBeNull()
    expect(link?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(link?.hold).toBeUndefined()
    expect(response.headers.get("x-openscience-hold-id")).toBeNull()
  })

  test("an upstream cannot choose the call id", async () => {
    const { sent, link } = await send({
      managed: true,
      ctx: context(),
      response: new Headers({ "x-openscience-call": "spoofed" }),
    })
    expect(link?.id).toBe(sent.get("x-openscience-call")!)
  })

  test("a response without a body still carries its call", async () => {
    const { sent, link } = await send({ managed: true, ctx: context(), body: null })
    expect(link?.id).toBe(sent.get("x-openscience-call")!)
  })

  test("a Request input keeps its own headers", async () => {
    const request = new Request("https://gateway.test", {
      method: "POST",
      headers: { authorization: "Bearer test-only", "Idempotency-Key": "logical" },
      body: "{}",
    })
    const { sent } = await send({ managed: true, ctx: context(), request })
    expect(sent.get("authorization")).toBe("Bearer test-only")
    expect(sent.get("Idempotency-Key")).toBe("logical")
    expect(sent.get("x-openscience-call")).not.toBeNull()
  })

  test("without a request context the response still carries its call and nothing throws", async () => {
    const { sent, link } = await send({ managed: true })
    expect(sent.get("x-openscience-call")).not.toBeNull()
    expect(link?.id).toBe(sent.get("x-openscience-call")!)
  })

  test("sequential attempts on one context each keep their own call and hold on their own response", async () => {
    const ctx = context()
    const first = await send({ managed: true, ctx, response: new Headers({ "x-openscience-hold-id": "hold_first" }) })
    const second = await send({ managed: true, ctx, response: new Headers({ "x-openscience-hold-id": "hold_second" }) })
    expect(first.sent.get("x-openscience-call")).not.toBe(second.sent.get("x-openscience-call"))
    // The first response is unaffected by the later attempt on the same context.
    expect(first.link).toEqual({ id: first.sent.get("x-openscience-call")!, hold: "hold_first" })
    expect(second.link).toEqual({ id: second.sent.get("x-openscience-call")!, hold: "hold_second" })
    expect(ctx).toEqual(context())
  })

  test("the call id is the timing request id", async () => {
    const timings: Provider.RequestTiming[] = []
    const off = Provider.onTiming((timing) => timings.push(timing))
    const { sent } = await send({ managed: true, ctx: context() })
    off()
    expect(timings.at(-1)?.requestID).toBe(sent.get("x-openscience-call")!)
  })

  test("hold() accepts only the two Atlas hold shapes", () => {
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "hold_abc123" }))).toBe("hold_abc123")
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "orgh_legacy_abc" }))).toBe("orgh_legacy_abc")
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "gen-123" }))).toBeUndefined()
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "hold_" + "a".repeat(81) }))).toBeUndefined()
    expect(CallLink.hold(new Headers())).toBeUndefined()
  })

  test("fromResponse() reads a step's own response headers", () => {
    const id = "7f3c1e9a-0000-4000-8000-000000000001"
    expect(CallLink.fromResponse({ "x-openscience-call": id, "x-openscience-hold-id": "hold_abc" })).toEqual({
      id,
      hold: "hold_abc",
    })
    expect(CallLink.fromResponse({ "x-openscience-call": id, "x-openscience-hold-id": "nope" })).toEqual({ id })
    expect(CallLink.fromResponse({ "x-openscience-call": "not a uuid" })).toBeUndefined()
    expect(CallLink.fromResponse({})).toBeUndefined()
    expect(CallLink.fromResponse(undefined)).toBeUndefined()
  })
})
