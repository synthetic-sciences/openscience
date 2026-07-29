import { describe, expect, test } from "bun:test"
import {
  sentinelOf,
  classifyError,
  safeSegment,
  filenameFor,
  summarize,
  outcomeFor,
} from "../../src/science/connectors/fetch-outcome"

// The four "not found" conventions the 42 connectors actually use, confirmed by
// executing every fetch() against live APIs. Three are misses; {error} is a real
// failure (biogrid returns it when BIOGRID_ACCESS_KEY is unset).
describe("sentinelOf", () => {
  test("null is a miss", () => {
    expect(sentinelOf(null)?.kind).toBe("miss")
  })

  test("an empty object is a miss", () => {
    expect(sentinelOf({})?.kind).toBe("miss")
  })

  test("found:false is a miss", () => {
    expect(sentinelOf({ id: "E-MTAB-1", found: false })?.kind).toBe("miss")
  })

  test("an error string is an error, not a miss", () => {
    const out = sentinelOf({ id: "7157", error: "BioGRID access key required" })
    expect(out?.kind).toBe("error")
    expect(out?.note).toBe("BioGRID access key required")
  })

  test("a real record is not a sentinel", () => {
    expect(sentinelOf({ struct: { title: "Crystal structure" } })).toBeNull()
  })

  test("an empty array is a miss but a populated one is not", () => {
    expect(sentinelOf([])?.kind).toBe("miss")
    expect(sentinelOf([{ pdbUrl: "x" }])).toBeNull()
  })
})

describe("classifyError", () => {
  test("429 is retryable", () => {
    expect(classifyError(new Error("HTTP 429 for https://api.semanticscholar.org")).retryable).toBe(true)
  })

  test("404 is not retryable", () => {
    expect(classifyError(new Error("HTTP 404 for https://myvariant.info")).retryable).toBe(false)
  })
})

// Real ids from the connector set: crossref uses a DOI (slash), kegg uses
// "hsa:7157" (colon), myvariant uses HGVS (colon + angle bracket). Colons and
// backslashes are illegal on Windows, which this project ships binaries for.
describe("safeSegment", () => {
  test("strips slashes from a DOI", () => {
    expect(safeSegment("10.1038/nature12373")).toBe("10.1038_nature12373")
  })

  test("strips colons from a kegg id", () => {
    expect(safeSegment("hsa:7157")).toBe("hsa_7157")
  })

  test("strips angle brackets from an HGVS id", () => {
    expect(safeSegment("chr7:g.140453134A>T")).toBe("chr7_g.140453134A_T")
  })

  test("never returns an empty segment", () => {
    expect(safeSegment("///")).toBe("record")
  })
})

describe("filenameFor", () => {
  test("defaults to json under the db directory", () => {
    expect(filenameFor("crossref", "10.1038/nature12373")).toBe(".openscience/fetch/crossref/10.1038_nature12373.json")
  })

  test("uses the requested format as the extension", () => {
    expect(filenameFor("rcsb-pdb", "6LU7", "cif")).toBe(".openscience/fetch/rcsb-pdb/6LU7.cif")
  })
})

describe("summarize", () => {
  test("lists top-level keys for a record", () => {
    expect(summarize({ struct: {}, rcsb_entry_info: {} })).toBe("struct, rcsb_entry_info")
  })

  test("heads the content for a file", () => {
    expect(summarize("data_6LU7\nloop_\n_atom_site", "cif")).toBe("data_6LU7 loop_ _atom_site")
  })
})

describe("outcomeFor", () => {
  test("a small record goes inline", () => {
    const out = outcomeFor({ db: "chembl", id: "CHEMBL25", payload: { pref_name: "ASPIRIN" } })
    expect(out.kind).toBe("record")
    if (out.kind === "record") expect(out.disposition).toBe("inline")
  })

  test("a record over the cap spills", () => {
    const out = outcomeFor({ db: "mygene", id: "7157", payload: { blob: "x".repeat(60_000) } })
    expect(out.kind).toBe("record")
    if (out.kind === "record") expect(out.disposition).toBe("spill")
  })

  test("a file always spills regardless of size", () => {
    const out = outcomeFor({ db: "rcsb-pdb", id: "6LU7", format: "cif", payload: "tiny" })
    expect(out.kind).toBe("file")
    if (out.kind === "file") expect(out.filename).toBe(".openscience/fetch/rcsb-pdb/6LU7.cif")
  })

  test("a sentinel short-circuits before serialisation", () => {
    expect(outcomeFor({ db: "depmap", id: "CRISPR", payload: { found: false } }).kind).toBe("miss")
  })

  test("an error sentinel becomes an error outcome", () => {
    const out = outcomeFor({ db: "biogrid", id: "7157", payload: { id: "7157", error: "key required" } })
    expect(out.kind).toBe("error")
  })
})
