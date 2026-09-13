import type { Connector, ConnectorHit } from "../types"
import { getJSON, getText, HttpStatusError, onResetRateLimits, SourceResponseError } from "../http"
import { politeParams } from "./openalex"
import { fromInverted, raw, snippet, xmlAttr, xmlBlocks, xmlSelfClosing, xmlText } from "./shared"

/**
 * arXiv via its Atom query API (export.arxiv.org/api), with fallbacks.
 *
 * The API returns Atom XML, not JSON, so entries are parsed with the small
 * regex helpers in ./shared. `fetch` uses the `id_list` form for exact lookup.
 *
 * export.arxiv.org answers a burst of requests with bare HTTP 429s (no
 * Retry-After) for a while. arXiv's own records remain reachable through two
 * other doors during that window: OpenAlex indexes every arXiv paper (DOI
 * 10.48550/arXiv.<id>) and the arxiv.org/abs page carries the citation
 * metadata. After one 429 the API is held for a cooldown and both operations
 * answer from those fallbacks, so a batch of parallel lookups costs one failed
 * API call instead of one per record. Hits and records produced this way carry
 * `via` so the caller can tell where the data came from.
 */

const BASE = "https://export.arxiv.org/api/query"
const ABS = "https://arxiv.org/abs/"
const OPENALEX = "https://api.openalex.org/works"

// arXiv asks for ≤ 1 request every 3s from a single client. Applied per-host so
// other literature sources fanning out in parallel are unaffected.
const RATE_LIMIT = { minIntervalMs: 3000 }
const ABS_RATE_LIMIT = { minIntervalMs: 1000, maxConcurrent: 2 }

// A limited client gets its 429 after a deliberate ~15 s stall, so retrying
// the API only doubles the wait: one attempt with a short deadline, then the
// fallbacks, and a cooldown that doubles on repeat offences.
const API_RETRIES = 0
const API_TIMEOUT_MS = 10_000
const COOLDOWN_MS = 60_000
const COOLDOWN_MAX_MS = 10 * 60_000

// Query prefixes arXiv understands. When the caller already fields their query
// (e.g. `ti:transformer AND cat:cs.LG`) we pass it through instead of wrapping
// the whole thing in `all:`, which would break the field syntax.
const FIELDED = /^(ti|au|abs|co|jr|cat|rn|id|all):/i

const cooldown = { until: 0, strikes: 0 }

/** Milliseconds until the arXiv API is tried again (0 when healthy). */
export function arxivApiCooldown(now = Date.now()): number {
  return Math.max(0, cooldown.until - now)
}

onResetRateLimits(() => {
  cooldown.until = 0
  cooldown.strikes = 0
})

function limited(): void {
  cooldown.strikes += 1
  cooldown.until = Date.now() + Math.min(COOLDOWN_MS * 2 ** (cooldown.strikes - 1), COOLDOWN_MAX_MS)
}

/** Where an arXiv record was obtained when the API itself did not answer. */
export type ArxivVia = "openalex" | "arxiv.org/abs"

interface Entry {
  id: string
  title?: string
  summary?: string
  published?: string
  updated?: string
  authors: string[]
  doi?: string
  primaryCategory?: string
  pdf?: string
  via?: ArxivVia
  raw?: string
}

/** arXiv rejected the request itself (malformed id or query); no fallback can help. */
class QueryRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArxivQueryRejected"
  }
}

function bareId(idUrl: string): string {
  return idUrl
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^arxiv:/i, "")
    .replace(/\.pdf$/i, "")
    .trim()
}

/** `1706.03762v7` → `1706.03762`; OpenAlex and the abs page key on the unversioned id. */
function unversioned(id: string): string {
  return id.replace(/v\d+$/i, "")
}

/** A genuine Atom feed opens with `<feed …>`; HTML error pages / empty bodies don't. */
function isAtomFeed(xml: string): boolean {
  return /<feed[\s>]/i.test(xml)
}

/**
 * arXiv answers a malformed query/id with HTTP 200 and a single `<entry>` whose
 * id points at `…/api/errors` and whose title is literally "Error". Those are
 * not results — surface them as an error instead of a bogus hit.
 */
function isErrorEntry(e: Entry): boolean {
  return e.id.startsWith("http://arxiv.org/api/errors") || e.title === "Error"
}

/** Wrap a bare query in `all:`; leave an already-fielded query untouched. */
function searchExpr(query: string): string {
  const q = query.trim()
  return FIELDED.test(q) ? q : `all:${q}`
}

/** Reduce an arXiv query (possibly fielded) to plain search terms for OpenAlex. */
function plainTerms(query: string): string {
  return query
    .replace(/\bcat:\S+/gi, " ")
    .replace(/\b(?:ti|au|abs|co|jr|rn|id|all):/gi, "")
    .replace(/\b(?:AND\s*NOT|ANDNOT|AND|OR)\b/g, " ")
    .replace(/["()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parse(xml: string): Entry[] {
  return xmlBlocks(xml, "entry").map((block) => {
    const id = xmlText(block, "id") ?? ""
    const authors = xmlBlocks(block, "author")
      .map((a) => xmlText(a, "name"))
      .filter((n): n is string => !!n)
    // arXiv's PDF link is self-closing: `<link title="pdf" href="…" …/>`. It has
    // no `</link>` close tag, so the paired-block helpers can't see it.
    const pdf = xmlSelfClosing(block, "link").find((l) => (l.attrs.title ?? "").toLowerCase() === "pdf")?.attrs.href
    return {
      id,
      title: xmlText(block, "title"),
      summary: xmlText(block, "summary"),
      published: xmlText(block, "published"),
      updated: xmlText(block, "updated"),
      authors,
      doi: xmlText(block, "arxiv:doi"),
      primaryCategory: xmlAttr(block, "arxiv:primary_category", "term"),
      pdf,
      raw: block,
    }
  })
}

/**
 * Fetch + validate one arXiv Atom response. Throws (rather than returning `[]`)
 * for non-Atom bodies and for arXiv's error entries, so the tool layer can tell
 * a source error apart from a genuine zero-result query.
 */
async function feed(url: string, signal?: AbortSignal): Promise<Entry[]> {
  const xml = await getText(url, {
    signal,
    rateLimit: RATE_LIMIT,
    retries: API_RETRIES,
    timeout: API_TIMEOUT_MS,
    looksValid: isAtomFeed,
  })
  if (!isAtomFeed(xml)) {
    throw new SourceResponseError(
      "arXiv returned a non-Atom response (likely rate-limited or unavailable); retry shortly.",
    )
  }
  const entries = parse(xml)
  const bad = entries.find(isErrorEntry)
  if (bad) throw new QueryRejected(`arXiv rejected the query: ${bad.summary ?? bad.title ?? "malformed request"}`)
  return entries
}

type ApiResult<T> = { ok: true; value: T } | { ok: false; error: Error }

/**
 * Run one API call unless the API is cooling down. Availability failures (429,
 * 5xx, HTML or empty bodies, network errors) come back as `ok: false` so the
 * caller can fall back; a rejected query or a caller abort propagates.
 */
async function api<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<ApiResult<T>> {
  const wait = arxivApiCooldown()
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000)
    return {
      ok: false,
      error: new HttpStatusError(429, `arXiv API answered HTTP 429 earlier; holding it for another ${seconds} s`, {
        url: BASE,
        attempts: 0,
        retryAfterMs: wait,
      }),
    }
  }
  try {
    const value = await run()
    cooldown.strikes = 0
    return { ok: true, value }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof QueryRejected) throw error
    if (error instanceof HttpStatusError) {
      if (error.status === 429) limited()
      const retryable = error.status === 429 || error.status === 408 || error.status >= 500
      if (!retryable) throw error
    }
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

function toHit(e: Entry): ConnectorHit {
  const id = bareId(e.id)
  const who = e.authors.length > 4 ? `${e.authors.slice(0, 4).join(", ")} et al.` : e.authors.join(", ")
  const meta = [who, e.primaryCategory, e.published?.slice(0, 10)].filter(Boolean).join(". ")
  return {
    id,
    title: snippet(e.title, 300) ?? id,
    summary: snippet(e.summary) ?? (meta.length ? meta : undefined),
    url: e.id || `${ABS}${id}`,
    extra: raw(e),
  }
}

// ── OpenAlex fallback ────────────────────────────────────────────────────────

interface Work {
  id?: string
  doi?: string
  title?: string
  display_name?: string
  publication_date?: string
  publication_year?: number
  cited_by_count?: number
  abstract_inverted_index?: Record<string, number[]> | null
  authorships?: Array<{ author?: { display_name?: string } }>
  primary_location?: { landing_page_url?: string; pdf_url?: string }
  best_oa_location?: { landing_page_url?: string; pdf_url?: string }
  locations?: Array<{ landing_page_url?: string; pdf_url?: string }>
}

const ARXIV_DOI = /^(?:https?:\/\/doi\.org\/)?10\.48550\/arxiv\.(.+)$/i
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i

/** Recover the arXiv id an OpenAlex work refers to, from its DOI or any arXiv location. */
function arxivIdOf(w: Work): string | undefined {
  const fromDoi = w.doi?.match(ARXIV_DOI)?.[1]
  if (fromDoi) return fromDoi
  const urls = [w.primary_location, w.best_oa_location, ...(w.locations ?? [])].flatMap((l) =>
    l ? [l.landing_page_url, l.pdf_url] : [],
  )
  for (const url of urls) {
    const found = url?.match(ARXIV_URL)?.[1]
    if (found) return found
  }
  return undefined
}

function workEntry(w: Work, id: string): Entry {
  const authors = (w.authorships ?? []).map((a) => a.author?.display_name).filter((n): n is string => !!n)
  return {
    id: `${ABS}${id}`,
    title: w.display_name ?? w.title,
    summary: fromInverted(w.abstract_inverted_index),
    published: w.publication_date ?? (w.publication_year ? String(w.publication_year) : undefined),
    authors,
    pdf: `https://arxiv.org/pdf/${id}`,
    via: "openalex",
  }
}

async function openalexRecord(id: string, signal?: AbortSignal): Promise<Entry | null> {
  const doi = `doi:10.48550/arXiv.${unversioned(id)}`
  const polite = politeParams()
  const work = await getJSON<Work>(`${OPENALEX}/${doi}${polite ? `?${polite}` : ""}`, { signal, retries: 1 }).catch(
    (error: unknown) => {
      if (error instanceof HttpStatusError && error.status === 404) return null
      throw error
    },
  )
  return work ? workEntry(work, unversioned(id)) : null
}

async function openalexSearch(query: string, max: number, signal?: AbortSignal): Promise<ConnectorHit[]> {
  const terms = plainTerms(query)
  if (!terms) return []
  const polite = politeParams()
  const url = `${OPENALEX}?search=${encodeURIComponent(terms)}&filter=indexed_in:arxiv&per-page=${max}${polite ? `&${polite}` : ""}`
  const data = await getJSON<{ results?: Work[] }>(url, { signal, retries: 1 })
  return (data.results ?? []).flatMap((w) => {
    const id = arxivIdOf(w)
    if (!id) return []
    return [toHit(workEntry(w, id))]
  })
}

// ── arxiv.org/abs fallback ───────────────────────────────────────────────────

function metaContent(html: string, name: string): string[] {
  const out: string[] = []
  const pattern = new RegExp(
    `<meta\\s+(?:[^>]*?\\s)?(?:name|property)="${name}"[^>]*?\\scontent="([^"]*)"|<meta\\s+(?:[^>]*?\\s)?content="([^"]*)"[^>]*?\\s(?:name|property)="${name}"`,
    "gi",
  )
  for (let m = pattern.exec(html); m !== null; m = pattern.exec(html)) {
    const value = (m[1] ?? m[2] ?? "").trim()
    if (value) out.push(decode(value))
  }
  return out
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

async function absRecord(id: string, signal?: AbortSignal): Promise<Entry | null> {
  const clean = unversioned(id)
  const html = await getText(`${ABS}${clean}`, {
    signal,
    allowHTML: true,
    retries: 1,
    rateLimit: ABS_RATE_LIMIT,
    looksValid: (body) => /citation_title/i.test(body),
  }).catch((error: unknown) => {
    if (error instanceof HttpStatusError && error.status === 404) return null
    throw error
  })
  if (html === null) return null
  const title = metaContent(html, "citation_title")[0]
  if (!title) throw new SourceResponseError("arxiv.org/abs returned a page without citation metadata")
  const abstract =
    metaContent(html, "citation_abstract")[0] ??
    html.match(/<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1]
  const category = html.match(/class="primary-subject"[^>]*>[^(<]*\(([^)]+)\)/i)?.[1]
  return {
    id: `${ABS}${clean}`,
    title,
    summary: abstract ? decode(abstract.replace(/<[^>]+>/g, " ").replace(/^\s*Abstract:\s*/i, "")) : undefined,
    published: metaContent(html, "citation_date")[0]?.replace(/\//g, "-"),
    authors: metaContent(html, "citation_author"),
    doi: metaContent(html, "citation_doi")[0],
    primaryCategory: category,
    pdf: metaContent(html, "citation_pdf_url")[0] ?? `https://arxiv.org/pdf/${clean}`,
    via: "arxiv.org/abs",
  }
}

/** Every route failed: keep the API's status so the tool layer can classify, and say what else was tried. */
function unavailable(apiError: Error, fallbacks: string[]): HttpStatusError {
  const status = apiError instanceof HttpStatusError ? apiError.status : 503
  const detail = apiError instanceof HttpStatusError ? apiError : undefined
  return new HttpStatusError(status, `${apiError.message} Fallbacks failed too: ${fallbacks.join("; ")}.`, {
    url: detail?.url ?? BASE,
    attempts: detail?.attempts,
    retryAfterMs: detail?.retryAfterMs,
  })
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const arxiv: Connector = {
  id: "arxiv",
  name: "arXiv",
  domain: "literature",
  description:
    "Preprint metadata and abstracts in physics, math, CS, quantitative biology, and more. Paper text must be retrieved separately from the returned PDF link.",
  homepage: "https://arxiv.org",

  async search(query, opts) {
    const max = Math.min(opts?.limit ?? 10, 50)
    const url = `${BASE}?search_query=${encodeURIComponent(searchExpr(query))}&start=0&max_results=${max}&sortBy=relevance`
    const result = await api(() => feed(url, opts?.signal), opts?.signal)
    if (result.ok) return result.value.map(toHit)
    const fallback = await openalexSearch(query, max, opts?.signal).catch((error: unknown) => {
      if (opts?.signal?.aborted) throw error
      throw unavailable(result.error, [`OpenAlex (indexed_in:arxiv) — ${reason(error)}`])
    })
    return fallback
  },

  async fetch(id, opts) {
    const clean = bareId(id)
    const result = await api(
      () => feed(`${BASE}?id_list=${encodeURIComponent(clean)}&max_results=1`, opts?.signal),
      opts?.signal,
    )
    if (result.ok) return result.value[0] ?? null
    // OpenAlex lags arXiv by a little, so a miss there is not yet a miss: the
    // abs page is the authority on whether the id exists at all.
    const failures: string[] = []
    const fromOpenAlex = await openalexRecord(clean, opts?.signal).catch((error: unknown) => {
      if (opts?.signal?.aborted) throw error
      failures.push(`OpenAlex — ${reason(error)}`)
      return null
    })
    if (fromOpenAlex) return fromOpenAlex
    const fromAbs = await absRecord(clean, opts?.signal).catch((error: unknown) => {
      if (opts?.signal?.aborted) throw error
      failures.push(`arxiv.org/abs — ${reason(error)}`)
      return undefined
    })
    if (fromAbs !== undefined) return fromAbs
    throw unavailable(result.error, failures)
  },
}
