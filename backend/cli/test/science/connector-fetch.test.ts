import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { registry } from "../../src/science/connectors"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { outcomeFor, type FetchOutcome } from "../../src/science/connectors/fetch-outcome"
import { arxiv } from "../../src/science/connectors/literature/arxiv"

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const FIXTURES = path.join(import.meta.dir, "fixtures/fetch")

// What the live recorder (script/record-fetch-fixtures.ts) actually observed,
// reproduced identically across three separate runs. Every fixture-bearing
// connector not listed here returned "record".
const EXPECTED: Record<string, FetchOutcome["kind"]> = {
  biogrid: "error",
  depmap: "miss",
  "expression-atlas": "miss",
}

describe("connector fetch conformance", () => {
  const connectors = registry.all()

  test("the registry is fully populated", () => {
    expect(connectors.length).toBe(42)
  })

  // Each fixture is one connector's REAL recorded response. Replaying it through
  // outcomeFor is what makes these 5.3MB load-bearing: it proves the sentinel
  // logic classifies 40 genuine API shapes correctly, which is the risk
  // fetch-outcome.ts calls load-bearing -- a false-positive found/error sentinel
  // turning a real record into a phantom miss.
  for (const c of connectors) {
    const file = path.join(FIXTURES, `${c.id}.json`)
    if (!existsSync(file)) continue // myvariant + semantic-scholar threw live; asserted below

    test(`${c.id} classifies its recorded response`, () => {
      const { id, payload } = JSON.parse(readFileSync(file, "utf8"))
      const outcome = outcomeFor({ db: c.id, id, payload })
      expect(outcome.kind).toBe(EXPECTED[c.id] ?? "record")
      if (outcome.kind === "record") expect(outcome.disposition).toBe(outcome.bytes > 50 * 1024 ? "spill" : "inline")
    })
  }

  test("myvariant and semantic-scholar produced no fixture in the live run", () => {
    for (const id of ["myvariant", "semantic-scholar"]) expect(existsSync(path.join(FIXTURES, `${id}.json`))).toBe(false)
  })

  // Assert arxiv's documented contract explicitly rather than exempting it above.
  test("arxiv rejects a non-Atom body instead of returning a bogus record", async () => {
    globalThis.fetch = (async () =>
      new Response("<html><body>503 Service Temporarily Unavailable</body></html>", {
        status: 200,
      })) as unknown as typeof fetch
    await expect(arxiv.fetch("1706.03762")).rejects.toThrow(/non-Atom/)
  })
})
