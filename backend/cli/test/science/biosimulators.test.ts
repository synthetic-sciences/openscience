import { beforeEach, expect, test } from "bun:test"
import { biosimulators } from "../../src/science/connectors/pathways/biosimulators"
import { clearCache, withHttpTestPolicy } from "../../src/science/connectors/http"
import catalog from "./fixtures/biosimulators-search.json"
import record from "./fixtures/fetch/biosimulators.json"

beforeEach(clearCache)
const resolveAddresses = async () => ["93.184.216.34"]

// Search fields recorded from /simulators/latest on 2026-10-02. The fetch
// fixture retains the complete public Tellurium 2.2.10 record.
test("BioSimulators searches names, algorithm names/IDs, and all four model formats", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async (url) => {
        expect(url.pathname).toBe("/simulators/latest")
        expect(url.searchParams.get("includeTests")).toBe("false")
        return Response.json(catalog)
      },
    },
    async () => {
      for (const [query, id] of [
        ["Tellurium", "tellurium"],
        ["cvode", "tellurium"],
        ["KISAO:0000019", "tellurium"],
        ["KISAO_0000019", "tellurium"],
        ["SBML CVODE", "tellurium"],
        ["CellML", "opencor"],
        ["NeuroML", "neuron"],
        ["BNGL", "bionetgen"],
      ]) {
        const hits = await biosimulators.search(query!)
        expect(hits.some((hit) => hit.id.startsWith(`${id}/`))).toBe(true)
      }
      expect(await biosimulators.search("no-such-simulator")).toEqual([])
      expect(await biosimulators.search("CVODE", { limit: 1 })).toHaveLength(1)
      expect(await biosimulators.search("CVODE", { limit: 2 })).toHaveLength(2)
    },
  )
})

test("BioSimulators requires a format and algorithm to occur together", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () =>
        Response.json([
          {
            id: "split",
            name: "Split capabilities",
            version: "1",
            description: "SBML and CVODE",
            algorithms: [
              { name: "CVODE", kisaoId: { id: "KISAO_0000019" }, modelFormats: [{ id: "format_3240" }] },
              { name: "Euler", kisaoId: { id: "KISAO_0000030" }, modelFormats: [{ id: "format_2585" }] },
            ],
          },
        ]),
    },
    async () => {
      expect(await biosimulators.search("SBML CVODE")).toEqual([])
      expect(await biosimulators.search("CellML CVODE")).toHaveLength(1)
    },
  )
})

test("BioSimulators fetch accepts latest or exact versions and preserves search identity", async () => {
  const paths: string[] = []
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async (url) => {
        paths.push(url.pathname)
        return Response.json(url.pathname === "/simulators/latest" ? [record.payload] : record.payload)
      },
    },
    async () => {
      const [hit] = await biosimulators.search("tellurium")
      expect(hit!.id).toBe("tellurium/2.2.10")
      expect(await biosimulators.fetch(hit!.id)).toEqual(record.payload)
      expect(await biosimulators.fetch("tellurium")).toEqual(record.payload)
      expect(paths).toEqual(["/simulators/latest", "/simulators/tellurium/2.2.10", "/simulators/tellurium/latest"])
    },
  )
})

test("BioSimulators rejects malformed responses and never substitutes another version", async () => {
  await withHttpTestPolicy({ resolveAddresses, transport: async () => Response.json(record.payload) }, async () => {
    await expect(biosimulators.fetch("tellurium/2.2.8")).rejects.toThrow("requested simulator")
    await expect(biosimulators.fetch("other")).rejects.toThrow("requested simulator")
    await expect(biosimulators.search("tellurium")).rejects.toThrow("invalid simulator catalog")
  })
})

test("BioSimulators validates identifiers and avoids empty searches before network access", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () => {
        throw new Error("Unexpected request")
      },
    },
    async () => {
      expect(await biosimulators.search("  ")).toEqual([])
      for (const id of ["", "../latest", "tellurium/", "tellurium/a/b", "tellurium?x=1", "https://example.com"]) {
        await expect(biosimulators.fetch(id)).rejects.toThrow("BioSimulators identifier")
      }
    },
  )
})

test("BioSimulators propagates source errors and cancellation", async () => {
  await withHttpTestPolicy(
    { resolveAddresses, transport: async () => new Response("Not found", { status: 404 }) },
    async () => {
      await expect(biosimulators.fetch("missing")).rejects.toThrow("404")
    },
  )
  const controller = new AbortController()
  controller.abort()
  await expect(biosimulators.search("SBML", { signal: controller.signal })).rejects.toThrow()
  await expect(biosimulators.fetch("tellurium", { signal: controller.signal })).rejects.toThrow()
})
