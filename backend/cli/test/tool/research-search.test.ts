import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { ResearchSearchTool } from "../../src/tool/research-search"

const context = {
  sessionID: "ses_search",
  messageID: "msg_search",
  callID: "call_search",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
}

const restores: Array<{ mockRestore(): void }> = []
const sessionPath = path.join(Global.Path.data, "openscience-session.json")

function managedAce(ace = true) {
  const snapshot = Object.freeze({
    api_key: "thk_search.secret",
    user_id: "user-search",
    account: "user-search",
    organization_id: "org_search",
  })
  const funding = spyOn(OpenScience, "getFundingSnapshot").mockResolvedValue(snapshot)
  const billing = spyOn(OpenScience, "getBillingMode").mockResolvedValue({
    mode: "managed",
    balance_cents: 2_000,
    ace_enabled: ace,
    managed_supported: true,
    managed_unlocked: true,
    balance_usd: 20,
  })
  restores.push(funding, billing)
  return { snapshot, billing }
}

afterEach(async () => {
  for (const spy of restores.splice(0)) spy.mockRestore()
  await fs.rm(sessionPath, { force: true })
})

describe("research_search", () => {
  test("does not start a second provider when managed settlement is unknown", async () => {
    const { snapshot } = managedAce()
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue(null)
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"community fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(JSON.parse(result.output)).toMatchObject({
      type: "search_unavailable",
      retryable: true,
      operation_id: "call_search",
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[3]).toBe(snapshot)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("uses the exact organization snapshot for a funded Wallet when Ace reload is off", async () => {
    const { snapshot, billing } = managedAce(false)
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue(null)
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"community fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)

    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "funded organization search" }), context)

    expect(JSON.parse(result.output)).toMatchObject({ type: "search_unavailable", operation_id: "call_search" })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(billing.mock.calls[0]?.[0]).toBe(snapshot)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[3]).toBe(snapshot)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("preserves the existing community search rule for the Free community route", async () => {
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue(null)
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"community result"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openrouter", modelID: "free-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      provider: "community",
      content: "community result",
    })
    expect(result.metadata).toMatchObject({ creditState: "community" })
    expect(result.metadata.resultCount).toBeUndefined()
  })

  test("lets the Gateway return basic fallback results with an empty Wallet", async () => {
    managedAce()
    const invalidate = spyOn(OpenScience, "invalidateBalance").mockImplementation(() => undefined)
    restores.push(invalidate)
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 200,
      body: {
        operation_id: "call_search",
        status: "completed",
        provider: "free_search",
        funding: "free_fallback",
        results: [{ id: "result", title: "Basic result", url: "https://example.test" }],
        warnings: ["Enhanced search needs credits."],
      },
    })
    restores.push(dispatch)

    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({ provider: "free_search", funding: "free_fallback" })
    expect(result.metadata).toMatchObject({ creditState: "free", resultCount: 1 })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  test("falls back to community search when a mixed-version Gateway returns credit exhaustion", async () => {
    managedAce()
    const invalidate = spyOn(OpenScience, "invalidateBalance").mockImplementation(() => undefined)
    restores.push(invalidate)
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 402,
      body: {
        detail: {
          code: "insufficient_credits",
          message: "Add credits",
          billing_url: "/billing",
        },
      },
    })
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"basic fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "anthropic", modelID: "claude-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      provider: "community",
      content: "basic fallback",
    })
    expect(result.metadata).toMatchObject({ creditState: "community" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  test("keeps the basic route for a mixed-version paid-search entitlement rejection", async () => {
    managedAce()
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 403,
      body: { detail: { code: "search_not_entitled", message: "Managed search is not enabled." } },
    })
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"community fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openrouter", modelID: "free-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({ provider: "community", content: "community fallback" })
    expect(result.metadata).toMatchObject({ creditState: "community" })
  })

  test("falls back to community after a definitive managed rate-limit rejection", async () => {
    managedAce()
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 429,
      body: { detail: { code: "rate_limited", message: "Gateway search is busy." } },
    })
    restores.push(dispatch)
    const invalidate = spyOn(OpenScience, "invalidateBalance").mockImplementation(() => undefined)
    restores.push(invalidate)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"basic fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)

    const tool = await ResearchSearchTool.init({ model: { providerID: "openrouter", modelID: "test-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    const output = JSON.parse(result.output) as { provider: string; content: string; warnings: string[] }

    expect(output).toMatchObject({ provider: "community", content: "basic fallback" })
    expect(output.warnings).toContain("Gateway search is busy. Community search was used.")
    expect(result.metadata).toMatchObject({ creditState: "community" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    // A failed enhanced request never creates a client-side wallet mutation.
    expect(invalidate).not.toHaveBeenCalled()
  })

  test.each([
    {
      status: 503,
      body: {
        detail: { code: "search_unavailable", message: "Enhanced search is temporarily unavailable." },
        warnings: ["Upstream search provider did not respond."],
      },
    },
    {
      status: 409,
      body: { detail: { code: "operation_in_progress", message: "Managed search is still running." } },
    },
  ])("does not cross providers after an ambiguous managed $status response", async ({ status, body }) => {
    managedAce()
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status,
      body,
    })
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("no second provider should start")
    }) as unknown as typeof fetch)
    restores.push(fetcher)

    const tool = await ResearchSearchTool.init({ model: { providerID: "openrouter", modelID: "test-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    const output = JSON.parse(result.output)

    expect(output).toMatchObject({
      type: "search_unavailable",
      retryable: true,
      operation_id: "call_search",
    })
    if (status === 503) expect(output.warnings).toContain("Upstream search provider did not respond.")
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("retries managed search on a later request after a transient service failure", async () => {
    managedAce()
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 503,
      body: { detail: { code: "search_unavailable", message: "Managed search is recovering." } },
    })
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"community fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)

    const tool = await ResearchSearchTool.init({ model: { providerID: "openrouter", modelID: "test-model" } })
    await tool.execute(tool.parameters.parse({ query: "first managed search" }), context)
    const second = await tool.execute(tool.parameters.parse({ query: "second managed search" }), context)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(second.output)).toMatchObject({ type: "search_unavailable", retryable: true })
  })

  test.each([
    { status: 401, code: "invalid_api_key" },
    { status: 403, code: "account_disabled" },
    { status: 422, code: "invalid_search_request" },
  ])("surfaces Gateway HTTP $status errors that require user action", async ({ status, code }) => {
    managedAce()
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status,
      body: { detail: { code, message: "Reconnect or correct the request." } },
    })
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("community search must not hide account or request errors")
    }) as unknown as typeof fetch)
    restores.push(fetcher)

    const tool = await ResearchSearchTool.init({ model: { providerID: "openrouter", modelID: "test-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)

    expect(JSON.parse(result.output)).toMatchObject({
      type: "search_unavailable",
      message: "Reconnect or correct the request.",
    })
    expect(result.metadata).toMatchObject({ creditState: "unavailable" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("passes a stable operation id and invalidates the displayed balance after funded settlement", async () => {
    managedAce()
    const invalidate = spyOn(OpenScience, "invalidateBalance").mockImplementation(() => undefined)
    restores.push(invalidate)
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 200,
      body: {
        operation_id: "call_search",
        status: "completed",
        provider: "gateway",
        funding: "wallet",
        results: [{ id: "result", title: "Paper", url: "https://example.test" }],
        warnings: [],
        cache: { hit: false },
        allowance: { limit: 500, used: 1, remaining: 499, reserved: 0, reset_at: "next" },
      },
    })
    restores.push(dispatch)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(
      tool.parameters.parse({ query: "current protein folding benchmarks", mode: "fast" }),
      context,
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[1]).toBe("call_search")
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({ status: "completed", provider: "synthetic-sciences" })
    expect(result.metadata).toMatchObject({
      searchSource: "web",
      searchMode: "fast",
      resultCount: 1,
      creditState: "funded",
    })
  })

  test.each(["committed-before-response-loss", "failed-before-commit"])(
    "replays the exact paid-search operation after a %s transport failure",
    async (scenario) => {
      await fs.mkdir(Global.Path.data, { recursive: true })
      await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_search.secret", user_id: "user-search" }))
      const requests: Array<{ key: string | null; body: string }> = []
      const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({ key: headers.get("Idempotency-Key"), body: String(init?.body) })
        if (requests.length === 1) throw new TypeError(`${scenario}: connection reset`)
        return Response.json({
          operation_id: "stable-operation",
          status: "completed",
          provider: "gateway",
          funding: "wallet",
          replayed: scenario === "committed-before-response-loss",
          results: [{ id: "result", title: "Recovered result", url: "https://example.test" }],
        })
      }) as typeof fetch)
      restores.push(fetcher)

      const response = await OpenScience.dispatchResearchSearch(
        { query: "idempotent search", content: "snippets", mode: "fast", source: "web", limit: 5 },
        "stable-operation",
        new AbortController().signal,
      )

      expect(response).toMatchObject({ status: 200, body: { operation_id: "stable-operation" } })
      expect(requests).toHaveLength(2)
      expect(requests[0]).toEqual(requests[1])
      expect(requests[0]?.key).toBe("stable-operation")
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ operation_id: "stable-operation" })
    },
  )

  test("returns unavailable only after both identical paid-search attempts fail", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_search.secret", user_id: "user-search" }))
    const requests: Array<{ key: string | null; body: string }> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers)
      requests.push({ key: headers.get("Idempotency-Key"), body: String(init?.body) })
      throw new TypeError("connection reset")
    }) as unknown as typeof fetch)
    restores.push(fetcher)

    const response = await OpenScience.dispatchResearchSearch(
      { query: "idempotent search", content: "snippets", mode: "fast", source: "web", limit: 5 },
      "stable-operation",
      new AbortController().signal,
    )

    expect(response).toBeNull()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
  })

  test("replays the exact paid-search operation after a gateway 5xx", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_search.secret", user_id: "user-search" }))
    const requests: Array<{ key: string | null; body: string }> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers)
      requests.push({ key: headers.get("Idempotency-Key"), body: String(init?.body) })
      if (requests.length === 1) return Response.json({ detail: "upstream response lost" }, { status: 503 })
      return Response.json({
        operation_id: "stable-operation",
        status: "completed",
        provider: "gateway",
        funding: "wallet",
        replayed: true,
        results: [{ id: "result", title: "Recovered result", url: "https://example.test" }],
      })
    }) as typeof fetch)
    restores.push(fetcher)

    const response = await OpenScience.dispatchResearchSearch(
      { query: "idempotent search", content: "snippets", mode: "fast", source: "web", limit: 5 },
      "stable-operation",
      new AbortController().signal,
    )

    expect(response).toMatchObject({ status: 200, body: { replayed: true } })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
  })

  test("returns the second gateway 5xx after one bounded replay", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify({ api_key: "thk_search.secret", user_id: "user-search" }))
    const requests: Array<{ key: string | null; body: string }> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers)
      requests.push({ key: headers.get("Idempotency-Key"), body: String(init?.body) })
      return Response.json({ detail: { code: "search_unavailable" } }, { status: 503 })
    }) as typeof fetch)
    restores.push(fetcher)

    const response = await OpenScience.dispatchResearchSearch(
      { query: "idempotent search", content: "snippets", mode: "fast", source: "web", limit: 5 },
      "stable-operation",
      new AbortController().signal,
    )

    expect(response).toMatchObject({ status: 503 })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
  })
})
