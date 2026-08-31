import z from "zod"
import type { ResearchSearchInput } from "@/openscience"
import { SearchFilters } from "./search-filters"

export namespace FirecrawlSearch {
  const Result = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    snippet: z.string().optional(),
    url: z.string(),
    markdown: z.string().optional(),
    date: z.string().nullish(),
    publishedDate: z.string().nullish(),
    published_date: z.string().nullish(),
    published_at: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })

  const Response = z.object({
    success: z.boolean(),
    data: z
      .object({
        web: Result.array().optional(),
        news: Result.array().optional(),
        developer: Result.array().optional(),
      })
      .optional(),
    error: z.string().optional(),
    creditsUsed: z.number().int().nonnegative().optional(),
    warning: z.string().nullish(),
  })

  export type Result = z.infer<typeof Result>
  export type Fetch = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

  const LIMIT = 50_000
  const BODY_LIMIT = 2 * 1024 * 1024

  async function read(response: globalThis.Response, signal: AbortSignal) {
    if (Number(response.headers.get("content-length")) > BODY_LIMIT) {
      await response.body?.cancel()
      throw new Error("Firecrawl search response exceeded the 2 MB safety limit")
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Firecrawl returned an empty search response")
    const abort = () => {
      void reader.cancel().catch(() => undefined)
    }
    signal.addEventListener("abort", abort, { once: true })
    const chunks: Uint8Array[] = []
    const state = { bytes: 0 }
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        state.bytes += chunk.value.byteLength
        if (state.bytes > BODY_LIMIT) throw new Error("Firecrawl search response exceeded the 2 MB safety limit")
        chunks.push(chunk.value)
      }
      const raw = await new globalThis.Response(Buffer.concat(chunks)).json().catch(() => undefined)
      const parsed = Response.safeParse(raw)
      if (!parsed.success) throw new Error("Firecrawl returned an invalid search response")
      return parsed.data
    } finally {
      signal.removeEventListener("abort", abort)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  function normalize(result: Result) {
    const metadata = result.metadata ?? {}
    const published_at = [
      result.published_at,
      result.publishedDate,
      result.published_date,
      metadata["article:published_time"],
      metadata.publishedTime,
      metadata.publishedDate,
      metadata.datePublished,
      metadata.publicationDate,
      metadata.published_time,
      result.date,
    ]
      .map(SearchFilters.publicationDate)
      .find((date) => date !== undefined)
    return {
      ...result,
      description: result.description || result.snippet,
      published_at,
    }
  }

  function bounded(value: string | undefined, remaining: number) {
    if (!value || remaining <= 0) return undefined
    if (value.length <= remaining) return value
    const end = Math.max(0, remaining - 1)
    const unit = value.charCodeAt(end - 1)
    return `${value.slice(0, unit >= 0xd800 && unit <= 0xdbff ? end - 1 : end)}…`
  }

  function project(results: ReturnType<typeof normalize>[], content: ResearchSearchInput["content"]) {
    const state = { remaining: LIMIT, truncated: false }
    // Reserve source links and snippets before page bodies, so one large page
    // cannot consume the descriptions of every later result.
    const sources = results.flatMap((result) => {
      if (result.url.length + 130 > state.remaining) {
        state.truncated = true
        return []
      }
      state.remaining -= result.url.length + 130
      const title = bounded(result.title, Math.min(512, state.remaining))
      state.remaining -= title?.length ?? 0
      const description = bounded(result.description, Math.min(2000, state.remaining))
      state.remaining -= description?.length ?? 0
      if (title !== result.title || description !== result.description) state.truncated = true
      return [{ result, title, description }]
    })
    const projected = sources.map((source, index) => {
      const result = source.result
      const available = Math.floor(state.remaining / (sources.length - index))
      const markdown = content === "top" ? bounded(result.markdown?.trim(), available) : undefined
      state.remaining -= markdown?.length ?? 0
      const truncated = content === "top" && !!result.markdown?.trim() && markdown !== result.markdown.trim()
      if (truncated) state.truncated = true
      return {
        url: result.url,
        ...(source.title ? { title: source.title } : {}),
        ...(source.description ? { description: source.description } : {}),
        ...(markdown ? { markdown } : {}),
        ...(truncated ? { content_truncated: true } : {}),
        ...(result.published_at ? { published_at: result.published_at } : {}),
        ...(result.date ? { date: result.date.slice(0, 120) } : {}),
      }
    })
    return { results: projected, truncated: state.truncated }
  }

  export async function search(
    input: ResearchSearchInput,
    options: { key: string; signal: AbortSignal; fetch?: Fetch; baseURL?: string; timeoutMs?: number },
  ) {
    const request = options.fetch ?? globalThis.fetch
    const url = `${(options.baseURL ?? "https://api.firecrawl.dev").replace(/\/+$/, "")}/v2/search`
    const categories =
      input.source === "developer"
        ? [{ type: "developer" }]
        : input.source === "research"
          ? [{ type: "research" }]
          : undefined
    const enrich = input.mode === "deep" || input.content === "top"
    const limit = Math.min(input.limit, enrich ? 3 : 10)
    const tbs = SearchFilters.tbs(input)
    const timeoutMs = Math.max(1, options.timeoutMs ?? (input.mode === "deep" ? 60_000 : 30_000))
    const timeoutController = new AbortController()
    const timer = setTimeout(
      () =>
        timeoutController.abort(new Error(`Firecrawl search timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)),
      timeoutMs,
    )
    const signal = AbortSignal.any([options.signal, timeoutController.signal])
    const cancellation = Promise.withResolvers<never>()
    const abort = () => cancellation.reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      const parsed = await Promise.race([
        (async () => {
          signal.throwIfAborted()
          const response = await request(url, {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${options.key}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              query: input.query,
              limit,
              sources: [input.source === "news" ? "news" : "web"],
              categories,
              includeDomains: input.include_domains,
              excludeDomains: input.exclude_domains,
              ...(tbs && input.source !== "news" ? { tbs } : {}),
              timeout: timeoutMs,
              ignoreInvalidURLs: true,
              ...(enrich
                ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true, parsers: [], proxy: "basic" } }
                : {}),
            }),
            signal,
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`Firecrawl search failed with HTTP ${response.status}`)
          }
          return read(response, signal)
        })(),
        cancellation.promise,
      ])
      if (!parsed.success) throw new Error("Firecrawl search did not complete")
      const candidates =
        input.source === "news"
          ? (parsed.data?.news ?? [])
          : [...(parsed.data?.web ?? []), ...(input.source === "developer" ? (parsed.data?.developer ?? []) : [])]
      const filtered = SearchFilters.apply(candidates.map(normalize), input)
      const projection = project(filtered.results.slice(0, limit), enrich ? "top" : "snippets")
      const results = projection.results
      const enriched = results.filter((result) => result.markdown?.trim()).length
      const warnings = [
        ...filtered.warnings,
        ...(projection.truncated
          ? [
              "Some result text was truncated to the search output limit; use the source URLs to inspect complete pages.",
            ]
          : []),
        ...(parsed.warning ? [`Firecrawl: ${parsed.warning.slice(0, 1000)}`] : []),
        ...(enrich && input.limit > limit
          ? [`Page-content searches are limited to ${limit} results to bound scraping cost and response size.`]
          : []),
        ...(enrich && enriched < results.length
          ? [
              `Page content was unavailable for ${results.length - enriched} results; those entries contain search snippets only.`,
            ]
          : []),
      ]
      return {
        status: "completed" as const,
        provider: "firecrawl_byok" as const,
        funding: "byok" as const,
        ...(parsed.creditsUsed !== undefined ? { provider_credits_used: parsed.creditsUsed } : {}),
        results,
        search_details: {
          source: input.source,
          mode: input.mode,
          requested_limit: input.limit,
          effective_limit: limit,
          returned_count: results.length,
          content_requested: enrich,
          enriched_count: enriched,
          ranking: "provider" as const,
          date_filter: tbs ? ("publication_date_required" as const) : ("none" as const),
          domain_filter:
            input.include_domains?.length || input.exclude_domains?.length ? ("enforced" as const) : ("none" as const),
        },
        ...(warnings.length ? { warnings } : {}),
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    }
  }
}
