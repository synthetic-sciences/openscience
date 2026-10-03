import { describe, expect, test } from "bun:test"
import { streamText, type Tool } from "ai"
import { createOpenaiCompatible } from "../../src/provider/sdk/openai-compatible/src"
import { webSearch } from "../../src/provider/sdk/openai-compatible/src/responses/tool/web-search"

/** A Responses turn whose only output item is a completed web search, replayed
 *  from the wire. Nothing inside the provider is stubbed — the in-repo
 *  OpenAIResponsesLanguageModel parses these bytes. */
const done = {
  type: "web_search_call",
  id: "ws-1",
  status: "completed",
  action: { type: "search", query: "retrieval augmented generation" },
}

function replay() {
  const events = [
    {
      type: "response.created",
      response: {
        created_at: 1785764408,
        id: "resp-1",
        model: "gpt-test",
        object: "response",
        output: [],
        status: "in_progress",
      },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...done, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: {
        created_at: 1785764408,
        id: "resp-1",
        model: "gpt-test",
        object: "response",
        output: [done],
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
        status: "completed",
      },
    },
  ]
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  const fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  return fetch as unknown as typeof globalThis.fetch
}

/** The provider-defined web search tool under the name the caller registered
 *  it with. `name` is fixed by the factory, so a caller that needs a different
 *  one overrides it on the tool it hands to the SDK. */
function registeredAs(name: string) {
  return { [name]: { ...webSearch(), name } as Tool }
}

async function names(tools: Record<string, Tool>) {
  const sdk = createOpenaiCompatible({ apiKey: "test", baseURL: "https://gateway.test/v1", fetch: replay() })
  const result = streamText({
    model: sdk.responses("gpt-test"),
    prompt: "Search the literature for retrieval augmented generation.",
    tools,
  })

  const started: string[] = []
  const called: string[] = []
  const errors: unknown[] = []
  for await (const part of result.fullStream) {
    if (part.type === "error") errors.push(part.error)
    if (part.type === "tool-input-start") started.push(part.toolName)
    if (part.type === "tool-call") called.push(part.toolName)
  }
  return { started, called, errors }
}

describe("Responses stream reports a renamed web-search tool under that name", () => {
  test("the default name is unchanged", async () => {
    const result = await names(registeredAs("web_search"))

    expect(result.errors).toEqual([])
    expect(result.started).toStrictEqual(["web_search"])
    expect(result.called).toStrictEqual(["web_search"])
  })

  test("a renamed tool keeps one name across input-start and tool-call", async () => {
    // output_item.added and doGenerate both resolve the name the caller
    // registered; output_item.done used to hardcode "web_search", so the
    // emitted call could not be routed to the registered tool.
    const result = await names(registeredAs("docs_search"))

    expect(result.errors).toEqual([])
    expect(result.started).toStrictEqual(["docs_search"])
    expect(result.called).toStrictEqual(["docs_search"])
  })
})
