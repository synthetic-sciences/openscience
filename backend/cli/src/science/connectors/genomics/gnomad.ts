/**
 * gnomAD — genome/exome allele frequencies for genes and variants.
 * Public, keyless GraphQL endpoint at gnomad.broadinstitute.org/api.
 */
import type { Connector, ConnectorHit } from "../types"
import { request } from "../http"
import { arr, asRecord, num, str, summarize, type Rec } from "./util"

const API = "https://gnomad.broadinstitute.org/api"
const REFERENCE = "GRCh38"
const DATASET = "gnomad_r4"

const VARIANT_ID = /^(chr)?([0-9]{1,2}|[xym]|mt)-\d+-[acgtn]+-[acgtn]+$/i
const GENE_ID = /^ensg\d+/i

const GENE_FIELDS = "gene_id symbol name chrom start stop canonical_transcript_id"
const VARIANT_FIELDS = "variant_id rsids genome { ac an af } exome { ac an af }"

const GENE_BY_SYMBOL = `query($v:String!,$ref:ReferenceGenomeId!){gene(gene_symbol:$v,reference_genome:$ref){${GENE_FIELDS}}}`
const GENE_BY_ID = `query($v:String!,$ref:ReferenceGenomeId!){gene(gene_id:$v,reference_genome:$ref){${GENE_FIELDS}}}`
const VARIANT = `query($v:String!,$ds:DatasetId!){variant(variantId:$v,dataset:$ds){${VARIANT_FIELDS}}}`

/** POST a GraphQL query; returns the `data` block, or undefined on any failure. */
async function gql(query: string, variables: Rec, signal?: AbortSignal): Promise<Rec | undefined> {
  try {
    const res = await request(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    })
    return asRecord(res.json<{ data?: unknown }>().data)
  } catch {
    return undefined
  }
}

async function fetchGene(query: string, signal?: AbortSignal): Promise<Rec | undefined> {
  const byId = GENE_ID.test(query)
  const data = await gql(byId ? GENE_BY_ID : GENE_BY_SYMBOL, { v: query, ref: REFERENCE }, signal)
  const gene = asRecord(data?.gene)
  return str(gene.gene_id) ? gene : undefined
}

async function fetchVariant(variantId: string, signal?: AbortSignal): Promise<Rec | undefined> {
  const data = await gql(VARIANT, { v: variantId.replace(/^chr/i, ""), ds: DATASET }, signal)
  const variant = asRecord(data?.variant)
  return str(variant.variant_id) ? variant : undefined
}

function geneHit(gene: Rec): ConnectorHit {
  const geneId = str(gene.gene_id) ?? ""
  const symbol = str(gene.symbol) ?? geneId
  const chrom = str(gene.chrom)
  const start = num(gene.start)
  const stop = num(gene.stop)
  const location = chrom && start !== undefined && stop !== undefined ? `${chrom}:${start}-${stop}` : undefined
  return {
    id: geneId || symbol,
    title: symbol,
    summary: summarize([
      str(gene.name),
      location ? `location: ${location}` : undefined,
      str(gene.canonical_transcript_id) ? `transcript: ${str(gene.canonical_transcript_id)}` : undefined,
    ]),
    url: geneId ? `https://gnomad.broadinstitute.org/gene/${geneId}?dataset=${DATASET}` : undefined,
    extra: gene,
  }
}

function variantHit(variant: Rec): ConnectorHit {
  const id = str(variant.variant_id) ?? ""
  const rsids = arr(variant.rsids)
    .map(str)
    .filter((r): r is string => typeof r === "string")
  const genome = asRecord(variant.genome)
  const exome = asRecord(variant.exome)
  const af = num(genome.af) ?? num(exome.af)
  return {
    id,
    title: id,
    summary: summarize([
      rsids.length > 0 ? `rsID: ${rsids.join(", ")}` : undefined,
      af !== undefined ? `AF: ${af.toExponential(2)}` : undefined,
      num(genome.ac) !== undefined ? `genome AC/AN: ${num(genome.ac)}/${num(genome.an)}` : undefined,
      num(exome.ac) !== undefined ? `exome AC/AN: ${num(exome.ac)}/${num(exome.an)}` : undefined,
    ]),
    url: id ? `https://gnomad.broadinstitute.org/variant/${id}?dataset=${DATASET}` : undefined,
    extra: variant,
  }
}

export const gnomad: Connector = {
  id: "gnomad",
  name: "gnomAD",
  domain: "genomics",
  description: "Population allele frequencies (genome/exome) for genes and variants.",
  homepage: "https://gnomad.broadinstitute.org",

  async search(query, opts) {
    const q = query.trim()
    if (q.length === 0) return []
    if (VARIANT_ID.test(q)) {
      const variant = await fetchVariant(q, opts?.signal)
      return variant ? [variantHit(variant)] : []
    }
    const gene = await fetchGene(q, opts?.signal)
    return gene ? [geneHit(gene)] : []
  },

  async fetch(id, opts) {
    const q = id.trim()
    if (VARIANT_ID.test(q)) return (await fetchVariant(q, opts?.signal)) ?? {}
    return (await fetchGene(q, opts?.signal)) ?? {}
  },
}
