import { beforeEach, describe, expect, test } from "bun:test"
import { clearCache, resetRateLimits, withHttpTestPolicy } from "../../src/science/connectors/http"
import { semanticScholar } from "../../src/science/connectors/literature/semantic-scholar"
import { dbsnp } from "../../src/science/connectors/genomics/dbsnp"
import { pubmed } from "../../src/science/connectors/literature/pubmed"
import { geo } from "../../src/science/connectors/omics/geo"

const publicResolution = async () => ["93.184.216.34"]

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

// science_fetch makes back-to-back record retrieval an ordinary action, and a
// second full pass over the connector set trips Semantic Scholar's keyless
// limiter. These assertions are on observed pacing, not on source text: the
// rateLimit option is consumed inside http.ts and never reaches globalThis.fetch,
// so the only honest way to test it is to measure the delay it imposes.
//
// Every call below uses a DISTINCT id. The http cache is keyed by `${method} ${url}`
// (http.ts:164), so identical ids would be served from cache and never paced.
// Request starts are recorded on the monotonic clock: wall time can be adjusted
// independently by the OS or Bun's setSystemTime() in another backend test, while
// the timer that enforces the interval continues to advance monotonically. The
// scoped policy also prevents concurrent test files from replacing global fetch
// or resetting the limiter underneath these requests.
describe("rate limits on the hosts that need them", () => {
  test("semantic-scholar paces successive requests about a second apart", async () => {
    const starts: number[] = []
    await withHttpTestPolicy(
      {
        resolveAddresses: publicResolution,
        transport: async () => {
          starts.push(performance.now())
          return new Response(JSON.stringify({ paperId: "x", title: "t" }), { status: 200 })
        },
      },
      async () => {
        await semanticScholar.fetch("1111111111111111111111111111111111111111")
        await semanticScholar.fetch("2222222222222222222222222222222222222222")
      },
    )
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(900)
  })

  // Prime the shared host's limiter with one paced request, then observe request
  // START times inside the transport. The contract spaces starts, so measuring
  // only after the prime response returns wrongly subtracts DNS/response time
  // from the expected interval and becomes load-dependent in the full suite.
  test("geo is paced against the shared eutils host", async () => {
    const starts: number[] = []
    await withHttpTestPolicy(
      {
        resolveAddresses: publicResolution,
        transport: async () => {
          starts.push(performance.now())
          return new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })
        },
      },
      async () => {
        await dbsnp.fetch("rs334")
        await geo.fetch("GSE1000")
      },
    )
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(300)
  })

  test("pubmed is paced against the shared eutils host", async () => {
    const starts: number[] = []
    await withHttpTestPolicy(
      {
        resolveAddresses: publicResolution,
        transport: async () => {
          starts.push(performance.now())
          return new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })
        },
      },
      async () => {
        await dbsnp.fetch("rs1801133")
        await pubmed.fetch("10508479")
      },
    )
    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(300)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(300)
  })

  test("the eutils module itself is paced", async () => {
    const starts: number[] = []
    await withHttpTestPolicy(
      {
        resolveAddresses: publicResolution,
        transport: async () => {
          starts.push(performance.now())
          return new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })
        },
      },
      async () => {
        await pubmed.fetch("9999999")
        await dbsnp.fetch("rs429358")
      },
    )
    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(300)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(300)
  })
})
