import { beforeEach, expect, test } from "bun:test"
import { europepmc } from "../../src/science/connectors/literature/europepmc"
import { intact } from "../../src/science/connectors/pathways/intact"
import { clearCache, withHttpTestPolicy } from "../../src/science/connectors/http"

beforeEach(clearCache)
const resolveAddresses = async () => ["93.184.216.34"]

test("Europe PMC bare PMIDs are exact MED identifiers, never free text searches", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async (url) => {
        expect(url.searchParams.get("query")).toBe("EXT_ID:10508479 AND SRC:MED")
        return Response.json({ resultList: { result: [{ id: "10508479", source: "MED", title: "Correct PMID" }] } })
      },
    },
    async () => {
      expect(await europepmc.fetch("10508479")).toMatchObject({ id: "10508479", source: "MED" })
    },
  )
})

test("Europe PMC only returns the requested source and accession", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () =>
        Response.json({
          resultList: {
            result: [
              { id: "37466043", source: "MED", pmcid: "PMC10508479" },
              { id: "10508479", source: "AGR" },
            ],
          },
        }),
    },
    async () => {
      expect(await europepmc.fetch("MED/10508479")).toBeNull()
    },
  )
})

test("Europe PMC search hit IDs roundtrip through the declared source", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () =>
        Response.json({ resultList: { result: [{ id: "10508479", source: "MED", title: "Exact paper" }] } }),
    },
    async () => {
      const hits = await europepmc.search("Exact paper")
      expect(hits[0]!.id).toBe("MED/10508479")
      expect(await europepmc.fetch(hits[0]!.id)).toMatchObject({ title: "Exact paper" })
    },
  )
})

test("IntAct fetch never substitutes the first related interaction for a missing accession", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () => Response.json({ content: [{ ac: "EBI-15982574", idA: "P05067", idB: "P04637" }] }),
    },
    async () => {
      expect(await intact.fetch("EBI-77613")).toBeNull()
      expect(await intact.fetch("EBI-15982574")).toMatchObject({ ac: "EBI-15982574" })
    },
  )
})

test("IntAct search IDs roundtrip and malformed source identities fail", async () => {
  let valid = true
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () => Response.json({ content: [valid ? { ac: "EBI-15982574" } : { idA: "A", idB: "B" }] }),
    },
    async () => {
      const hits = await intact.search("P04637")
      expect(await intact.fetch(hits[0]!.id)).toMatchObject({ ac: "EBI-15982574" })
      valid = false
      clearCache()
      await expect(intact.search("P04637")).rejects.toThrow("retrievable accession")
    },
  )
})

test("Europe PMC rejects a free-text query in its exact identifier interface", async () => {
  await expect(europepmc.fetch("MED/10508479 OR EXT_ID:*")).rejects.toThrow("namespaced search ID")
})
