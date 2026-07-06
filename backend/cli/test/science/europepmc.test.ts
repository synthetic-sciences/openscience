import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { europepmc } from "../../src/science/connectors/literature/europepmc"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("europepmc connector", () => {
  // Europe PMC's resultType=core records carry the journal name at
  // journalInfo.journal.title, not a top-level journalTitle field.
  test("surfaces the journal name from journalInfo.journal.title", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          resultList: {
            result: [
              {
                id: "12345678",
                source: "MED",
                title: "A study of things",
                authorString: "Doe J, Smith A.",
                pubYear: "2024",
                journalInfo: { journal: { title: "The New England Journal of Medicine" } },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const hits = await europepmc.search("things", { limit: 1 })
    // With no abstract, the summary falls back to the author/journal/year meta line.
    expect(hits[0]?.summary).toContain("The New England Journal of Medicine")
  })
})
