import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import type { MessageV2 } from "../../src/session/message-v2"
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
  test("uses basic search for a signed-out user regardless of model route", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(false))
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch")
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"basic result"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "current protein folding benchmarks" }), context)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      provider: "community",
      content: "basic result",
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.metadata).toMatchObject({ searchRoute: "community" })
  })

  test("keeps basic search available on the Synthetic Sciences route", async () => {
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
    expect(result.metadata).toMatchObject({ searchRoute: "community" })
    expect(result.metadata.resultCount).toBeUndefined()
  })

  test("falls back on 402 and retries enhanced search after wallet credits recover", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
    const dispatch = spyOn(OpenScience, "dispatchResearchSearch")
      .mockResolvedValueOnce({
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
      .mockResolvedValue({
        status: 200,
        body: {
          status: "completed",
          provider: "gateway",
          results: [{ id: "recovered", title: "Recovered", url: "https://example.test/recovered" }],
        },
      })
    restores.push(dispatch)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"credit fallback"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "anthropic", modelID: "claude-test" } })
    const input = tool.parameters.parse({ query: "current protein folding benchmarks" })
    const result = await tool.execute(input, context)
    expect(JSON.parse(result.output)).toMatchObject({
      status: "completed",
      provider: "community",
      content: "credit fallback",
      managedFallback: true,
      warnings: [expect.stringContaining("wallet credits")],
    })
    expect(result.metadata).toMatchObject({ searchRoute: "community", managedFallback: true })

    const prior = {
      info: {
        id: "msg_prior",
        sessionID: "ses_search",
        role: "assistant",
        time: { created: 90, completed: 160 },
        parentID: "msg_user",
        modelID: "model",
        providerID: "provider",
        mode: "research",
        agent: "research",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "part_prior",
          sessionID: "ses_search",
          messageID: "msg_prior",
          type: "tool",
          callID: "call_prior",
          tool: "research_search",
          state: {
            status: "completed",
            input,
            output: result.output,
            title: result.title,
            metadata: result.metadata,
            time: { start: 100, end: 150 },
          },
        },
      ],
    } as MessageV2.WithParts
    const recovered = await tool.execute(input, { ...context, callID: "call_recovered", messages: [prior] })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(recovered.output)).toMatchObject({
      status: "completed",
      provider: "synthetic-sciences",
      results: [{ id: "recovered" }],
    })
    expect(recovered.metadata).toMatchObject({ searchRoute: "enhanced" })
    expect(recovered.metadata.dedupeHit).toBeUndefined()
  })

  test("preserves the enhanced-search reason when basic search returns no results", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
    restores.push(
      spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue({
        status: 402,
        body: { detail: { code: "insufficient_credits" } },
      }),
    )
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    )
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "empty managed fallback" }), context)
    expect(JSON.parse(result.output)).toMatchObject({
      provider: "community",
      managedFallback: true,
      warnings: [expect.stringContaining("wallet credits"), "No search results were returned."],
    })
    expect(result.metadata).toMatchObject({ managedFallback: true, resultCount: 0 })
  })

  test("preserves enhanced and basic unavailability when both search routes fail", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
    restores.push(spyOn(OpenScience, "dispatchResearchSearch").mockResolvedValue(null))
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }))
    restores.push(fetcher)
    const tool = await ResearchSearchTool.init({ model: { providerID: "openai", modelID: "gpt-test" } })
    const result = await tool.execute(tool.parameters.parse({ query: "both routes unavailable" }), context)
    expect(JSON.parse(result.output)).toMatchObject({
      type: "search_unavailable",
      message: expect.stringContaining("HTTP 503"),
      managedFallback: true,
      warnings: [expect.stringContaining("Enhanced search was temporarily unavailable")],
    })
    expect(result.metadata).toMatchObject({ searchRoute: "unavailable", managedFallback: true })
  })

  test("falls back to basic search when enhanced search is rejected", async () => {
    restores.push(spyOn(OpenScience, "resolveManagedSearchEntitlement").mockResolvedValue(true))
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
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.output)).toMatchObject({ provider: "community", content: "community fallback" })
    expect(result.metadata).toMatchObject({ searchRoute: "community" })
  })

  test("passes a stable operation id and returns a sanitized enhanced-search response", async () => {
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
    const output = JSON.parse(result.output)
    expect(output).toMatchObject({ status: "completed", provider: "synthetic-sciences" })
    expect(output).not.toHaveProperty("allowance")
    expect(result.metadata).toMatchObject({
      searchSource: "web",
      searchMode: "fast",
      searchRoute: "enhanced",
      resultCount: 1,
    })
  })
})
