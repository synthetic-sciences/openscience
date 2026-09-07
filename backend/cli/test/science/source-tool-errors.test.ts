import { beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { registry } from "../../src/science/connectors"
import { clearCache, resetRateLimits, withHttpTestPolicy } from "../../src/science/connectors/http"
import { ScienceSearchTool, ScienceFetchTool } from "../../src/tool/science"
import { Instance } from "../../src/project/instance"

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
const context = {
  sessionID: "fixture",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}
beforeEach(() => {
  clearCache()
  resetRateLimits()
})

for (const connector of registry.all()) {
  for (const mode of ["search", "fetch"] as const) {
    test(`${connector.id} ${mode} tool exposes a source failure rather than absence`, async () => {
      await withHttpTestPolicy(
        {
          resolveAddresses: async () => ["93.184.216.34"],
          transport: async () => new Response("fixture unavailable", { status: 401 }),
        },
        () =>
          Instance.provide({
            directory: path.join(__dirname, "../.."),
            fn: async () => {
              const id = ids[connector.id] ?? "TP53"
              const result =
                mode === "search"
                  ? await (await ScienceSearchTool.init()).execute({ db: connector.id, query: id, limit: 1 }, context)
                  : await (await ScienceFetchTool.init()).execute({ db: connector.id, id }, context)
              expect(result.metadata.error).toBe("source_error")
              expect(result.output).not.toContain("No results")
              expect(result.output).not.toContain("has no record")
            },
          }),
      )
    })
  }
}
