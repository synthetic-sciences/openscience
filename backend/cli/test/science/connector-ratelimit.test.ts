import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { semanticScholar } from "../../src/science/connectors/literature/semantic-scholar"
import { dbsnp } from "../../src/science/connectors/genomics/dbsnp"
import { pubmed } from "../../src/science/connectors/literature/pubmed"
import { geo } from "../../src/science/connectors/omics/geo"

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// science_fetch makes back-to-back record retrieval an ordinary action, and a
// second full pass over the connector set trips Semantic Scholar's keyless
// limiter. These assertions are on observed pacing, not on source text: the
// rateLimit option is consumed inside http.ts and never reaches globalThis.fetch,
// so the only honest way to test it is to measure the delay it imposes.
//
// Every call below uses a DISTINCT id. The http cache is keyed by `${method} ${url}`
// (http.ts:164), so identical ids would be served from cache and never paced.
describe("rate limits on the hosts that need them", () => {
  test("semantic-scholar paces successive requests about a second apart", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ paperId: "x", title: "t" }), { status: 200 })) as unknown as typeof fetch
    const started = Date.now()
    await semanticScholar.fetch("1111111111111111111111111111111111111111")
    await semanticScholar.fetch("2222222222222222222222222222222222222222")
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  // Prime the shared host's limiter with one paced request, then time the target
  // consumer in isolation. An UNPACED consumer returns immediately; a paced one
  // must wait out the 350ms interval. Timing each separately is what lets this
  // fail when exactly ONE consumer loses its rateLimit — a single cumulative
  // measurement cannot attribute the delay to any particular consumer.
  test("geo is paced against the shared eutils host", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })) as unknown as typeof fetch
    await dbsnp.fetch("rs334")
    const started = Date.now()
    await geo.fetch("GSE1000")
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })

  test("pubmed is paced against the shared eutils host", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })) as unknown as typeof fetch
    await dbsnp.fetch("rs1801133")
    const started = Date.now()
    await pubmed.fetch("10508479")
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })

  test("the eutils module itself is paced", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })) as unknown as typeof fetch
    await pubmed.fetch("9999999")
    const started = Date.now()
    await dbsnp.fetch("rs429358")
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })
})
