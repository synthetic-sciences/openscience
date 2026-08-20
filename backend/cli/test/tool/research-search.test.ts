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
  test("stays advertised on a non-managed provider and returns a typed unavailable result", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(false))
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch")
    restores.push(dispatch)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      type: "search_unavailable",
      retryable: false,
      alternatives: ["science_search", "science_fetch", "WebFetch"],
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  test("preserves the existing community search rule for the Free community route", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(false))
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"community result"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "synsci", modelID: "free-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      provider: "community",
      content: "community result",
    })
    expect(result.metadata).toMatchObject({ allowanceState: "community" })
    expect(result.metadata.resultCount).toBeUndefined()
  })

  test("maps Gateway allowance exhaustion to one completed terminal result", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 402,
      body: {
        detail: {
          code: "search_allowance_exhausted",
          message: "Allowance exhausted",
          reset_at: "2026-09-01T00:00:00Z",
          upgrade_url: "/billing",
        },
      },
    })
    restores.push(dispatch)
    const tool = await ResearchSearchTool.init({ model: { providerID: "anthropic", modelID: "claude-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      type: "search_allowance_exhausted",
      reset_at: "2026-09-01T00:00:00Z",
      upgrade_url: "https://app.syntheticsciences.ai/billing",
    })
    expect(result.metadata).toMatchObject({ allowanceState: "exhausted" })
  })

  test("refreshes a rejected entitlement and falls back to the unchanged Free community route", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
    const refresh = spyOn(OpenScience, "refreshManagedSearchEntitlementAfterRejection").mockResolvedValue(false)
    restores.push(refresh)
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
    const tool = await ResearchSearchTool.init({ model: { providerID: "synsci", modelID: "free-model" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({ provider: "community", content: "community fallback" })
    expect(result.metadata).toMatchObject({ allowanceState: "community" })
  })

  test("passes a stable operation id and returns the normalized Gateway response without a billing call", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
      status: 200,
      body: {
        operation_id: "call_search",
        status: "completed",
        provider: "gateway",
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
    expect(JSON.parse(result.output)).toMatchObject({ status: "completed", provider: "gateway" })
    expect(result.metadata).toMatchObject({ searchSource: "web", searchMode: "fast", resultCount: 1 })
  })
})
