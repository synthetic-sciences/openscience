#!/usr/bin/env bun
/**
 * Records live fixtures for every connector's fetch(). Run by hand, never in CI:
 *
 *   bun run script/record-fetch-fixtures.ts
 *
 * Writes test/science/fixtures/fetch/<db>.json and prints a per-connector
 * report. Failures here are findings, not bugs in this script — several
 * connectors are known-degraded (biogrid needs BIOGRID_ACCESS_KEY; depmap can
 * be served a bot-verification page).
 */
import fs from "node:fs/promises"
import path from "node:path"
import { registry } from "../src/science/connectors"
import { outcomeFor, formatBytes } from "../src/science/connectors/fetch-outcome"

// Copied from PROTOTYPE-fetch-repl.ts, which carries all 42 entries.
const SAMPLE: Record<string, string> = {
  uniprot: "P04637",
  "rcsb-pdb": "6LU7",
  pdbe: "6lu7",
  alphafold: "P04637",
  interpro: "IPR000001",
  pfam: "PF00001",
  sifts: "P04637",
  ensembl: "ENSG00000141510",
  "ncbi-gene": "7157",
  dbsnp: "rs334",
  clinvar: "12345",
  gnomad: "ENSG00000141510",
  ucsc: "chr17:7668402-7687550",
  mygene: "7157",
  myvariant: "chr7:g.140453134A>T",
  chembl: "CHEMBL25",
  pubchem: "2244",
  bindingdb: "P04637",
  gtopdb: "4139",
  surechembl: "1",
  chebi: "CHEBI:15377",
  reactome: "R-HSA-68886",
  kegg: "hsa:7157",
  "string-db": "9606.ENSP00000269305",
  biogrid: "7157",
  intact: "EBI-77613",
  wikipathways: "WP554",
  opentargets: "ENSG00000141510",
  pubmed: "10508479",
  europepmc: "10508479",
  biorxiv: "10.1101/2020.01.30.927871",
  crossref: "10.1038/nature12373",
  openalex: "W2741809807",
  "semantic-scholar": "649def34f8be52c8b66281af98ae884c09aef38b",
  arxiv: "1706.03762",
  geo: "GSE1000",
  arrayexpress: "E-MTAB-1234",
  gtex: "ENSG00000141510",
  hpa: "ENSG00000141510",
  "expression-atlas": "E-MTAB-5214",
  "single-cell-atlas": "E-MTAB-5061",
  depmap: "CRISPR",
}

const out = path.resolve(import.meta.dir, "../test/science/fixtures/fetch")
await fs.mkdir(out, { recursive: true })

let ok = 0
for (const c of registry.all()) {
  const id = SAMPLE[c.id] ?? ""
  const started = performance.now()
  try {
    const payload = await c.fetch(id, { signal: AbortSignal.timeout(30_000) })
    const outcome = outcomeFor({ db: c.id, id, payload })
    const ms = Math.round(performance.now() - started)
    await fs.writeFile(path.join(out, `${c.id}.json`), JSON.stringify({ id, payload }, null, 2))
    const size = outcome.kind === "record" || outcome.kind === "file" ? formatBytes(outcome.bytes) : "-"
    console.log(`${c.id.padEnd(19)}${outcome.kind.padEnd(8)}${size.padStart(10)}${String(ms).padStart(7)}ms`)
    if (outcome.kind === "record") ok++
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`${c.id.padEnd(19)}${"THREW".padEnd(8)}${"".padStart(10)}${"".padStart(7)}  ${message.slice(0, 60)}`)
  }
}
console.log(`\n${ok}/${registry.all().length} returned a record. Fixtures in ${out}`)
