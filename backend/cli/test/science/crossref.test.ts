import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { crossref } from "../../src/science/connectors/literature/crossref"
import { clearCache, resetRateLimits, withHttpTestPolicy } from "../../src/science/connectors/http"

// Crossref's "polite pool" only requires a contact address in the query string.
// The connector documented it for a long time without ever sending one.

const resolveAddresses = async () => ["93.184.216.34"]
const env = { CROSSREF_MAILTO: process.env.CROSSREF_MAILTO, OPENALEX_MAILTO: process.env.OPENALEX_MAILTO }

function restore(name: keyof typeof env) {
  const value = env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function requested(action: () => Promise<unknown>): Promise<URL[]> {
  const urls: URL[] = []
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async (url) => {
        urls.push(new URL(url.href))
        return Response.json({ message: { items: [], DOI: "10.1038/test" } })
      },
    },
    action,
  )
  return urls
}

beforeEach(() => {
  clearCache()
  resetRateLimits()
  delete process.env.CROSSREF_MAILTO
  delete process.env.OPENALEX_MAILTO
})

afterEach(() => {
  restore("CROSSREF_MAILTO")
  restore("OPENALEX_MAILTO")
})

describe("crossref polite pool", () => {
  test("search and fetch stay anonymous when no contact address is configured", async () => {
    const urls = await requested(async () => {
      await crossref.search("attention is all you need", { limit: 1 })
      await crossref.fetch("10.1038/test")
    })
    expect(urls).toHaveLength(2)
    for (const url of urls) expect(url.searchParams.has("mailto")).toBe(false)
    expect(urls[1]!.search).toBe("")
  })

  test("CROSSREF_MAILTO joins the polite pool on search and fetch", async () => {
    process.env.CROSSREF_MAILTO = " lab@example.org "
    const urls = await requested(async () => {
      await crossref.search("attention is all you need", { limit: 1 })
      await crossref.fetch("https://doi.org/10.1038/test")
    })
    expect(urls).toHaveLength(2)
    for (const url of urls) expect(url.searchParams.get("mailto")).toBe("lab@example.org")
    expect(urls[0]!.searchParams.get("rows")).toBe("1")
    expect(urls[1]!.pathname).toBe("/works/10.1038%2Ftest")
  })

  test("falls back to the OpenAlex contact address, with Crossref's own taking precedence", async () => {
    process.env.OPENALEX_MAILTO = "openalex@example.org"
    const fallback = await requested(() => crossref.search("query", { limit: 1 }))
    expect(fallback[0]!.searchParams.get("mailto")).toBe("openalex@example.org")

    clearCache()
    process.env.CROSSREF_MAILTO = "crossref@example.org"
    const explicit = await requested(() => crossref.search("query", { limit: 1 }))
    expect(explicit[0]!.searchParams.get("mailto")).toBe("crossref@example.org")
  })
})
