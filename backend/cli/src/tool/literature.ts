import path from "path"
import fs from "node:fs/promises"
import z from "zod"
import { Literature } from "@/research/literature"
import { SessionFilesystem } from "@/session/filesystem"
import { Tool } from "./tool"
import { WebFetchTool } from "./webfetch"
import DESCRIPTION from "./literature.txt"

const PAGE_SEPARATOR = "\f"
const ABSTRACT_ONLY_CHARS_PER_PAGE = 300
// Enough for an abstract, introduction and method overview in one reading;
// `pages` and `query` address the rest without a second download.
const MAX_CHARS = 12_000

function authorLine(authors: string[] | undefined) {
  if (!authors?.length) return undefined
  const surnames = authors.map((name) => name.split(",")[0].trim().split(/\s+/).pop() ?? name)
  return surnames.length > 3 ? `${surnames.slice(0, 3).join(", ")}, et al.` : surnames.join(", ")
}

function clip(text: string | undefined, max: number) {
  if (!text) return undefined
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** One candidate as a compact, citable block. */
function renderCandidate(candidate: Literature.Candidate, index: number) {
  const ids = [
    candidate.doi ? `doi:${candidate.doi}` : undefined,
    candidate.arxiv ? `arXiv:${candidate.arxiv}` : undefined,
  ].filter(Boolean)
  const head = [
    `${index + 1}. **${clip(candidate.title, 200)}**${candidate.year ? ` (${candidate.year})` : ""}`,
    authorLine(candidate.authors),
    candidate.venue,
    candidate.citedBy !== undefined ? `cited ${candidate.citedBy}` : undefined,
  ]
    .filter(Boolean)
    .join(" — ")
  const line = [
    ids.length ? ids.join(" · ") : undefined,
    candidate.pdf ? "full text: open" : "full text: not open",
    `via ${candidate.sources.join(", ")}`,
    candidate.url,
  ]
    .filter(Boolean)
    .join(" · ")
  const abstract = clip(candidate.abstract, 420)
  return [head, `   ${line}`, abstract ? `   ${abstract}` : undefined].filter(Boolean).join("\n")
}

interface Cached {
  pages: string[]
  pdf?: string
  text: string
  kind: "pdf" | "webpage" | "local"
}

async function readCache(dir: string, key: string): Promise<Cached | undefined> {
  const text = path.join(dir, `${key}.txt`)
  const meta = path.join(dir, `${key}.json`)
  const body = await Bun.file(text)
    .text()
    .catch(() => undefined)
  if (body === undefined) return undefined
  const info = (await Bun.file(meta)
    .json()
    .catch(() => ({}))) as { pdf?: string; kind?: Cached["kind"] }
  return { pages: body.split(PAGE_SEPARATOR), pdf: info.pdf, text, kind: info.kind ?? "pdf" }
}

async function writeCache(dir: string, key: string, value: { pages: string[]; pdf?: string; kind: Cached["kind"] }) {
  await fs.mkdir(dir, { recursive: true })
  const text = path.join(dir, `${key}.txt`)
  await Bun.write(text, value.pages.join(PAGE_SEPARATOR))
  await Bun.write(
    path.join(dir, `${key}.json`),
    JSON.stringify({ pdf: value.pdf, kind: value.kind, pages: value.pages.length, at: new Date().toISOString() }),
  )
  return text
}

/**
 * Download through the WebFetch tool so the network allow-list, the webfetch
 * permission and the brokered write contract all apply exactly as they would
 * for a model-issued fetch. A binary response is brokered to a fresh file at
 * the workspace root, which is then moved into the paper cache; an HTML
 * response comes back inline as Markdown and is kept as page text.
 */
async function download(url: string, key: string, dir: string, ctx: Tool.Context) {
  const web = await WebFetchTool.init()
  const result = await web.execute({ url, format: "markdown", timeout: 120 }, ctx)
  const info = (result.metadata as { download?: { path?: string; contentType?: string } }).download
  if (!info?.path) return { kind: "webpage" as const, text: result.output }
  // The broker reports the file relative to the session workspace root.
  const staged = path.isAbsolute(info.path) ? info.path : path.join(path.dirname(dir), info.path)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${key}.pdf`)
  await fs.rename(staged, target).catch(async () => {
    await fs.copyFile(staged, target)
    await fs.unlink(staged).catch(() => {})
  })
  return { kind: "pdf" as const, path: target, contentType: info.contentType }
}

export const LiteratureTool = Tool.define("literature", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(["search", "read"]),
    query: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("search: topic or question. read: phrase to locate; returns matching passages with page numbers."),
    ref: z.string().trim().max(2000).optional().describe("read: DOI, arXiv id, URL, local PDF path, or exact title."),
    limit: z.number().int().min(1).max(25).optional().describe("search: candidates to return (default 10)."),
    since: z.number().int().min(1900).max(2100).optional().describe("search: earliest year."),
    until: z.number().int().min(1900).max(2100).optional().describe("search: latest year."),
    sources: z
      .array(z.string())
      .optional()
      .describe("search: connector ids instead of openalex + arxiv (e.g. pubmed, europepmc, biorxiv)."),
    pages: z.string().optional().describe('read: page range, e.g. "3-5".'),
  }),
  async execute(params, ctx) {
    if (params.action === "search") {
      if (!params.query) throw new Error("search needs a query")
      const result = await Literature.search(params.query, {
        limit: params.limit,
        since: params.since,
        until: params.until,
        sources: params.sources,
        signal: ctx.abort,
      })
      ctx.abort.throwIfAborted()
      const report = result.sources
        .map((s) => (s.error ? `${s.source}: ${s.error}` : `${s.source}: ${s.count}${s.via ? ` via ${s.via}` : ""}`))
        .join(" · ")
      const failed = result.sources.filter((s) => s.error)
      const allFailed = failed.length === result.sources.length
      if (!result.candidates.length) {
        return {
          title: allFailed ? "Literature search unavailable" : `Literature: ${params.query}`,
          output: [
            allFailed
              ? `Every source failed for "${params.query}" (${report}).`
              : `No candidates for "${params.query}" (${report}).`,
            allFailed
              ? "Wait out the cooldown or pass other `sources`; webfetch on a known landing page still works."
              : "Try different terms, drop the year filter, or name other `sources`.",
          ].join("\n"),
          metadata: {
            count: 0,
            sources: result.sources,
            error: allFailed ? "sources_unavailable" : undefined,
            truncated: false,
          } as Record<string, unknown>,
        }
      }
      const open = result.candidates.filter((c) => c.pdf).length
      const lines = [
        `**Literature** — ${result.candidates.length} candidate(s) for "${params.query}" (${report}; ${open} with open full text)`,
        failed.length ? `_Degraded: ${failed.map((s) => `${s.source} ${s.error}`).join("; ")}._` : undefined,
        "",
        result.candidates.map(renderCandidate).join("\n\n"),
        "",
        'Read the closest ones with action "read" (ref = DOI or arXiv id) before citing them.',
      ].filter((line): line is string => line !== undefined)
      return {
        title: `Literature: ${params.query}`,
        output: lines.join("\n"),
        metadata: {
          count: result.candidates.length,
          sources: result.sources,
          candidates: result.candidates.map((c) => ({
            title: c.title,
            year: c.year,
            doi: c.doi,
            arxiv: c.arxiv,
            url: c.url,
            pdf: c.pdf,
            sources: c.sources,
          })),
          truncated: false,
        } as Record<string, unknown>,
      }
    }

    if (!params.ref) throw new Error("read needs a ref (DOI, arXiv id, URL, local PDF path, or title)")
    const cwd = await SessionFilesystem.toolDirectory(ctx.sessionID)
    const reference = await Literature.parseReference(params.ref, cwd)
    if (reference.kind === "file" && ctx.sessionID.startsWith("ses_")) {
      await SessionFilesystem.authorize({ sessionID: ctx.sessionID, path: reference.path, access: "read" })
    }
    const resolved = await Literature.resolve(reference, ctx.abort)
    ctx.abort.throwIfAborted()
    const dir = path.join(await SessionFilesystem.workspace(ctx.sessionID), "papers")
    const maxChars = MAX_CHARS

    const heading = [
      resolved.title ? `**${clip(resolved.title, 200)}**` : `**${params.ref}**`,
      authorLine(resolved.authors),
      resolved.year ? `(${resolved.year})` : undefined,
    ]
      .filter(Boolean)
      .join(" — ")
    const ids = [
      resolved.arxiv ? `arXiv:${resolved.arxiv}` : undefined,
      resolved.doi ? `doi:${resolved.doi}` : undefined,
      resolved.landing ? resolved.landing : undefined,
    ]
      .filter(Boolean)
      .join(" · ")

    const cached = await readCache(dir, resolved.key)
    const loaded = await (async (): Promise<Cached | { kind: "closed" } | { kind: "downloaded"; pdf: string }> => {
      if (cached) return cached
      if (reference.kind === "file") {
        const extracted = await Literature.extract(reference.path, ctx.abort)
        if (!extracted) return { kind: "downloaded", pdf: reference.path }
        const text = await writeCache(dir, resolved.key, { pages: extracted.pages, pdf: reference.path, kind: "local" })
        return { kind: "local", pages: extracted.pages, pdf: reference.path, text }
      }
      if (!resolved.pdf) return { kind: "closed" }
      const got = await download(resolved.pdf, resolved.key, dir, ctx)
      ctx.abort.throwIfAborted()
      if (got.kind === "webpage") {
        const pages = [got.text]
        const text = await writeCache(dir, resolved.key, { pages, kind: "webpage" })
        return { kind: "webpage", pages, text }
      }
      const extracted = await Literature.extract(got.path, ctx.abort)
      if (!extracted) return { kind: "downloaded", pdf: got.path }
      const text = await writeCache(dir, resolved.key, { pages: extracted.pages, pdf: got.path, kind: "pdf" })
      return { kind: "pdf", pages: extracted.pages, pdf: got.path, text }
    })()
    ctx.abort.throwIfAborted()

    if (loaded.kind === "closed") {
      return {
        title: `Literature: ${resolved.title ?? params.ref} (abstract only)`,
        output: [
          heading,
          ids,
          `Status: abstract only — ${resolved.closed ?? "no open full text located"}.`,
          resolved.abstract ? `\n${resolved.abstract}` : "\nNo abstract available either.",
          `\nIf you have the PDF, pass its local path as ref. Otherwise cite only what the abstract supports.`,
        ].join("\n"),
        metadata: { status: "abstract-only", doi: resolved.doi, arxiv: resolved.arxiv, truncated: false } as Record<
          string,
          unknown
        >,
      }
    }

    if (loaded.kind === "downloaded") {
      return {
        title: `Literature: ${resolved.title ?? params.ref} (downloaded, text extraction unavailable)`,
        output: [
          heading,
          ids,
          `Status: downloaded — ${loaded.pdf}`,
          "No PDF text extractor is installed on this machine (pdftotext from poppler, or PyMuPDF for python3).",
          "Install one (macOS: `brew install poppler`; Debian/Ubuntu: `apt-get install poppler-utils`) and call read again, or open the PDF with the read tool.",
        ].join("\n"),
        metadata: { status: "downloaded", path: loaded.pdf, truncated: false } as Record<string, unknown>,
      }
    }

    const pages = loaded.pages
    const chars = pages.reduce((sum, page) => sum + page.length, 0)
    const sparse = loaded.kind !== "webpage" && pages.length > 0 && chars / pages.length < ABSTRACT_ONLY_CHARS_PER_PAGE
    const status =
      loaded.kind === "webpage"
        ? "web page text (the location served HTML, not a PDF)"
        : sparse
          ? `partial — ${chars} characters over ${pages.length} pages; likely a scanned PDF, OCR needed`
          : `full text — ${pages.length} pages, ${chars.toLocaleString()} characters`
    const body = (() => {
      if (params.query) {
        const found = Literature.passages(pages, params.query)
        if (!found.length) return { text: `No passage matches "${params.query}".`, note: undefined }
        const text = found.map((f) => `[p.${f.page}] ${f.text}`).join("\n\n")
        return { text, note: `${found.length} passage(s) matching "${params.query}"` }
      }
      if (params.pages) {
        const range = Literature.pageRange(pages, params.pages, maxChars)
        return { text: range.text, note: range.truncated ? `pages ${range.from}-${range.to}, clipped` : undefined }
      }
      const opening = Literature.head(pages, maxChars)
      return {
        text: opening.text,
        note: opening.truncated
          ? `opening ${opening.to} of ${pages.length} pages; use pages or query for the rest`
          : undefined,
      }
    })()

    return {
      title: `Literature: ${resolved.title ?? params.ref}`,
      output: [
        heading,
        ids,
        `Status: ${status}${cached ? " (cached)" : ""}`,
        `Files: ${loaded.pdf ?? "(no PDF)"} · ${loaded.text}`,
        body.note ? `Showing: ${body.note}` : undefined,
        "",
        body.text,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      metadata: {
        status: loaded.kind === "webpage" ? "webpage" : sparse ? "partial" : "full",
        pages: pages.length,
        chars,
        doi: resolved.doi,
        arxiv: resolved.arxiv,
        pdf: loaded.pdf,
        text: loaded.text,
        cached: Boolean(cached),
        truncated: false,
      } as Record<string, unknown>,
    }
  },
})
