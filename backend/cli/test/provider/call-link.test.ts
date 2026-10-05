import { describe, expect, test } from "bun:test"
import { CallLink } from "../../src/provider/call-link"
import { Provider } from "../../src/provider/provider"

const context = (): Provider.RequestContext => ({ sessionID: "ses_link", messageID: "msg_link", attempt: 2 })

async function send(input: { managed: boolean; response?: Headers; request?: Request; ctx?: Provider.RequestContext }) {
  const seen: Headers[] = []
  const fetchFn = async (fetchInput: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers ?? (fetchInput instanceof Request ? fetchInput.headers : undefined)))
    return new Response("ok", { headers: input.response })
  }
  const run = () =>
    Provider.fetchWithIdleWatchdog(fetchFn, input.request ?? "https://gateway.test", input.request ? undefined : {}, {
      providerID: "openrouter",
      modelID: "fixture",
      managed: input.managed,
    })
  const response = input.ctx ? await Provider.withRequestContext(input.ctx, run) : await run()
  await response.text()
  return seen[0]!
}

describe("call link", () => {
  test("managed requests carry the call identity and capture a valid hold id", async () => {
    const ctx = context()
    const headers = await send({
      managed: true,
      ctx,
      response: new Headers({ "x-openscience-hold-id": "orgh_0123456789abcdef" }),
    })
    expect(headers.get("x-openscience-call")).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers.get("x-openscience-message")).toBe("msg_link")
    expect(headers.get("x-openscience-attempt")).toBe("2")
    expect(headers.get("x-openscience-session")).toBe("ses_link")
    expect(ctx.call).toEqual({ id: headers.get("x-openscience-call")!, hold: "orgh_0123456789abcdef" })
  })

  test("a malformed hold id is ignored", async () => {
    const ctx = context()
    await send({ managed: true, ctx, response: new Headers({ "x-openscience-hold-id": "Bearer secret" }) })
    expect(ctx.call?.id).toBeDefined()
    expect(ctx.call?.hold).toBeUndefined()
  })

  test("non-managed requests get a call id but send no link headers", async () => {
    const ctx = context()
    const headers = await send({
      managed: false,
      ctx,
      response: new Headers({ "x-openscience-hold-id": "hold_0123456789abcdef" }),
    })
    expect(headers.get("x-openscience-call")).toBeNull()
    expect(headers.get("x-openscience-message")).toBeNull()
    expect(ctx.call?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(ctx.call?.hold).toBeUndefined()
  })

  test("a Request input keeps its own headers", async () => {
    const request = new Request("https://gateway.test", {
      method: "POST",
      headers: { authorization: "Bearer test-only", "Idempotency-Key": "logical" },
      body: "{}",
    })
    const headers = await send({ managed: true, ctx: context(), request })
    expect(headers.get("authorization")).toBe("Bearer test-only")
    expect(headers.get("Idempotency-Key")).toBe("logical")
    expect(headers.get("x-openscience-call")).not.toBeNull()
  })

  test("without a request context nothing is recorded and nothing throws", async () => {
    const headers = await send({ managed: true })
    expect(headers.get("x-openscience-call")).not.toBeNull()
    expect(Provider.currentCall()).toBeUndefined()
  })

  test("each attempt gets a new call id and the context keeps the latest", async () => {
    const ctx = context()
    const first = await send({ managed: true, ctx })
    const second = await send({ managed: true, ctx })
    expect(first.get("x-openscience-call")).not.toBe(second.get("x-openscience-call"))
    expect(ctx.call?.id).toBe(second.get("x-openscience-call")!)
  })

  test("the call id is the timing request id", async () => {
    const timings: Provider.RequestTiming[] = []
    const off = Provider.onTiming((timing) => timings.push(timing))
    const ctx = context()
    const headers = await send({ managed: true, ctx })
    off()
    expect(timings.at(-1)?.requestID).toBe(headers.get("x-openscience-call")!)
  })

  test("hold() accepts only the two Atlas hold shapes", () => {
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "hold_abc123" }))).toBe("hold_abc123")
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "orgh_legacy_abc" }))).toBe("orgh_legacy_abc")
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "gen-123" }))).toBeUndefined()
    expect(CallLink.hold(new Headers({ "x-openscience-hold-id": "hold_" + "a".repeat(81) }))).toBeUndefined()
    expect(CallLink.hold(new Headers())).toBeUndefined()
  })
})
