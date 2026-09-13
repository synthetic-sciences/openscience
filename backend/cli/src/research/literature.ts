import path from "path"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { getJSON, HttpStatusError } from "@/science/connectors/http"
import { arxiv } from "@/science/connectors/literature/arxiv"
import { politeParams } from "@/science/connectors/literature/openalex"
import { fromInverted } from "@/science/connectors/literature/shared"
import { connectorRegistry } from "@/science/connectors/plugin"
import type { ConnectorHit } from "@/science/connectors"
import { classifyError } from "@/science/connectors/fetch-outcome"

/**
 * One literature surface over several scholarly sources.
 *
 * `search` fans a query out to OpenAlex and arXiv (or any named connector),
 * merges records that describe the same paper (DOI, arXiv id, or title) and
 * ranks the union with reciprocal rank fusion, so a paper two sources agree on
 * rises. Each candidate carries enough to cite it and says whether full text
 * is reachable. `resolve` turns a DOI, arXiv id, URL or title into the best
 * open full-text location, and `extract` produces page-addressed plain text
 * from a PDF with `pdftotext`, cached next to the file.
 */
export namespace Literature {
  export interface Candidate {
    title: string
    authors: string[]
    year?: number
    date?: string
    venue?: string
    doi?: string
    arxiv?: string
    url?: string
    /** A direct full-text URL when one is known (open access PDF or arXiv). */
    pdf?: string
    abstract?: string
    citedBy?: number
    sources: string[]
    score: number
  }

  export interface SourceReport {
    source: string
    count: number
    /** Set when the source failed; `count` is then 0 and the search continues without it. */
    error?: string
    via?: string
  }

  export interface SearchResult {
    query: string
    candidates: Candidate[]
    sources: SourceReport[]
  }

  export interface SearchOptions {
    limit?: number
    since?: number
    until?: number
    sources?: string[]
    signal?: AbortSignal
  }

  export const DEFAULT_SOURCES = ["openalex", "arxiv"]

  const OPENALEX = "https://api.openalex.org/works"
  const OPENALEX_FIELDS = [
    "id",
    "doi",
    "title",
    "display_name",
    "publication_year",
    "publication_date",
    "cited_by_count",
    "abstract_inverted_index",
    "authorships",
    "primary_location",
    "best_oa_location",
    "open_access",
    "locations",
  ].join(",")

  interface Location {
    source?: { display_name?: string }
    landing_page_url?: string
    pdf_url?: string
    is_oa?: boolean
  }

  interface Work {
    id?: string
    doi?: string
    title?: string
    display_name?: string
    publication_year?: number
    publication_date?: string
    cited_by_count?: number
    abstract_inverted_index?: Record<string, number[]> | null
    authorships?: Array<{ author?: { display_name?: string } }>
    primary_location?: Location
    best_oa_location?: Location
    open_access?: { is_oa?: boolean; oa_url?: string }
    locations?: Location[]
  }

  const ARXIV_DOI = /^(?:https?:\/\/doi\.org\/)?10\.48550\/arxiv\.(.+)$/i
  const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i
  const ARXIV_ID = /^(?:arxiv:)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)$/i
  const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/\S+)$/i

  export function normalizeDOI(value?: string): string | undefined {
    const match = value?.trim().match(DOI)
    return match ? match[1].replace(/[.,;)]+$/, "").toLowerCase() : undefined
  }

  export function normalizeArxiv(value?: string): string | undefined {
    if (!value) return undefined
    const direct = value.trim().match(ARXIV_ID)?.[1] ?? value.match(ARXIV_URL)?.[1]
    return direct?.replace(/v\d+$/i, "")
  }

  function titleKey(title?: string): string | undefined {
    const key = (title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
    return key.length >= 12 ? key : undefined
  }

  function arxivOf(work: Work): string | undefined {
    const fromDoi = work.doi?.match(ARXIV_DOI)?.[1]
    if (fromDoi) return fromDoi.replace(/v\d+$/i, "")
    const urls = [work.primary_location, work.best_oa_location, ...(work.locations ?? [])].flatMap((l) =>
      l ? [l.landing_page_url, l.pdf_url] : [],
    )
    for (const url of urls) {
      const found = url?.match(ARXIV_URL)?.[1]
      if (found) return found.replace(/v\d+$/i, "")
    }
    return undefined
  }

  function fromWork(work: Work): Candidate {
    const arxivId = arxivOf(work)
    const doi = normalizeDOI(work.doi)
    const pdf =
      work.best_oa_location?.pdf_url ??
      work.primary_location?.pdf_url ??
      (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined) ??
      work.open_access?.oa_url
    return {
      title: work.display_name ?? work.title ?? "Untitled",
      authors: (work.authorships ?? []).map((a) => a.author?.display_name).filter((n): n is string => !!n),
      year: work.publication_year,
      date: work.publication_date,
      venue: work.primary_location?.source?.display_name,
      doi: doi && !ARXIV_DOI.test(doi) ? doi : undefined,
      arxiv: arxivId,
      url: work.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : work.id),
      pdf,
      abstract: fromInverted(work.abstract_inverted_index),
      citedBy: work.cited_by_count,
      sources: ["openalex"],
      score: 0,
    }
  }

  function fromHit(hit: ConnectorHit, source: string): Candidate {
    const extra = (hit.extra ?? {}) as Record<string, unknown>
    const str = (value: unknown) => (typeof value === "string" ? value : undefined)
    const authors = Array.isArray(extra.authors) ? extra.authors.filter((a): a is string => typeof a === "string") : []
    const arxivId = source === "arxiv" ? (normalizeArxiv(hit.id) ?? normalizeArxiv(hit.url)) : normalizeArxiv(hit.url)
    const doi = normalizeDOI(str(extra.doi)) ?? normalizeDOI(hit.id) ?? normalizeDOI(hit.url)
    const date = str(extra.published) ?? str(extra.publication_date) ?? str(extra.date)
    const year = date?.match(/^\d{4}/)?.[0]
    return {
      title: hit.title,
      authors,
      year: year ? Number(year) : undefined,
      date: date?.slice(0, 10),
      venue: str(extra.primaryCategory) ?? str(extra.venue) ?? str(extra.journal),
      doi,
      arxiv: arxivId,
      url: hit.url,
      pdf: str(extra.pdf) ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined),
      abstract: hit.summary,
      sources: [source],
      score: 0,
    }
  }

  async function openalexSearch(query: string, opts: SearchOptions): Promise<Candidate[]> {
    const per = Math.min(Math.max((opts.limit ?? 10) * 2, 5), 50)
    const filters = [
      opts.since ? `from_publication_date:${opts.since}-01-01` : undefined,
      opts.until ? `to_publication_date:${opts.until}-12-31` : undefined,
    ].filter(Boolean)
    const polite = politeParams()
    const url = [
      `${OPENALEX}?search=${encodeURIComponent(query)}`,
      `per-page=${per}`,
      `select=${OPENALEX_FIELDS}`,
      filters.length ? `filter=${filters.join(",")}` : undefined,
      polite || undefined,
    ]
      .filter(Boolean)
      .join("&")
    const data = await getJSON<{ results?: Work[] }>(url, { signal: opts.signal, retries: 1 })
    return (data.results ?? []).map(fromWork)
  }

  async function connectorSearch(source: string, query: string, opts: SearchOptions) {
    // arXiv is a default source and must work without a project instance; the
    // registry (plugins included) serves every other connector id.
    const connector = source === "arxiv" ? arxiv : (await connectorRegistry()).get(source)
    if (!connector) throw new Error(`unknown source "${source}"`)
    const hits = await connector.search(query, { limit: Math.min(opts.limit ?? 10, 25), signal: opts.signal })
    const via = hits.map((hit) => hit.extra?.via).find((v): v is string => typeof v === "string")
    return { candidates: hits.map((hit) => fromHit(hit, source)), via }
  }

  /** Merge one source's ranked list into the running union. */
  function merge(into: Candidate[], incoming: Candidate[], index: Map<string, Candidate>) {
    incoming.forEach((candidate, rank) => {
      const keys = [
        candidate.doi ? `doi:${candidate.doi}` : undefined,
        candidate.arxiv ? `arxiv:${candidate.arxiv}` : undefined,
        titleKey(candidate.title) ? `title:${titleKey(candidate.title)}` : undefined,
      ].filter((k): k is string => !!k)
      const existing = keys.map((k) => index.get(k)).find((c): c is Candidate => !!c)
      const weight = 1 / (rank + 1)
      const target = existing ?? { ...candidate, score: 0 }
      if (existing) {
        existing.sources = [...new Set([...existing.sources, ...candidate.sources])]
        existing.doi ??= candidate.doi
        existing.arxiv ??= candidate.arxiv
        existing.pdf ??= candidate.pdf
        existing.venue ??= candidate.venue
        existing.year ??= candidate.year
        existing.date ??= candidate.date
        existing.citedBy ??= candidate.citedBy
        existing.url ??= candidate.url
        if (existing.authors.length === 0) existing.authors = candidate.authors
        if ((candidate.abstract?.length ?? 0) > (existing.abstract?.length ?? 0)) existing.abstract = candidate.abstract
      } else {
        into.push(target)
      }
      target.score += weight
      for (const key of keys) index.set(key, target)
      // A merged record gains keys it did not have before (e.g. the DOI arXiv lacks).
      if (target.doi) index.set(`doi:${target.doi}`, target)
      if (target.arxiv) index.set(`arxiv:${target.arxiv}`, target)
    })
  }

  export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25)
    const sources = opts.sources?.length ? opts.sources : DEFAULT_SOURCES
    const runs = await Promise.all(
      sources.map(
        async (source): Promise<{ source: string; candidates: Candidate[]; error?: string; via?: string }> => {
          try {
            if (source === "openalex") return { source, candidates: await openalexSearch(query, opts) }
            const run = await connectorSearch(source, query, opts)
            return { source, candidates: run.candidates, via: run.via }
          } catch (error) {
            if (opts.signal?.aborted) throw error
            const failure = classifyError(error)
            const detail = [
              failure.http_status ? `HTTP ${failure.http_status}` : undefined,
              failure.endpoint ? `from ${failure.endpoint}` : undefined,
            ]
              .filter(Boolean)
              .join(" ")
            return {
              source,
              candidates: [],
              error: failure.retryable ? `rate limited${detail ? ` (${detail})` : ""}` : failure.message.slice(0, 200),
            }
          }
        },
      ),
    )
    const union: Candidate[] = []
    const index = new Map<string, Candidate>()
    for (const run of runs) merge(union, run.candidates, index)
    const inRange = (c: Candidate) =>
      (opts.since === undefined || c.year === undefined || c.year >= opts.since) &&
      (opts.until === undefined || c.year === undefined || c.year <= opts.until)
    const candidates = union
      .filter(inRange)
      .toSorted((a, b) => b.score - a.score || (b.citedBy ?? 0) - (a.citedBy ?? 0))
      .slice(0, limit)
    return {
      query,
      candidates,
      sources: runs.map((run) => ({
        source: run.source,
        count: run.candidates.length,
        error: run.error,
        via: run.via,
      })),
    }
  }

  // ── resolution ───────────────────────────────────────────────────────────

  export type Reference =
    | { kind: "arxiv"; id: string }
    | { kind: "doi"; doi: string }
    | { kind: "url"; url: string }
    | { kind: "file"; path: string }
    | { kind: "title"; title: string }

  /** Classify what the caller handed us. Files are checked against the disk. */
  export async function parseReference(raw: string, cwd?: string): Promise<Reference> {
    const value = raw.trim()
    const arxivId = normalizeArxiv(value)
    if (arxivId && (ARXIV_ID.test(value) || /arxiv\.org\//i.test(value))) return { kind: "arxiv", id: arxivId }
    const doi = normalizeDOI(value)
    if (doi) {
      const arxivFromDoi = doi.match(ARXIV_DOI)?.[1]
      return arxivFromDoi ? { kind: "arxiv", id: arxivFromDoi.replace(/v\d+$/i, "") } : { kind: "doi", doi }
    }
    if (/^https?:\/\//i.test(value)) return { kind: "url", url: value }
    const candidate = path.isAbsolute(value) ? value : cwd ? path.resolve(cwd, value) : undefined
    if (candidate) {
      const stat = await fs.stat(candidate).catch(() => undefined)
      if (stat?.isFile()) return { kind: "file", path: candidate }
    }
    if (/\s/.test(value) && value.length >= 12) return { kind: "title", title: value }
    throw new Error(
      `Unrecognized reference "${raw}". Pass a DOI (10.xxxx/...), an arXiv id (2401.00001), a URL, a local PDF path, or a paper title.`,
    )
  }

  export interface Resolved {
    reference: Reference
    /** Stable cache key derived from the identifier. */
    key: string
    title?: string
    authors?: string[]
    year?: number
    doi?: string
    arxiv?: string
    landing?: string
    abstract?: string
    /** Where the full text can be downloaded from, when open. */
    pdf?: string
    /** Set when the source has no open full text; the caller reports abstract-only. */
    closed?: string
  }

  function shortHash(value: string): string {
    return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16)
  }

  function safeKey(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "")
  }

  async function openalexWork(selector: string, signal?: AbortSignal): Promise<Work | undefined> {
    const polite = politeParams()
    const url = `${OPENALEX}/${selector}?select=${OPENALEX_FIELDS}${polite ? `&${polite}` : ""}`
    return getJSON<Work>(url, { signal, retries: 1 }).catch((error: unknown) => {
      if (error instanceof HttpStatusError && error.status === 404) return undefined
      throw error
    })
  }

  export async function resolve(reference: Reference, signal?: AbortSignal): Promise<Resolved> {
    if (reference.kind === "file") {
      return { reference, key: `local-${shortHash(reference.path)}`, title: path.basename(reference.path) }
    }
    if (reference.kind === "url") {
      return { reference, key: `url-${shortHash(reference.url)}`, landing: reference.url, pdf: reference.url }
    }
    if (reference.kind === "title") {
      const found = await search(reference.title, { limit: 3, signal })
      const best = found.candidates[0]
      if (!best) throw new Error(`No paper found for "${reference.title}".`)
      const next: Reference = best.arxiv
        ? { kind: "arxiv", id: best.arxiv }
        : best.doi
          ? { kind: "doi", doi: best.doi }
          : best.pdf
            ? { kind: "url", url: best.pdf }
            : { kind: "url", url: best.url ?? "" }
      if (next.kind === "url" && !next.url) throw new Error(`"${best.title}" has no reachable location.`)
      const resolved = await resolve(next, signal)
      return { ...resolved, title: resolved.title ?? best.title, authors: resolved.authors ?? best.authors }
    }
    if (reference.kind === "arxiv") {
      const meta = await arxiv.fetch(reference.id, { signal }).catch(() => undefined)
      const record = (meta ?? undefined) as Record<string, unknown> | undefined
      const str = (value: unknown) => (typeof value === "string" ? value : undefined)
      return {
        reference,
        key: `arxiv-${safeKey(reference.id)}`,
        title: str(record?.title),
        authors: Array.isArray(record?.authors) ? record.authors.filter((a): a is string => typeof a === "string") : [],
        year: Number(str(record?.published)?.slice(0, 4)) || undefined,
        doi: normalizeDOI(str(record?.doi)),
        arxiv: reference.id,
        landing: `https://arxiv.org/abs/${reference.id}`,
        abstract: str(record?.summary),
        pdf: `https://arxiv.org/pdf/${reference.id}`,
      }
    }
    const work = await openalexWork(`doi:${reference.doi}`, signal)
    const candidate = work ? fromWork(work) : undefined
    const arxivId = candidate?.arxiv
    const pdf = arxivId ? `https://arxiv.org/pdf/${arxivId}` : candidate?.pdf
    return {
      reference,
      key: `doi-${safeKey(reference.doi)}`,
      title: candidate?.title,
      authors: candidate?.authors,
      year: candidate?.year,
      doi: reference.doi,
      arxiv: arxivId,
      landing: candidate?.url ?? `https://doi.org/${reference.doi}`,
      abstract: candidate?.abstract,
      pdf,
      closed: pdf
        ? undefined
        : work
          ? "OpenAlex lists no open-access copy for this DOI"
          : "OpenAlex has no record for this DOI, so no open-access copy is known",
    }
  }

  // ── extraction ───────────────────────────────────────────────────────────

  export interface Extracted {
    pages: string[]
    chars: number
    tool: "pdftotext" | "pymupdf"
  }

  /** Which PDF text extractor this machine offers, if any. */
  export async function extractor(): Promise<Extracted["tool"] | undefined> {
    if (Bun.which("pdftotext")) return "pdftotext"
    const python = Bun.which("python3") ?? Bun.which("python")
    if (!python) return undefined
    const probe = Bun.spawn([python, "-c", "import fitz"], { stdout: "ignore", stderr: "ignore" })
    return (await probe.exited) === 0 ? "pymupdf" : undefined
  }

  const PYMUPDF = [
    "import sys, fitz",
    "doc = fitz.open(sys.argv[1])",
    "sys.stdout.write('\\f'.join(page.get_text() for page in doc))",
  ].join("\n")

  export async function extract(pdf: string, signal?: AbortSignal): Promise<Extracted | undefined> {
    const tool = await extractor()
    if (!tool) return undefined
    const command =
      tool === "pdftotext"
        ? ["pdftotext", "-enc", "UTF-8", pdf, "-"]
        : [Bun.which("python3") ?? Bun.which("python") ?? "python3", "-c", PYMUPDF, pdf]
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", signal })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`${tool} failed (exit ${code}): ${stderr.trim().slice(0, 300) || "no output"}`)
    const pages = stdout.split("\f").map((page) => page.replace(/[ \t]+\n/g, "\n").trim())
    while (pages.length && !pages[pages.length - 1]) pages.pop()
    return { pages, chars: pages.reduce((sum, page) => sum + page.length, 0), tool }
  }

  /** Page-addressed passages matching a query: exact phrase first, then all terms within a window. */
  export function passages(pages: string[], query: string, opts: { limit?: number; width?: number } = {}) {
    const limit = opts.limit ?? 8
    const width = opts.width ?? 700
    const phrase = query.trim().toLowerCase()
    const terms = phrase.split(/\s+/).filter((t) => t.length > 2)
    const found: Array<{ page: number; text: string }> = []
    const push = (page: number, text: string, at: number) => {
      const start = Math.max(0, at - Math.floor(width / 3))
      const end = Math.min(text.length, start + width)
      const excerpt = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`
      if (found.some((f) => f.page === page && f.text === excerpt)) return
      found.push({ page, text: excerpt })
    }
    pages.forEach((text, index) => {
      const lower = text.toLowerCase()
      for (let at = lower.indexOf(phrase); at !== -1 && found.length < limit; at = lower.indexOf(phrase, at + width)) {
        push(index + 1, text, at)
      }
    })
    if (found.length > 0 || terms.length < 2) return found.slice(0, limit)
    pages.forEach((text, index) => {
      if (found.length >= limit) return
      const lower = text.toLowerCase()
      for (let at = 0; at < lower.length && found.length < limit; at += width) {
        const window = lower.slice(at, at + width)
        if (terms.every((term) => window.includes(term))) push(index + 1, text, at + Math.floor(width / 3))
      }
    })
    return found.slice(0, limit)
  }

  /** Text for a page range like "3-5" or "7", clipped to `maxChars`. */
  export function pageRange(pages: string[], range: string, maxChars: number) {
    const match = range.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) throw new Error(`pages must look like "3" or "3-5", got "${range}"`)
    const from = Math.max(1, Number(match[1]))
    const to = Math.min(pages.length, Number(match[2] ?? match[1]))
    if (from > pages.length) throw new Error(`The document has ${pages.length} pages; page ${from} does not exist.`)
    const out: string[] = []
    let used = 0
    for (let page = from; page <= to; page++) {
      const text = `[p.${page}]\n${pages[page - 1]}`
      if (used + text.length > maxChars) {
        out.push(text.slice(0, Math.max(0, maxChars - used)))
        return { text: out.join("\n\n"), truncated: true, from, to: page }
      }
      out.push(text)
      used += text.length + 2
    }
    return { text: out.join("\n\n"), truncated: false, from, to }
  }

  /** Leading text with page markers, clipped to `maxChars`. */
  export function head(pages: string[], maxChars: number) {
    return pageRange(pages, `1-${pages.length}`, maxChars)
  }
}
