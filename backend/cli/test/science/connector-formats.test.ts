import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rcsbPdb } from "../../src/science/connectors/proteins/rcsb-pdb"
import { pdbe } from "../../src/science/connectors/proteins/pdbe"
import { alphafold } from "../../src/science/connectors/proteins/alphafold"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { uniprot } from "../../src/science/connectors/proteins/uniprot"
import { pubchem } from "../../src/science/connectors/chemistry/pubchem"
import { ensembl } from "../../src/science/connectors/genomics/ensembl"
import { kegg } from "../../src/science/connectors/pathways/kegg"

const realFetch = globalThis.fetch

function stub(body: string): { url: () => string } {
  let seen = ""
  globalThis.fetch = (async (url: string) => {
    seen = String(url)
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { url: () => seen }
}

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("rcsb-pdb fetchFile", () => {
  test("declares pdb and cif but never json", () => {
    expect(rcsbPdb.formats).toEqual(["pdb", "cif"])
    expect(rcsbPdb.formats).not.toContain("json")
  })

  test("cif comes from files.rcsb.org, not the JSON data API", async () => {
    const s = stub("data_6LU7\nloop_\n")
    const out = await rcsbPdb.fetchFile!("6LU7", "cif")
    expect(s.url()).toBe("https://files.rcsb.org/download/6LU7.cif")
    expect(out.filename).toBe("6LU7.cif")
    expect(out.body).toContain("data_6LU7")
  })

  test("uppercases the id for the file server", async () => {
    const s = stub("data_6LU7\nloop_\n")
    const out = await rcsbPdb.fetchFile!("6lu7", "cif")
    expect(s.url()).toBe("https://files.rcsb.org/download/6LU7.cif")
    expect(out.filename).toBe("6LU7.cif")
  })

  test("pdb uses the .pdb extension on the same host", async () => {
    const s = stub("HEADER    VIRAL PROTEIN")
    await rcsbPdb.fetchFile!("6LU7", "pdb")
    expect(s.url()).toBe("https://files.rcsb.org/download/6LU7.pdb")
  })
})

describe("pdbe fetchFile", () => {
  test("declares cif only", () => {
    expect(pdbe.formats).toEqual(["cif"])
  })

  test("lowercases the id and hits the entry-files endpoint", async () => {
    const s = stub("data_6lu7\n")
    const out = await pdbe.fetchFile!("6LU7", "cif")
    expect(s.url()).toBe("https://www.ebi.ac.uk/pdbe/entry-files/download/6lu7.cif")
    expect(out.filename).toBe("6lu7.cif")
  })
})

describe("alphafold fetchFile", () => {
  test("declares pdb and cif", () => {
    expect(alphafold.formats).toEqual(["pdb", "cif"])
  })

  test("reads the file URL out of the JSON response, then fetches it", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      // First call: the prediction API, which returns an ARRAY.
      if (urls.length === 1)
        return new Response(
          JSON.stringify([
            { entryId: "AF-P04637-F1", cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.cif" },
          ]),
          { status: 200 },
        )
      return new Response("data_AF-P04637-F1\n", { status: 200 })
    }) as unknown as typeof fetch

    const out = await alphafold.fetchFile!("P04637", "cif")
    expect(urls[0]).toContain("alphafold.ebi.ac.uk/api/prediction/P04637")
    expect(urls[1]).toBe("https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.cif")
    expect(out.filename).toBe("AF-P04637-F1-model_v4.cif")
    expect(out.body).toContain("data_AF-P04637-F1")
  })

  test("a prediction without the requested URL is an actionable error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ entryId: "AF-X-F1" }]), { status: 200 })) as unknown as typeof fetch
    await expect(alphafold.fetchFile!("P04637", "cif")).rejects.toThrow(/no cif/i)
  })
})

describe("query-param, path-segment, path and suffix formats", () => {
  test("uniprot uses a format query param", async () => {
    const s = stub(">sp|P04637|P53_HUMAN\nMEEPQSDPSV\n")
    const out = await uniprot.fetchFile!("P04637", "fasta")
    expect(s.url()).toBe("https://rest.uniprot.org/uniprotkb/P04637?format=fasta")
    expect(out.filename).toBe("P04637.fasta")
    expect(uniprot.formats).toEqual(["fasta", "txt"])
  })

  test("pubchem uses an uppercase path segment", async () => {
    const s = stub("2244\n  -OEChem-\n")
    const out = await pubchem.fetchFile!("2244", "sdf")
    expect(s.url()).toBe("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/SDF")
    expect(out.filename).toBe("2244.sdf")
    expect(pubchem.formats).toEqual(["sdf"])
  })

  test("ensembl uses a different path with a fasta content-type", async () => {
    const s = stub(">ENSG00000141510\nACGT\n")
    const out = await ensembl.fetchFile!("ENSG00000141510", "fasta")
    expect(s.url()).toBe("https://rest.ensembl.org/sequence/id/ENSG00000141510?content-type=text/x-fasta")
    expect(out.filename).toBe("ENSG00000141510.fasta")
    expect(ensembl.formats).toEqual(["fasta"])
  })

  test("kegg uses an aaseq path suffix", async () => {
    const s = stub(">hsa:7157 TP53\nMEEPQSDPSV\n")
    const out = await kegg.fetchFile!("hsa:7157", "fasta")
    expect(s.url()).toBe("https://rest.kegg.jp/get/hsa%3A7157/aaseq")
    expect(out.filename).toBe("hsa_7157.fasta")
    expect(kegg.formats).toEqual(["fasta"])
  })
})
