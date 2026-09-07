import { beforeEach, describe, expect, test } from "bun:test"
import { registry } from "../../src/science/connectors"
import { clearCache, resetRateLimits, withHttpTestPolicy } from "../../src/science/connectors/http"
import { bindingdb } from "../../src/science/connectors/chemistry/bindingdb"
import { depmap } from "../../src/science/connectors/omics/depmap"
import { biogrid } from "../../src/science/connectors/pathways/biogrid"

const ids: Record<string, string> = {
  europepmc: "10508479",
  arxiv: "1706.03762",
  biorxiv: "10.1101/2020.01.01.123456",
  pubmed: "12345",
  crossref: "10.1038/test",
  bindingdb: "P00533",
  alphafold: "P00533",
  sifts: "P00533",
  uniprot: "P00533",
  "rcsb-pdb": "6LU7",
  pdbe: "6LU7",
  gnomad: "ENSG00000141510",
  ensembl: "ENSG00000141510",
  hpa: "ENSG00000141510",
  gtex: "ENSG00000141510",
  pubchem: "2244",
  dbsnp: "rs7412",
  myvariant: "rs7412",
  clinvar: "12345",
  "ncbi-gene": "7157",
  mygene: "7157",
  kegg: "hsa:7157",
}
const options = { limit: 1, params: { accessKey: "fixture-not-a-secret" } }
const resolveAddresses = async () => ["93.184.216.34"]
beforeEach(() => {
  clearCache()
  resetRateLimits()
})

for (const connector of registry.all()) {
  describe(connector.id, () => {
    for (const mode of ["search", "fetch"] as const) {
      for (const failure of ["unauthorized", "rate_limited", "html", "api_error"] as const) {
        test(`${mode} preserves ${failure} as source failure`, async () => {
          let calls = 0
          await withHttpTestPolicy(
            {
              resolveAddresses,
              transport: async () => {
                calls++
                if (failure === "unauthorized") return new Response("fixture unauthorized", { status: 401 })
                if (failure === "rate_limited")
                  return new Response("fixture limited", { status: 429, headers: { "Retry-After": "0" } })
                if (failure === "html") return new Response("<html>Verify you are human</html>")
                return Response.json({ errors: [{ message: "fixture upstream failure" }] })
              },
            },
            async () => {
              await expect(connector[mode](ids[connector.id] ?? "TP53", options)).rejects.toThrow()
            },
          )
          expect(calls).toBeGreaterThan(0)
        })
      }
    }
  })
}

test("BindingDB search IDs retrieve the same target/monomer pair", async () => {
  const urls: string[] = []
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async (url) => {
        urls.push(url.href)
        return Response.json({
          getLindsByUniprotsResponse: {
            affinities: [
              { monomerid: 123, query: "P00533", affinity_type: "IC50", affinity: "10" },
              { monomerid: 456, query: "P00533", affinity_type: "IC50", affinity: "20" },
            ],
          },
        })
      },
    },
    async () => {
      const hits = await bindingdb.search("P00533", { limit: 2 })
      expect(hits[0]!.id).toBe("uniprot:P00533:monomer:123")
      clearCache()
      const record = await bindingdb.fetch(hits[0]!.id)
      expect(record).toMatchObject({ target_uniprot: "P00533", monomerid: "123", affinities: [{ monomerid: 123 }] })
      expect(urls).toHaveLength(2)
      expect(urls.every((url) => new URL(url).searchParams.get("uniprot") === "P00533")).toBe(true)
      await expect(bindingdb.fetch("123")).rejects.toThrow("search hit ID")
    },
  )
})

test("DepMap rejects a malformed catalog without poisoning later valid data", async () => {
  let calls = 0
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () => {
        calls++
        return new Response(
          calls === 1 ? "<html>Verify you are human</html>" : "release,release_date,filename,url,md5_hash\r\n",
        )
      },
    },
    async () => {
      await expect(depmap.search("CRISPR")).rejects.toThrow()
      expect(await depmap.search("CRISPR")).toEqual([])
      expect(await depmap.fetch("missing")).toEqual({ id: "missing", found: false })
    },
  )
  expect(calls).toBe(2)
})

test("BioGRID missing credentials are not an empty search", async () => {
  const prior = process.env.BIOGRID_ACCESS_KEY
  delete process.env.BIOGRID_ACCESS_KEY
  try {
    await expect(biogrid.search("TP53")).rejects.toThrow("access key required")
  } finally {
    if (prior !== undefined) process.env.BIOGRID_ACCESS_KEY = prior
  }
})

for (const connector of registry.all()) {
  for (const mode of ["search", "fetch"] as const) {
    test(`${connector.id} ${mode} preserves caller cancellation before a request`, async () => {
      const controller = new AbortController()
      controller.abort(new Error("fixture caller cancelled"))
      let calls = 0
      await withHttpTestPolicy(
        {
          resolveAddresses,
          transport: async () => {
            calls++
            throw new Error("cancelled request reached transport")
          },
        },
        async () => {
          await expect(
            connector[mode](ids[connector.id] ?? "TP53", { ...options, signal: controller.signal }),
          ).rejects.toThrow("fixture caller cancelled")
        },
      )
      expect(calls).toBe(0)
    })
  }
  for (const format of connector.formats ?? []) {
    for (const failure of ["unauthorized", "html", "api_error"] as const) {
      test(`${connector.id} ${format} file preserves ${failure} as source failure`, async () => {
        let calls = 0
        await withHttpTestPolicy(
          {
            resolveAddresses,
            transport: async () => {
              calls++
              if (failure === "unauthorized") return new Response("fixture unauthorized", { status: 401 })
              if (failure === "html") return new Response("<html>Verify you are human</html>")
              return Response.json({ error: "fixture upstream failure" })
            },
          },
          async () => {
            expect(connector.fetchFile).toBeDefined()
            await expect(connector.fetchFile!(ids[connector.id] ?? "TP53", format, options)).rejects.toThrow()
          },
        )
        expect(calls).toBeGreaterThan(0)
      })
    }
  }
}

test("BindingDB refuses malformed source identities instead of publishing an unfetchable hit", async () => {
  await withHttpTestPolicy(
    { resolveAddresses, transport: async () => Response.json({ getLindsByUniprotsResponse: { affinities: [{}] } }) },
    async () => {
      await expect(bindingdb.search("P00533")).rejects.toThrow("monomer identifier")
    },
  )
})

test("BioGRID failures do not expose the access key echoed by the source", async () => {
  const secret = "fixture-secret-do-not-disclose"
  for (const status of [401, 200]) {
    await withHttpTestPolicy(
      { resolveAddresses, transport: async () => Response.json({ error: `bad accessKey: ${secret}` }, { status }) },
      async () => {
        try {
          await biogrid.search("TP53", { params: { accessKey: secret } })
          throw new Error("expected source failure")
        } catch (error) {
          expect(String(error)).toContain("[REDACTED]")
          expect(String(error)).not.toContain(secret)
        }
      },
    )
  }
})

test("BindingDB documented successful empty response remains an ordinary missing target", async () => {
  await withHttpTestPolicy(
    { resolveAddresses, transport: async () => new Response("", { headers: { "Content-Type": "application/json" } }) },
    async () => {
      expect(await bindingdb.search("P00533")).toEqual([])
      expect(await bindingdb.fetch("P00533")).toEqual({ id: "P00533", found: false })
    },
  )
})
