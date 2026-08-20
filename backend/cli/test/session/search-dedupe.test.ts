import { expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { SearchDedupe } from "../../src/session/search-dedupe"

const part: MessageV2.ToolPart = {
  id: "part_search",
  sessionID: "ses_search",
  messageID: "msg_search",
  type: "tool",
  callID: "call_search",
  tool: "websearch",
  state: {
    status: "completed",
    input: { numResults: 4, query: "protein folding" },
    output: "grounded results",
    title: "Web search",
    metadata: {},
    time: { start: 100, end: 150 },
  },
}

const message: MessageV2.WithParts = {
  info: {
    id: "msg_search",
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
  parts: [part],
}

test("reuses one completed identical search and marks the new call as a dedupe hit", () => {
  expect(SearchDedupe.signature({ query: "x", top: 3 })).toBe(SearchDedupe.signature({ top: 3, query: "x" }))
  const hit = SearchDedupe.find([message], "websearch", { query: "protein folding", numResults: 4 })
  expect(hit?.id).toBe("part_search")
  expect(hit && SearchDedupe.reuse(hit)).toMatchObject({
    output: "grounded results",
    metadata: {
      dedupeHit: true,
      dedupeOf: {
        messageID: "msg_search",
        partID: "part_search",
        callID: "call_search",
      },
    },
  })
  expect(SearchDedupe.find([message], "websearch", { query: "different", numResults: 4 })).toBeUndefined()
  expect(SearchDedupe.find([message], "read", { filePath: "/tmp/file" })).toBeUndefined()
})

test("dedupes a canonical research_search call against legacy websearch history", () => {
  const hit = SearchDedupe.find([message], "research_search", {
    query: "protein folding",
    source: "web",
    mode: "balanced",
    limit: 4,
    content: "snippets",
  })
  expect(hit?.id).toBe("part_search")
  expect(SearchDedupe.key("research_search", { query: "protein folding", limit: 4 })).toBe(
    SearchDedupe.key("websearch", { query: "protein folding", numResults: 4 }),
  )
})

test("does not dedupe dynamic unavailable or exhausted search results", () => {
  const dynamic = (
    type: "search_unavailable" | "search_allowance_exhausted",
    retryable?: boolean,
  ): MessageV2.WithParts => ({
    ...message,
    parts: [
      {
        ...part,
        tool: "research_search",
        state: {
          status: "completed",
          input: {
            query: "protein folding",
            source: "web",
            mode: "balanced",
            limit: 4,
            content: "snippets",
          },
          output: JSON.stringify({
            status: "completed",
            type,
            retryable,
            alternatives: ["science_search", "science_fetch", "WebFetch"],
          }),
          title: "Gateway search unavailable",
          metadata: {},
          time: { start: 100, end: 150 },
        },
      },
    ],
  })
  for (const prior of [
    dynamic("search_unavailable", true),
    dynamic("search_unavailable", false),
    dynamic("search_allowance_exhausted"),
  ]) {
    expect(
      SearchDedupe.find([prior], "research_search", {
        query: "protein folding",
        source: "web",
        mode: "balanced",
        limit: 4,
        content: "snippets",
      }),
    ).toBeUndefined()
  }
})
