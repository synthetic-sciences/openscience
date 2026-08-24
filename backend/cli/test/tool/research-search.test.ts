import { afterEach, describe, expect, spyOn, test } from "bun:test"
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

afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore()
})

describe("research_search", () => {
  test("falls back to community search for every model when Gateway is unavailable", async () => {
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
      status: "completed",
      provider: "community",
      content: "community fallback",
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
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
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      provider: "community",
      content: "community result",
    })
    expect(result.metadata).toMatchObject({ creditState: "community" })
    expect(result.metadata.resultCount).toBeUndefined()
  })

  test("lets the Gateway return basic fallback results with an empty Wallet", async () => {
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

  test.each([
    {
      status: 429,
      body: { detail: { code: "rate_limited", message: "Gateway search is busy." } },
      warning: "Gateway search is busy. Basic community search was used.",
    },
    {
      status: 503,
      body: {
        detail: { code: "search_unavailable", message: "Enhanced search is temporarily unavailable." },
        warnings: ["Upstream search provider did not respond."],
      },
      warning: "Enhanced search is temporarily unavailable. Basic community search was used.",
    },
  ])("falls back transparently on transient Gateway HTTP $status responses", async ({ status, body, warning }) => {
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({ status, body })
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
    expect(output.warnings).toContain(warning)
    if (status === 503) expect(output.warnings).toContain("Upstream search provider did not respond.")
    expect(result.metadata).toMatchObject({ creditState: "community" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    // A failed enhanced request never creates a client-side wallet mutation.
    expect(invalidate).not.toHaveBeenCalled()
  })

  test.each([
    { status: 401, code: "invalid_api_key" },
    { status: 403, code: "account_disabled" },
    { status: 422, code: "invalid_search_request" },
  ])("surfaces Gateway HTTP $status errors that require user action", async ({ status, code }) => {
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
    expect(JSON.parse(result.output)).toMatchObject({ status: "completed", provider: "gateway" })
    expect(result.metadata).toMatchObject({
      searchSource: "web",
      searchMode: "fast",
      resultCount: 1,
      creditState: "funded",
    })
  })
})
