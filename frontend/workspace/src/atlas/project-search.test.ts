import { describe, expect, test } from "bun:test"
import { requestProjectSearch, type ProjectSearchHits } from "./project-search"

const empty: ProjectSearchHits = { sessions: [], messages: [], files: [], artifacts: [] }

describe("project search transport", () => {
  test("keeps a genuine empty result distinct from an unavailable search", async () => {
    const result = await requestProjectSearch(
      async () => new Response(JSON.stringify(empty), { status: 200, headers: { "content-type": "application/json" } }),
    )

    expect(result).toEqual(empty)
  })

  test("treats an older backend without workspace-file hits as an empty file group", async () => {
    const legacy = { sessions: [], messages: [], artifacts: [] }
    const result = await requestProjectSearch(
      async () =>
        new Response(JSON.stringify(legacy), { status: 200, headers: { "content-type": "application/json" } }),
    )

    expect(result).toEqual(empty)
  })

  test("rejects non-OK and unreachable searches so the UI can offer recovery", async () => {
    await expect(requestProjectSearch(async () => new Response("offline", { status: 503 }))).rejects.toThrow(
      "Search failed (503)",
    )
    await expect(requestProjectSearch(async () => Promise.reject(new Error("network unavailable")))).rejects.toThrow(
      "network unavailable",
    )
  })
})
