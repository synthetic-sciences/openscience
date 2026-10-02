export type BiologicalFormat = "fastq" | "vcf" | "bed" | "gff" | "gtf" | "sam" | "mzml"

export interface Count {
  name: string
  count: number
}

interface FastqRecord {
  id: string
  sequence: string
  length: number
  gc: number
  quality: number
}

export interface FastqFile {
  format: "fastq"
  reads: number
  bases: number
  gc: number
  n: number
  meanLength: number
  minLength: number
  maxLength: number
  meanQuality: number
  q30: number
  invalid: number
  cycles: number[]
  records: FastqRecord[]
  truncated: boolean
}

interface VcfRecord {
  chrom: string
  pos: number
  id: string
  ref: string
  alt: string
  qual?: number
  filter: string
  type: keyof VcfTypes
  depth?: number
}

interface VcfTypes {
  snv: number
  insertion: number
  deletion: number
  symbolic: number
  other: number
}

export interface VcfFile {
  format: "vcf"
  fileformat: string
  reference: string
  samples: string[]
  variants: number
  passed: number
  meanQuality: number
  types: VcfTypes
  chromosomes: Count[]
  filters: Count[]
  records: VcfRecord[]
  truncated: boolean
}

interface IntervalRecord {
  chrom: string
  start: number
  end: number
  name: string
  type: string
  strand: string
  score: string
  span: number
}

export interface IntervalFile {
  format: "bed" | "gff" | "gtf"
  features: number
  totalSpan: number
  meanSpan: number
  maxSpan: number
  chromosomes: Count[]
  types: Count[]
  records: IntervalRecord[]
  truncated: boolean
}

interface SamRecord {
  name: string
  flag: number
  reference: string
  position: number
  mapq: number
  cigar: string
  length: number
}

export interface SamFile {
  format: "sam"
  version: string
  order: string
  alignments: number
  mapped: number
  unmapped: number
  secondary: number
  supplementary: number
  duplicates: number
  meanMapq: number
  references: { name: string; length: number }[]
  chromosomes: Count[]
  records: SamRecord[]
  truncated: boolean
}

export interface MzmlFile {
  format: "mzml"
  run: string
  spectra: number
  chromatograms: number
  levels: Count[]
  times: number[]
  range?: { start: number; end: number }
  truncated: boolean
}

export type BiologicalFile = FastqFile | VcfFile | IntervalFile | SamFile | MzmlFile

const LIMIT = 10_000

const formats: Record<string, BiologicalFormat> = {
  fastq: "fastq",
  fq: "fastq",
  vcf: "vcf",
  bed: "bed",
  bedgraph: "bed",
  gff: "gff",
  gff3: "gff",
  gtf: "gtf",
  sam: "sam",
  mzml: "mzml",
  mzxml: "mzml",
}

export function detectBiologicalFormat(extension: string): BiologicalFormat | undefined {
  return formats[extension.toLowerCase()]
}

export function parseBiologicalFile(format: BiologicalFormat, text: string): BiologicalFile {
  if (format === "fastq") return parseFastq(text)
  if (format === "vcf") return parseVcf(text)
  if (format === "sam") return parseSam(text)
  if (format === "mzml") return parseMzml(text)
  return parseIntervals(format, text)
}

function parseFastq(text: string): FastqFile {
  const lines = text.split(/\r?\n/)
  const chunks = Array.from({ length: Math.ceil(lines.length / 4) }, (_, index) =>
    lines.slice(index * 4, index * 4 + 4),
  )
  const parsed = chunks.reduce<{ records: FastqRecord[]; qualities: number[][]; invalid: number }>(
    (all, chunk) => {
      if (!chunk.some(Boolean)) return all
      const valid =
        chunk.length === 4 &&
        chunk[0]?.startsWith("@") &&
        chunk[2]?.startsWith("+") &&
        chunk[1]?.length === chunk[3]?.length
      if (!valid) return { ...all, invalid: all.invalid + 1 }
      if (all.records.length >= LIMIT) return all
      const sequence = chunk[1]!.toUpperCase()
      const scores = Array.from(chunk[3]!, (value) => Math.max(0, value.charCodeAt(0) - 33))
      const gc = sequence ? (sequence.match(/[GC]/g)?.length ?? 0) / sequence.length : 0
      return {
        records: [
          ...all.records,
          {
            id: chunk[0]!.slice(1).trim().split(/\s+/)[0] || `read_${all.records.length + 1}`,
            sequence,
            length: sequence.length,
            gc: round(gc * 100),
            quality: round(mean(scores)),
          },
        ],
        qualities: [...all.qualities, scores],
        invalid: all.invalid,
      }
    },
    { records: [], qualities: [], invalid: 0 },
  )
  const sequences = parsed.records.map((record) => record.sequence).join("")
  const scores = parsed.qualities.flat()
  const lengths = parsed.records.map((record) => record.length)
  const max = Math.max(0, ...lengths)
  const cycles = Array.from({ length: Math.min(max, 250) }, (_, index) =>
    round(mean(parsed.qualities.map((quality) => quality[index]).filter((value) => value !== undefined))),
  )
  return {
    format: "fastq",
    reads: parsed.records.length,
    bases: sequences.length,
    gc: round(((sequences.match(/[GC]/g)?.length ?? 0) / Math.max(1, sequences.length)) * 100),
    n: round(((sequences.match(/N/g)?.length ?? 0) / Math.max(1, sequences.length)) * 100),
    meanLength: round(mean(lengths)),
    minLength: lengths.length ? Math.min(...lengths) : 0,
    maxLength: max,
    meanQuality: round(mean(scores)),
    q30: round((scores.filter((score) => score >= 30).length / Math.max(1, scores.length)) * 100),
    invalid: parsed.invalid,
    cycles,
    records: parsed.records,
    truncated: chunks.length - parsed.invalid > LIMIT,
  }
}

function parseVcf(text: string): VcfFile {
  const lines = text.split(/\r?\n/)
  const meta = Object.fromEntries(
    lines
      .filter((line) => line.startsWith("##") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=")
        return [line.slice(2, index), line.slice(index + 1)]
      }),
  )
  const header = lines.find((line) => line.startsWith("#CHROM"))?.split("\t") ?? []
  const rows = lines.filter((line) => line && !line.startsWith("#"))
  const records = rows.slice(0, LIMIT).map((line): VcfRecord => {
    const fields = line.split("\t")
    const ref = fields[3] ?? ""
    const alt = fields[4] ?? ""
    const info = fields[7] ?? ""
    return {
      chrom: fields[0] ?? "",
      pos: Number(fields[1]) || 0,
      id: fields[2] === "." ? "" : (fields[2] ?? ""),
      ref,
      alt,
      qual: number(fields[5]),
      filter: fields[6] || ".",
      type: variantType(ref, alt),
      depth: number(info.match(/(?:^|;)DP=(\d+)/)?.[1]),
    }
  })
  const types = records.reduce<VcfTypes>((all, record) => ({ ...all, [record.type]: all[record.type] + 1 }), {
    snv: 0,
    insertion: 0,
    deletion: 0,
    symbolic: 0,
    other: 0,
  })
  return {
    format: "vcf",
    fileformat: meta.fileformat ?? "",
    reference: meta.reference ?? "",
    samples: header.slice(9),
    variants: rows.length,
    passed: rows.filter((line) => {
      const filter = line.split("\t")[6]
      return filter === "PASS" || filter === "."
    }).length,
    meanQuality: round(mean(records.map((record) => record.qual).filter((value) => value !== undefined))),
    types,
    chromosomes: counts(records.map((record) => record.chrom)),
    filters: counts(records.map((record) => record.filter)),
    records,
    truncated: rows.length > LIMIT,
  }
}

function parseIntervals(format: "bed" | "gff" | "gtf", text: string): IntervalFile {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("track") && !line.startsWith("browser"))
  const records = rows.slice(0, LIMIT).flatMap((line): IntervalRecord[] => {
    const fields = line.split("\t")
    if (fields.length < 3) return []
    if (format === "bed") {
      const start = Number(fields[1]) || 0
      const end = Number(fields[2]) || start
      return [
        {
          chrom: fields[0] ?? "",
          start,
          end,
          name: fields[3] ?? "",
          type: "region",
          score: fields[4] ?? "",
          strand: fields[5] ?? ".",
          span: Math.max(0, end - start),
        },
      ]
    }
    const start = Number(fields[3]) || 0
    const end = Number(fields[4]) || start
    const attributes = attributesOf(fields[8] ?? "")
    return [
      {
        chrom: fields[0] ?? "",
        start,
        end,
        name: attributes.Name ?? attributes.gene_name ?? attributes.ID ?? attributes.gene_id ?? "",
        type: fields[2] ?? "feature",
        score: fields[5] ?? "",
        strand: fields[6] ?? ".",
        span: Math.max(0, end - start + 1),
      },
    ]
  })
  const spans = records.map((record) => record.span)
  return {
    format,
    features: rows.length,
    totalSpan: spans.reduce((total, value) => total + value, 0),
    meanSpan: round(mean(spans)),
    maxSpan: spans.length ? Math.max(...spans) : 0,
    chromosomes: counts(records.map((record) => record.chrom)),
    types: counts(records.map((record) => record.type)),
    records,
    truncated: rows.length > LIMIT,
  }
}

function parseSam(text: string): SamFile {
  const lines = text.split(/\r?\n/).filter(Boolean)
  const hd =
    lines
      .find((line) => line.startsWith("@HD"))
      ?.split("\t")
      .slice(1) ?? []
  const header = Object.fromEntries(hd.map((entry) => entry.split(":", 2)))
  const references = lines
    .filter((line) => line.startsWith("@SQ"))
    .map((line) =>
      Object.fromEntries(
        line
          .split("\t")
          .slice(1)
          .map((entry) => entry.split(":", 2)),
      ),
    )
    .map((record) => ({ name: record.SN ?? "", length: Number(record.LN) || 0 }))
  const rows = lines.filter((line) => !line.startsWith("@"))
  const records = rows.slice(0, LIMIT).flatMap((line): SamRecord[] => {
    const fields = line.split("\t")
    if (fields.length < 11) return []
    return [
      {
        name: fields[0] ?? "",
        flag: Number(fields[1]) || 0,
        reference: fields[2] ?? "*",
        position: Number(fields[3]) || 0,
        mapq: Number(fields[4]) || 0,
        cigar: fields[5] ?? "*",
        length: fields[9]?.length ?? 0,
      },
    ]
  })
  const mapped = records.filter((record) => !(record.flag & 4))
  return {
    format: "sam",
    version: header.VN ?? "",
    order: header.SO ?? "",
    alignments: rows.length,
    mapped: mapped.length,
    unmapped: records.filter((record) => record.flag & 4).length,
    secondary: records.filter((record) => record.flag & 256).length,
    supplementary: records.filter((record) => record.flag & 2048).length,
    duplicates: records.filter((record) => record.flag & 1024).length,
    meanMapq: round(mean(mapped.map((record) => record.mapq))),
    references,
    chromosomes: counts(mapped.map((record) => record.reference)),
    records,
    truncated: rows.length > LIMIT,
  }
}

function parseMzml(text: string): MzmlFile {
  const spectra =
    Number(text.match(/<spectrumList\b[^>]*\bcount="(\d+)"/i)?.[1]) || (text.match(/<spectrum\b/gi) ?? []).length
  const chromatograms =
    Number(text.match(/<chromatogramList\b[^>]*\bcount="(\d+)"/i)?.[1]) ||
    (text.match(/<chromatogram\b/gi) ?? []).length
  const blocks = text.match(/<spectrum\b[\s\S]*?<\/spectrum>/gi) ?? []
  const levels = counts(
    blocks.map(
      (block) =>
        `MS${block.match(/accession="MS:1000511"[^>]*\bvalue="(\d+)"/i)?.[1] ?? block.match(/name="ms level"[^>]*\bvalue="(\d+)"/i)?.[1] ?? "?"}`,
    ),
  ).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const times = Array.from(
    text.matchAll(/(?:accession="MS:1000016"|name="scan start time")[^>]*\bvalue="([\d.]+)"/gi),
    (match) => Number(match[1]),
  ).filter(Number.isFinite)
  // A busy run reports more scan times than the engine accepts as call arguments, so fold the bounds in one pass.
  const span = times.reduce(
    (bounds, time) => {
      if (time < bounds.start) bounds.start = time
      if (time > bounds.end) bounds.end = time
      return bounds
    },
    { start: Infinity, end: -Infinity },
  )
  return {
    format: "mzml",
    run: text.match(/<run\b[^>]*\bid="([^"]+)"/i)?.[1] ?? "",
    spectra,
    chromatograms,
    levels,
    times: times.slice(0, LIMIT),
    range: times.length ? span : undefined,
    truncated: times.length > LIMIT,
  }
}

function variantType(ref: string, alt: string): keyof VcfTypes {
  if (alt.startsWith("<") || alt.includes("[") || alt.includes("]")) return "symbolic"
  const alternatives = alt.split(",")
  if (ref.length === 1 && alternatives.every((value) => value.length === 1)) return "snv"
  if (alternatives.every((value) => value.length > ref.length)) return "insertion"
  if (alternatives.every((value) => value.length < ref.length)) return "deletion"
  return "other"
}

function attributesOf(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const equal = item.indexOf("=")
        if (equal >= 0) return [item.slice(0, equal), item.slice(equal + 1).replace(/^"|"$/g, "")]
        const space = item.indexOf(" ")
        if (space >= 0) return [item.slice(0, space), item.slice(space + 1).replace(/^"|"$/g, "")]
        return [item, ""]
      }),
  )
}

function counts(values: string[]): Count[] {
  const map = values.reduce<Record<string, number>>((all, value) => {
    if (!value) return all
    return { ...all, [value]: (all[value] ?? 0) + 1 }
  }, {})
  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

function number(value?: string): number | undefined {
  if (!value || value === ".") return
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
