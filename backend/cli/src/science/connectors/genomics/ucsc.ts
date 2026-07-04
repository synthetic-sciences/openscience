/**
 * UCSC Genome Browser JSON API — position/track search and sequence retrieval.
 * Public, keyless (api.genome.ucsc.edu).
 *
 * Docs: https://genome.ucsc.edu/goldenPath/help/api.html
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { arr, asRecord, num, str, summarize, type Rec } from "./util"

const API = "https://api.genome.ucsc.edu"
const DEFAULT_GENOME = "hg38"

const POSITION = /^(chr[\w.]+):([\d,]+)-([\d,]+)$/i

function genomeOf(value: unknown): string {
  return str(value) ?? DEFAULT_GENOME
}

function browserUrl(genome: string, position: string): string {
  return `https://genome.ucsc.edu/cgi-bin/hgTracks?db=${encodeURIComponent(genome)}&position=${encodeURIComponent(position)}`
}

/** Flatten UCSC's per-track `positionMatches[].matches[]` into normalized hits. */
function toHits(genome: string, envelope: Rec, limit: number): ConnectorHit[] {
  const hits: ConnectorHit[] = []
  for (const group of arr(envelope.positionMatches)) {
    const track = asRecord(group)
    const trackName = str(track.trackName) ?? str(track.name)
    for (const entry of arr(track.matches)) {
      if (hits.length >= limit) return hits
      const match = asRecord(entry)
      const position = str(match.position)
      const posName = str(match.posName) ?? str(match.hgFindMatches) ?? position
      if (!posName && !position) continue
      hits.push({
        id: position ?? posName ?? "",
        title: posName ?? position ?? "",
        summary: summarize([
          trackName ? `track: ${trackName}` : undefined,
          str(match.description),
          position ? `position: ${position}` : undefined,
        ]),
        url: position ? browserUrl(genome, position) : undefined,
        extra: { ...match, track: trackName, genome },
      })
    }
  }
  return hits
}

export const ucsc: Connector = {
  id: "ucsc",
  name: "UCSC Genome Browser",
  domain: "genomics",
  description: "Search genome assemblies for genes/positions and retrieve reference sequence.",
  homepage: "https://genome.ucsc.edu",

  async search(query, opts) {
    const term = query.trim()
    if (term.length === 0) return []
    const genome = genomeOf(opts?.organism ?? opts?.params?.["genome"])
    const limit = Math.min(opts?.limit ?? 10, 25)
    try {
      const envelope = await getJSON<Rec>(
        `${API}/search?search=${encodeURIComponent(term)}&genome=${encodeURIComponent(genome)}`,
        { signal: opts?.signal },
      )
      return toHits(genome, envelope, limit)
    } catch {
      return []
    }
  },

  async fetch(id, opts) {
    const genome = genomeOf(opts?.params?.["genome"])
    const target = id.trim()
    const coords = POSITION.exec(target)
    // A genomic interval → return the reference DNA sequence for that region.
    if (coords) {
      const chrom = coords[1]
      const start = Number(coords[2].replace(/,/g, ""))
      const end = Number(coords[3].replace(/,/g, ""))
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const capped = Math.min(end, start + 50_000)
        return getJSON<Rec>(
          `${API}/getData/sequence?genome=${encodeURIComponent(genome)}&chrom=${encodeURIComponent(chrom)}` +
            `&start=${start}&end=${capped}`,
          { signal: opts?.signal },
        )
      }
    }
    // Otherwise resolve the term to its matching positions.
    try {
      return await getJSON<Rec>(
        `${API}/search?search=${encodeURIComponent(target)}&genome=${encodeURIComponent(genome)}`,
        { signal: opts?.signal },
      )
    } catch {
      return {}
    }
  },
}
