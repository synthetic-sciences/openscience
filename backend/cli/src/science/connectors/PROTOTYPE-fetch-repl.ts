#!/usr/bin/env bun
/**
 * PROTOTYPE — throwaway TUI. Run:  bun run prototype:fetch   (from backend/cli)
 *
 * Drives the science_fetch decision model in PROTOTYPE-fetch-outcome.ts against
 * the REAL 42 connectors over the REAL network. See that file for the question
 * this is trying to answer.
 *
 * This shell is disposable. The pure module next door is the liftable part.
 * No tests, no error handling beyond staying runnable, no abstractions.
 */
import { registry } from "./index"
import type { Connector } from "./types"
import { outcomeFor, formatBytes, SPILL_CAP_BYTES, type FetchOutcome } from "./PROTOTYPE-fetch-outcome"

const B = "\x1b[1m"
const D = "\x1b[2m"
const R = "\x1b[0m"
const G = "\x1b[32m"
const Y = "\x1b[33m"
const RED = "\x1b[31m"
const C = "\x1b[36m"

/** Known-plausible ids so the user never has to know a valid PDB/DOI/accession.
 *  Some of these are guesses — a wrong id exercising the MISS path is a feature. */
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

/** The 7 connectors the design says should grow fetchFile(). Formats are the
 *  DESIGN's claim; this prototype does not implement them — it shows what the
 *  filename/disposition would be so the naming can be eyeballed. */
const PROPOSED_FORMATS: Record<string, string[]> = {
  "rcsb-pdb": ["json", "pdb", "cif"],
  pdbe: ["json", "cif"],
  alphafold: ["json", "pdb", "cif"],
  uniprot: ["json", "fasta", "txt"],
  pubchem: ["json", "sdf"],
  ensembl: ["json", "fasta"],
  kegg: ["json", "fasta"],
}

type Row = { id: string; outcome: FetchOutcome; ms: number }

const all: Connector[] = registry.all()
let cursor = 0
let cap = SPILL_CAP_BYTES
let formatIdx = 0
let ids: Record<string, string> = { ...SAMPLE }
let last: Row | null = null
let batch: Row[] | null = null
let busy = ""

function current(): Connector {
  return all[cursor]!
}
function formatsFor(db: string): (string | undefined)[] {
  const f = PROPOSED_FORMATS[db]
  return f ? [undefined, ...f.filter((x) => x !== "json")] : [undefined]
}
function activeFormat(): string | undefined {
  const opts = formatsFor(current().id)
  return opts[formatIdx % opts.length]
}

async function runOne(c: Connector, format?: string): Promise<Row> {
  const id = ids[c.id] ?? ""
  const t0 = performance.now()
  try {
    const payload = await c.fetch(id, { signal: AbortSignal.timeout(20_000) })
    const ms = Math.round(performance.now() - t0)
    return { id: c.id, outcome: outcomeFor({ db: c.id, id, format, payload, capBytes: cap }), ms }
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    const message = err instanceof Error ? err.message : String(err)
    const retryable = /\b(429|503|408)\b/.test(message) || /rate.?limit/i.test(message)
    return { id: c.id, outcome: { kind: "error", retryable, message }, ms }
  }
}

function badge(o: FetchOutcome): string {
  if (o.kind === "miss") return `${Y}MISS${R}`
  if (o.kind === "error") return `${RED}ERROR${R}`
  if (o.kind === "file") return `${C}FILE${R}`
  return o.disposition === "inline" ? `${G}RECORD/inline${R}` : `${Y}RECORD/spill${R}`
}

function render() {
  console.clear()
  const c = current()
  const fmt = activeFormat()
  console.log(`${B}science_fetch — decision-model prototype${R}`)
  console.log(`${D}Q: does record/file × inline/spill × miss/error hold against the real 42?${R}\n`)

  if (batch) {
    const counts = { inline: 0, spill: 0, file: 0, miss: 0, error: 0 }
    for (const r of batch) {
      if (r.outcome.kind === "miss") counts.miss++
      else if (r.outcome.kind === "error") counts.error++
      else if (r.outcome.kind === "file") counts.file++
      else r.outcome.disposition === "inline" ? counts.inline++ : counts.spill++
    }
    console.log(
      `${B}BATCH${R}  ${G}${counts.inline} inline${R} · ${Y}${counts.spill} spill${R} · ` +
        `${Y}${counts.miss} miss${R} · ${RED}${counts.error} error${R}   ${D}cap ${formatBytes(cap)}${R}\n`,
    )
    for (const r of batch) {
      const o = r.outcome
      const size = o.kind === "record" || o.kind === "file" ? formatBytes(o.bytes).padStart(9) : "".padStart(9)
      const note = o.kind === "miss" || o.kind === "error" ? `${D}${o.kind === "miss" ? o.note : o.message}${R}` : ""
      console.log(
        `  ${r.id.padEnd(18)}${size}  ${String(r.ms).padStart(5)}ms  ${badge(o).padEnd(24)}${note.slice(0, 60)}`,
      )
    }
    console.log(`\n${D}[b] back  [+/-] cap  [q] quit${R}`)
    return
  }

  console.log(`${B}CONNECTOR${R}  ${c.name} ${D}(${c.id}) · ${c.domain} · ${cursor + 1}/${all.length}${R}`)
  console.log(`${B}ID${R}         ${ids[c.id] ?? ""}`)
  console.log(
    `${B}FORMAT${R}     ${fmt ? `${C}${fmt}${R}` : `${D}(none — record)${R}`}` +
      `   ${D}proposed: ${(PROPOSED_FORMATS[c.id] ?? ["json only"]).join(", ")}${R}`,
  )
  console.log(`${B}CAP${R}        ${formatBytes(cap)}\n`)

  if (busy) console.log(`${D}${busy}${R}\n`)
  else if (last) {
    const o = last.outcome
    console.log(`${B}LAST OUTCOME${R}  ${badge(o)}   ${D}${last.ms} ms${R}`)
    if (o.kind === "record" || o.kind === "file") {
      console.log(`  ${D}bytes${R}      ${formatBytes(o.bytes)} ${D}(${o.bytes.toLocaleString()})${R}`)
      console.log(`  ${D}writes to${R}  ${o.disposition === "spill" ? o.filename : `${D}— inline, no file${R}`}`)
      console.log(`  ${D}summary${R}    ${o.summary.slice(0, 90)}`)
    } else if (o.kind === "miss") console.log(`  ${D}note${R}       ${o.note}`)
    else console.log(`  ${D}message${R}    ${o.message.slice(0, 90)}   ${D}retryable: ${o.retryable}${R}`)
  } else console.log(`${D}(nothing fetched yet — press enter)${R}`)

  console.log(
    `\n${D}[j/k] connector  [enter] fetch  [f] format  [+/-] cap  [i] set id  [a] run all 42  [q] quit${R}`,
  )
}

async function editId() {
  process.stdin.setRawMode(false)
  console.log(`\n${B}new id for ${current().id}${R} (blank = keep): `)
  const line = await new Promise<string>((res) => {
    const on = (d: Buffer) => {
      process.stdin.off("data", on)
      res(d.toString().trim())
    }
    process.stdin.on("data", on)
  })
  if (line) ids[current().id] = line
  process.stdin.setRawMode(true)
  render()
}

async function main() {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  render()

  for await (const chunk of process.stdin) {
    const k = chunk.toString()
    if (k === "q" || k === "") break

    if (batch) {
      if (k === "b") batch = null
      else if (k === "+" || k === "=") cap *= 2
      else if (k === "-" || k === "_") cap = Math.max(1024, Math.floor(cap / 2))
      render()
      continue
    }

    if (k === "j" || k === "[B") {
      cursor = (cursor + 1) % all.length
      formatIdx = 0
      last = null
    } else if (k === "k" || k === "[A") {
      cursor = (cursor - 1 + all.length) % all.length
      formatIdx = 0
      last = null
    } else if (k === "f") formatIdx++
    else if (k === "+" || k === "=") cap *= 2
    else if (k === "-" || k === "_") cap = Math.max(1024, Math.floor(cap / 2))
    else if (k === "i") {
      await editId()
      continue
    } else if (k === "\r" || k === "\n") {
      busy = `fetching ${current().id} …`
      render()
      last = await runOne(current(), activeFormat())
      busy = ""
    } else if (k === "a") {
      batch = []
      for (const c of all) {
        busy = `running ${c.id} … (${batch.length + 1}/${all.length})`
        render()
        batch.push(await runOne(c))
      }
      busy = ""
    }
    render()
  }

  process.stdin.setRawMode(false)
  console.clear()
  console.log("prototype exited\n")
  process.exit(0)
}

main()
