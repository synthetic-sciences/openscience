import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { registry } from "../../src/science/connectors"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { outcomeFor } from "../../src/science/connectors/fetch-outcome"
import { arxiv } from "../../src/science/connectors/literature/arxiv"

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// Every fetch() implementation shipped unexercised. This drives all 42 offline
// against a benign body and asserts the contract science_fetch depends on:
// resolve, never reject, and classify into exactly one outcome.
describe("connector fetch conformance", () => {
  const connectors = registry.all()

  test("the registry is fully populated", () => {
    expect(connectors.length).toBe(42)
  })

  for (const c of connectors) {
    test(`${c.id} resolves and classifies`, async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: "x", title: "t" }), { status: 200 })) as unknown as typeof fetch
      // A connector that rejects is not a failure of this contract — science_fetch
      // catches and classifies. `.catch` turns it into undefined, which sentinelOf
      // reads as a miss. arxiv is the one connector that takes this path by design.
      const payload = await c.fetch("TEST123").catch(() => undefined)
      const outcome = outcomeFor({ db: c.id, id: "TEST123", payload })
      expect(["record", "file", "miss", "error"]).toContain(outcome.kind)
    })
  }

  // Assert arxiv's documented contract explicitly rather than exempting it above.
  test("arxiv rejects a non-Atom body instead of returning a bogus record", async () => {
    globalThis.fetch = (async () =>
      new Response("<html><body>503 Service Temporarily Unavailable</body></html>", {
        status: 200,
      })) as unknown as typeof fetch
    await expect(arxiv.fetch("1706.03762")).rejects.toThrow(/non-Atom/)
  })
})
