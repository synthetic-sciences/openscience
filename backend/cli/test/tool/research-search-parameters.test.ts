import { describe, expect, test } from "bun:test"
import { ResearchSearchParameters } from "../../src/tool/research-search"
import { SearchDedupe } from "../../src/session/search-dedupe"

describe("research search parameter contract", () => {
  test("defaults stay backward compatible", () => {
    expect(ResearchSearchParameters.parse({ query: " protein folding " })).toEqual({
      query: "protein folding",
      source: "web",
      mode: "balanced",
      limit: 8,
      content: "snippets",
    })
  })

  test("every documented source, mode and content combination is valid", () => {
    for (const source of ["web", "research", "news", "developer"]) {
      for (const mode of ["fast", "balanced", "deep"]) {
        for (const content of ["snippets", "top"]) {
          expect(ResearchSearchParameters.parse({ query: "valid search", source, mode, content })).toMatchObject({
            source,
            mode,
            content,
          })
        }
      }
    }
  })

  test("public parameter schema does not expose full content or invented search modes", () => {
    expect(ResearchSearchParameters.safeParse({ query: "valid search", content: "full" }).success).toBe(false)
    expect(ResearchSearchParameters.safeParse({ query: "valid search", mode: "exhaustive" }).success).toBe(false)
  })

  test("date bounds accept real inclusive calendar dates and reject impossible dates", () => {
    expect(
      ResearchSearchParameters.parse({
        query: "leap day",
        published_after: "2024-02-29",
        published_before: "2024-02-29",
      }),
    ).toMatchObject({ published_after: "2024-02-29", published_before: "2024-02-29" })
    for (const date of [
      "2026-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-8-30",
      "2026-08-30T12:00:00Z",
      "yesterday",
    ]) {
      expect(ResearchSearchParameters.safeParse({ query: "date validation", published_after: date }).success).toBe(
        false,
      )
      expect(ResearchSearchParameters.safeParse({ query: "date validation", published_before: date }).success).toBe(
        false,
      )
    }
    expect(
      ResearchSearchParameters.safeParse({
        query: "backwards date",
        published_after: "2026-08-31",
        published_before: "2026-08-30",
      }).success,
    ).toBe(false)
  })

  test("hostname filters are source-independent and mutually exclusive", () => {
    for (const source of ["web", "research", "news", "developer"]) {
      expect(
        ResearchSearchParameters.safeParse({
          query: "python retries",
          source,
          include_domains: ["docs.python.org", "stackoverflow.com"],
        }).success,
      ).toBe(true)
      expect(
        ResearchSearchParameters.safeParse({ query: "python retries", source, exclude_domains: ["medium.com"] })
          .success,
      ).toBe(true)
      expect(
        ResearchSearchParameters.safeParse({
          query: "python retries",
          source,
          include_domains: ["docs.python.org"],
          exclude_domains: ["medium.com"],
        }).success,
      ).toBe(false)
    }
    for (const domain of ["https://example.com", "example.com/path", "example.com:443", "example .com", ""]) {
      expect(ResearchSearchParameters.safeParse({ query: "host validation", include_domains: [domain] }).success).toBe(
        false,
      )
    }
  })

  test("result, query, and filter limits are validated before dispatch", () => {
    for (const limit of [0, 11, 1.5])
      expect(ResearchSearchParameters.safeParse({ query: "valid search", limit }).success).toBe(false)
    for (const query of [" ", "x", "x".repeat(501)])
      expect(ResearchSearchParameters.safeParse({ query }).success).toBe(false)
    expect(
      ResearchSearchParameters.safeParse({
        query: "valid search",
        include_domains: Array.from({ length: 21 }, (_, index) => `site${index}.example`),
      }).success,
    ).toBe(false)
  })

  test("mode and content descriptions disclose enrichment limits and shared ranking", () => {
    expect(ResearchSearchParameters.shape.mode.description).toContain("same provider ranking")
    expect(ResearchSearchParameters.shape.mode.description).toContain("does not perform extra searches or reranking")
    expect(ResearchSearchParameters.shape.content.description).toContain("including fast")
    expect(ResearchSearchParameters.shape.content.description).toContain("not a full-document guarantee")
    expect(ResearchSearchParameters.shape.limit.description).toContain("effective limit at 3")
    expect(ResearchSearchParameters.shape.published_after.description).toContain(
      "not independently verified publication dates",
    )
  })

  test("legacy search normalization preserves explicit top content and date filters", () => {
    const normalized = SearchDedupe.normalize("websearch", {
      query: "protein folding",
      type: "fast",
      numResults: 5,
      content: "top",
      source: "developer",
      published_after: "2024-02-29",
    })
    expect(ResearchSearchParameters.parse(normalized)).toEqual({
      query: "protein folding",
      mode: "fast",
      limit: 5,
      content: "top",
      source: "developer",
      published_after: "2024-02-29",
    })
  })
})
