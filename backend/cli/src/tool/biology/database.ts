import z from "zod"
import { Tool } from "../tool"

const TIMEOUT = 30_000

async function fetchJSON(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "openscience/biology", ...init?.headers },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "openscience/biology" },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    return res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ── UniProt ──────────────────────────────────────────────────────────────────

export const QueryUniprotTool = Tool.define("query_uniprot", {
  description: [
    "Query UniProt protein database. Returns protein function, GO terms, domains, pathways.",
    "Input: gene name (TP53), UniProt accession (P04637), or search query.",
    "Use for: protein annotation, function lookup, GO terms, domain identification.",
  ].join("\n"),
  parameters: z.object({
    query: z
      .string()
      .describe("Gene name, UniProt ID, or search query (e.g. 'TP53', 'P04637', 'kinase AND organism_id:9606')"),
    organism: z.string().default("9606").describe("NCBI taxon ID (default: 9606/human). Use '*' for all organisms."),
    limit: z.number().default(5).describe("Max results (1-25)"),
  }),
  async execute(params, _ctx) {
    const limit = Math.min(Math.max(params.limit, 1), 25)
    const orgFilter = params.organism === "*" ? "" : `+AND+organism_id:${params.organism}`
    const isAccession = /^[A-Z][0-9][A-Z0-9]{3}[0-9]$/i.test(params.query.trim())
    const q = isAccession ? `accession:${params.query.trim()}` : params.query
    const fields =
      "accession,gene_names,protein_name,organism_name,cc_function,go_p,go_c,go_f,ft_domain,cc_pathway,length"
    const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(q)}${orgFilter}&fields=${fields}&format=json&size=${limit}`

    const data = await fetchJSON(url)
    if (!data.results?.length) {
      return { title: "UniProt", output: `No results for "${params.query}"`, metadata: {} }
    }

    const entries = data.results.map((e: any) => {
      const lines: string[] = []
      const name =
        e.proteinDescription?.recommendedName?.fullName?.value ||
        e.proteinDescription?.submissionNames?.[0]?.fullName?.value ||
        "Unknown"
      lines.push(`## ${e.primaryAccession} — ${name}`)

      const genes = e.genes?.flatMap((g: any) =>
        [g.geneName?.value, ...(g.synonyms?.map((s: any) => s.value) || [])].filter(Boolean),
      )
      if (genes?.length) lines.push(`**Genes**: ${genes.join(", ")}`)
      if (e.organism) lines.push(`**Organism**: ${e.organism.scientificName}`)

      const fns = e.comments
        ?.filter((c: any) => c.commentType === "FUNCTION")
        .flatMap((c: any) => c.texts?.map((t: any) => t.value) || [])
      if (fns?.length) lines.push(`**Function**: ${fns.join(" ")}`)

      const domains = e.features?.filter((f: any) => f.type === "Domain")
      if (domains?.length) {
        lines.push(
          `**Domains**: ${domains.map((d: any) => `${d.description} (${d.location?.start?.value}-${d.location?.end?.value})`).join(", ")}`,
        )
      }

      const pathways = e.comments
        ?.filter((c: any) => c.commentType === "PATHWAY")
        .flatMap((c: any) => c.texts?.map((t: any) => t.value) || [])
      if (pathways?.length) lines.push(`**Pathways**: ${pathways.join("; ")}`)

      for (const [label, prefix] of [
        ["Biological Process", "P:"],
        ["Molecular Function", "F:"],
        ["Cellular Component", "C:"],
      ] as const) {
        const terms = e.uniProtKBCrossReferences
          ?.filter((x: any) => x.database === "GO")
          .filter((x: any) => x.properties?.some((p: any) => p.value?.startsWith(prefix)))
          .map((x: any) => x.properties?.find((p: any) => p.value?.startsWith(prefix))?.value?.slice(2))
          .filter(Boolean)
        if (terms?.length)
          lines.push(
            `**GO ${label}**: ${terms.slice(0, 8).join("; ")}${terms.length > 8 ? ` (+${terms.length - 8} more)` : ""}`,
          )
      }

      if (e.sequence?.length) lines.push(`**Length**: ${e.sequence.length} aa`)
      return lines.join("\n")
    })

    return {
      title: `UniProt: ${params.query}`,
      output: entries.join("\n\n---\n\n"),
      metadata: { count: data.results.length },
    }
  },
})

// ── Ensembl ──────────────────────────────────────────────────────────────────

export const QueryEnsemblTool = Tool.define("query_ensembl", {
  description: [
    "Query Ensembl for gene/transcript annotations. Returns coordinates, biotype, transcripts.",
    "Input: gene symbol (TP53), Ensembl ID (ENSG00000141510), or transcript ID.",
    "Use for: gene coordinates, biotype, ortholog lookup, transcript structure.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().describe("Gene symbol (TP53), Ensembl gene ID (ENSG...), or transcript ID (ENST...)"),
    species: z.string().default("homo_sapiens").describe("Species (default: homo_sapiens)"),
    expand: z.boolean().default(true).describe("Include transcripts in response"),
  }),
  async execute(params, _ctx) {
    const q = params.query.trim()
    const base = "https://rest.ensembl.org"
    const expand = params.expand ? 1 : 0

    const url = q.startsWith("ENS")
      ? `${base}/lookup/id/${q}?expand=${expand}&content-type=application/json`
      : `${base}/lookup/symbol/${params.species}/${q}?expand=${expand}&content-type=application/json`

    const data = await fetchJSON(url)

    const lines: string[] = []
    lines.push(`## ${data.display_name || data.id} — ${data.description || "No description"}`)
    lines.push(`**Ensembl ID**: ${data.id}`)
    lines.push(`**Biotype**: ${data.biotype}`)
    lines.push(`**Species**: ${data.species}`)
    if (data.seq_region_name) {
      lines.push(
        `**Location**: chr${data.seq_region_name}:${data.start}-${data.end} (${data.strand === 1 ? "+" : "-"})`,
      )
    }
    if (data.assembly_name) lines.push(`**Assembly**: ${data.assembly_name}`)

    if (data.Transcript?.length) {
      lines.push(`\n**Transcripts** (${data.Transcript.length}):`)
      for (const t of data.Transcript.slice(0, 10)) {
        const tag = t.is_canonical ? " [canonical]" : ""
        lines.push(`- ${t.id} (${t.biotype})${tag}: ${t.start}-${t.end}, ${t.length || "?"} bp`)
      }
      if (data.Transcript.length > 10) {
        lines.push(`  ... +${data.Transcript.length - 10} more transcripts`)
      }
    }

    return {
      title: `Ensembl: ${q}`,
      output: lines.join("\n"),
      metadata: { id: data.id, biotype: data.biotype },
    }
  },
})

// ── KEGG ─────────────────────────────────────────────────────────────────────

export const QueryKeggTool = Tool.define("query_kegg", {
  description: [
    "Query KEGG for pathway information and gene-pathway mappings.",
    "Input: pathway ID (hsa04110), gene ID (hsa:7157), or keyword search.",
    "Use for: pathway enrichment context, metabolic pathway lookup, gene-pathway membership.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().describe("Pathway ID (hsa04110), gene ID (hsa:7157), or search keyword (e.g. 'cell cycle')"),
    operation: z
      .enum(["info", "find", "genes"])
      .default("find")
      .describe("info: details for a pathway/entry. find: search by keyword. genes: list genes in a pathway."),
    organism: z.string().default("hsa").describe("KEGG organism code (default: hsa for human)"),
  }),
  async execute(params, _ctx) {
    const base = "https://rest.kegg.jp"
    const q = params.query.trim()

    if (params.operation === "info") {
      const text = await fetchText(`${base}/get/${q}`)
      return { title: `KEGG: ${q}`, output: text.slice(0, 8000), metadata: {} as Record<string, any> }
    }

    if (params.operation === "genes") {
      const text = await fetchText(`${base}/link/${params.organism}/${q}`)
      const genes = text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("\t")
          return parts[1] || line
        })
      return {
        title: `KEGG genes: ${q}`,
        output: `**Genes in ${q}** (${genes.length}):\n${genes.join(", ")}`,
        metadata: { count: genes.length } as Record<string, any>,
      }
    }

    // find
    const text = await fetchText(`${base}/find/pathway/${encodeURIComponent(q)}`)
    const results = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, ...rest] = line.split("\t")
        return `- **${id}**: ${rest.join(" ")}`
      })

    if (!results.length) {
      return { title: "KEGG", output: `No pathways found for "${q}"`, metadata: {} as Record<string, any> }
    }

    return {
      title: `KEGG: ${q}`,
      output: `**Pathway search: "${q}"** (${results.length} results):\n${results.join("\n")}`,
      metadata: { count: results.length } as Record<string, any>,
    }
  },
})

// ── PubMed ───────────────────────────────────────────────────────────────────

export const QueryPubmedTool = Tool.define("query_pubmed", {
  description: [
    "Search PubMed for biomedical literature. Returns titles, authors, abstracts, PMIDs.",
    "Input: PubMed query (supports Boolean operators, [MeSH], [Author] qualifiers).",
    "Use for: literature search, finding methods papers, validating findings against published work.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().describe("PubMed search query (e.g. 'TP53 AND breast cancer AND DESeq2')"),
    max_results: z.number().default(5).describe("Max papers (1-20)"),
    sort: z.enum(["relevance", "date"]).default("relevance").describe("Sort order"),
  }),
  async execute(params, _ctx) {
    const limit = Math.min(Math.max(params.max_results, 1), 20)
    const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

    // Search for IDs
    const search = await fetchJSON(
      `${base}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(params.query)}&retmode=json&retmax=${limit}&sort=${params.sort}`,
    )
    const ids = search.esearchresult?.idlist

    if (!ids?.length) {
      return { title: "PubMed", output: `No results for "${params.query}"`, metadata: {} }
    }

    // Fetch summaries
    const summary = await fetchJSON(`${base}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`)

    const articles = ids.map((id: string) => {
      const a = summary.result?.[id]
      if (!a) return `### PMID:${id}\n(no details)`

      const authors = a.authors
        ?.slice(0, 3)
        .map((x: any) => x.name)
        .join(", ")
      const authorStr = a.authors?.length > 3 ? `${authors} et al.` : authors || "Unknown"
      const lines: string[] = []
      lines.push(`### PMID:${id}`)
      lines.push(`**${a.title || "Untitled"}**`)
      lines.push(`${authorStr} — *${a.source || "?"}* (${a.pubdate || "?"})`)
      if (a.elocationid) lines.push(`DOI: ${a.elocationid}`)
      return lines.join("\n")
    })

    // Fetch plain-text abstracts
    const abstracts = await fetchText(`${base}/efetch.fcgi?db=pubmed&id=${ids.join(",")}&rettype=abstract&retmode=text`)

    return {
      title: `PubMed: ${params.query}`,
      output: [
        `**PubMed**: "${params.query}" (${search.esearchresult?.count || "?"} total, showing ${ids.length})`,
        "",
        articles.join("\n\n"),
        "",
        "---",
        "",
        "**Abstracts**:",
        abstracts.slice(0, 6000),
      ].join("\n"),
      metadata: { count: ids.length, total: search.esearchresult?.count },
    }
  },
})

// ── NCBI Gene ────────────────────────────────────────────────────────────────

export const QueryNcbiGeneTool = Tool.define("query_ncbi_gene", {
  description: [
    "Query NCBI Gene for gene information. Returns summary, aliases, genomic location, RefSeqs.",
    "Input: gene symbol (TP53), NCBI Gene ID (7157), or search query.",
    "Use for: gene function summary, alternative names, genomic context, cross-database IDs.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().describe("Gene symbol (TP53), NCBI Gene ID (7157), or search query"),
    organism: z.string().default("human").describe("Organism filter (default: human)"),
    limit: z.number().default(5).describe("Max results (1-10)"),
  }),
  async execute(params, _ctx) {
    const limit = Math.min(Math.max(params.limit, 1), 10)
    const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    const q = params.query.trim()

    const isId = /^\d+$/.test(q)
    const ids = isId
      ? [q]
      : await fetchJSON(
          `${base}/esearch.fcgi?db=gene&term=${encodeURIComponent(q)}[Gene]+AND+${encodeURIComponent(params.organism)}[Organism]&retmode=json&retmax=${limit}`,
        ).then((d: any) => d.esearchresult?.idlist || [])

    if (!ids.length) {
      return { title: "NCBI Gene", output: `No genes found for "${q}"`, metadata: {} }
    }

    const summary = await fetchJSON(`${base}/esummary.fcgi?db=gene&id=${ids.join(",")}&retmode=json`)

    const entries = ids.map((id: string) => {
      const g = summary.result?.[id]
      if (!g) return `- Gene ID ${id}: no details`

      const lines: string[] = []
      lines.push(`## ${g.name || id} — ${g.description || "?"}`)
      lines.push(`**Gene ID**: ${id}`)
      if (g.otheraliases) lines.push(`**Aliases**: ${g.otheraliases}`)
      if (g.organism?.scientificname) lines.push(`**Organism**: ${g.organism.scientificname}`)
      if (g.chromosome) lines.push(`**Chromosome**: ${g.chromosome}`)
      if (g.maplocation) lines.push(`**Map location**: ${g.maplocation}`)
      if (g.genomicinfo?.[0]) {
        const gi = g.genomicinfo[0]
        lines.push(`**Coordinates**: chr${gi.chrloc}:${gi.chrstart}-${gi.chrstop}`)
      }
      if (g.summary) lines.push(`**Summary**: ${g.summary}`)
      if (g.nomenclaturename) lines.push(`**Full name**: ${g.nomenclaturename}`)
      return lines.join("\n")
    })

    return {
      title: `NCBI Gene: ${q}`,
      output: entries.join("\n\n---\n\n"),
      metadata: { count: ids.length },
    }
  },
})

// ── STRING ───────────────────────────────────────────────────────────────────

export const QueryStringTool = Tool.define("query_string", {
  description: [
    "Query STRING database for protein-protein interactions and functional networks.",
    "Input: protein/gene name(s). Returns interaction partners with confidence scores.",
    "Use for: interaction networks, functional associations, co-expression evidence.",
  ].join("\n"),
  parameters: z.object({
    identifiers: z
      .string()
      .describe("Protein/gene name(s), comma-separated for multiple (e.g. 'TP53' or 'TP53,MDM2,CDKN1A')"),
    species: z.number().default(9606).describe("NCBI taxon ID (default: 9606/human)"),
    limit: z.number().default(10).describe("Max interaction partners per protein (1-50)"),
    score_threshold: z
      .number()
      .default(400)
      .describe("Minimum combined score 0-1000 (default: 400 = medium confidence)"),
  }),
  async execute(params, _ctx) {
    const ids = params.identifiers.trim()
    const limit = Math.min(Math.max(params.limit, 1), 50)

    const url = `https://string-db.org/api/json/interaction_partners?identifiers=${encodeURIComponent(ids)}&species=${params.species}&limit=${limit}&required_score=${params.score_threshold}`
    const data = await fetchJSON(url)

    if (!data?.length) {
      return {
        title: "STRING",
        output: `No interactions found for "${ids}" (score >= ${params.score_threshold})`,
        metadata: {},
      }
    }

    // Group by query protein
    const grouped: Record<string, any[]> = {}
    for (const i of data) {
      const key = i.preferredName_A || i.stringId_A
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(i)
    }

    const sections = Object.entries(grouped).map(([protein, interactions]) => {
      const lines: string[] = [`## ${protein} interactions (${interactions.length})`]
      const sorted = interactions.sort((a: any, b: any) => b.score - a.score)
      for (const i of sorted) {
        const partner = i.preferredName_B || i.stringId_B
        const scores = []
        if (i.escore > 0) scores.push(`exp:${i.escore.toFixed(3)}`)
        if (i.dscore > 0) scores.push(`db:${i.dscore.toFixed(3)}`)
        if (i.tscore > 0) scores.push(`txt:${i.tscore.toFixed(3)}`)
        lines.push(`- **${partner}** (score: ${i.score}) ${scores.length ? `[${scores.join(", ")}]` : ""}`)
      }
      return lines.join("\n")
    })

    return {
      title: `STRING: ${ids}`,
      output: sections.join("\n\n"),
      metadata: { interactions: data.length },
    }
  },
})

// ── PDB ──────────────────────────────────────────────────────────────────────

export const QueryPdbTool = Tool.define("query_pdb", {
  description: [
    "Query RCSB PDB for protein 3D structure information.",
    "Input: PDB ID (1TUP) for direct lookup, or protein name for search.",
    "Use for: structure resolution, experimental method, polymer entities, ligands.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().describe("PDB ID (e.g. '1TUP') or protein name for search (e.g. 'p53 DNA-binding domain')"),
    limit: z.number().default(5).describe("Max results for text search (1-10)"),
  }),
  async execute(params, _ctx) {
    const q = params.query.trim()
    const isPdbId = /^[0-9][A-Za-z0-9]{3}$/.test(q)

    if (isPdbId) {
      const id = q.toUpperCase()
      const data = await fetchJSON(`https://data.rcsb.org/rest/v1/core/entry/${id}`)

      const lines: string[] = []
      lines.push(`## PDB: ${id}`)
      if (data.struct?.title) lines.push(`**Title**: ${data.struct.title}`)
      if (data.exptl?.[0]) lines.push(`**Method**: ${data.exptl[0].method}`)
      if (data.rcsb_entry_info?.resolution_combined?.[0]) {
        lines.push(`**Resolution**: ${data.rcsb_entry_info.resolution_combined[0]} A`)
      }
      if (data.rcsb_entry_info?.deposited_atom_count) {
        lines.push(`**Atoms**: ${data.rcsb_entry_info.deposited_atom_count}`)
      }

      const entities = data.rcsb_entry_container_identifiers?.polymer_entity_ids || []
      if (entities.length) {
        lines.push(`\n**Polymer entities** (${entities.length}):`)
        for (const entityId of entities.slice(0, 5)) {
          try {
            const entity = await fetchJSON(`https://data.rcsb.org/rest/v1/core/polymer_entity/${id}/${entityId}`)
            if (entity.rcsb_polymer_entity?.pdbx_description) {
              lines.push(`- Entity ${entityId}: ${entity.rcsb_polymer_entity.pdbx_description}`)
            }
          } catch {
            /* skip */
          }
        }
      }

      return { title: `PDB: ${id}`, output: lines.join("\n"), metadata: { pdb_id: id } as Record<string, any> }
    }

    // Text search
    const limit = Math.min(Math.max(params.limit, 1), 10)
    const body = {
      query: {
        type: "terminal",
        service: "full_text",
        parameters: { value: q },
      },
      return_type: "entry",
      request_options: {
        results_content_type: ["experimental"],
        paginate: { start: 0, rows: limit },
      },
    }

    const data = await fetchJSON("https://search.rcsb.org/rcsbsearch/v2/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!data.result_set?.length) {
      return { title: "PDB", output: `No structures found for "${q}"`, metadata: {} as Record<string, any> }
    }

    const results = data.result_set
      .map((r: any) => `- **${r.identifier}** (score: ${r.score?.toFixed(2) || "?"})`)
      .join("\n")
    return {
      title: `PDB: ${q}`,
      output: `**PDB search**: "${q}" (${data.total_count || "?"} total, showing ${data.result_set.length}):\n${results}`,
      metadata: { count: data.result_set.length, total: data.total_count } as Record<string, any>,
    }
  },
})
