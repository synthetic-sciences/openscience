import z from "zod"
import type { ResearchSearchInput } from "@/openscience"

export namespace FirecrawlSearch {
  const Result = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().url(),
    markdown: z.string().optional(),
  })

  const Response = z.object({
    success: z.boolean(),
    data: z
      .object({
        web: Result.array().optional(),
        news: Result.array().optional(),
      })
      .optional(),
    error: z.string().optional(),
    creditsUsed: z.number().int().nonnegative().optional(),
  })

  export type Result = z.infer<typeof Result>
  export type Fetch = typeof globalThis.fetch

  const LIMIT = 50_000

  function bounded(value: string | undefined, remaining: number) {
    if (!value || remaining <= 0) return undefined
    return value.length <= remaining ? value : `${value.slice(0, Math.max(0, remaining - 1))}…`
  }

  function project(results: Result[], content: ResearchSearchInput["content"]) {
    const state = { remaining: LIMIT }
    return results.map((result) => {
      const title = bounded(result.title, state.remaining)
      state.remaining -= title?.length ?? 0
      const description = bounded(result.description, state.remaining)
      state.remaining -= description?.length ?? 0
      const markdown = content === "top" ? bounded(result.markdown, state.remaining) : undefined
      state.remaining -= markdown?.length ?? 0
      return {
        url: result.url,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(markdown ? { markdown } : {}),
      }
    })
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
    const enrich = input.mode === "deep" || (input.content === "top" && input.mode !== "fast")
    const timeoutMs = Math.max(1, options.timeoutMs ?? (input.mode === "deep" ? 60_000 : 30_000))
    const timeoutController = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Firecrawl search timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)
        timeoutController.abort(error)
        reject(error)
      }, timeoutMs)
    })
    try {
      const response = await Promise.race([
        request(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query: input.query,
            limit: Math.min(input.limit, enrich ? 3 : 10),
            sources: [input.source === "news" ? "news" : "web"],
            categories,
            includeDomains: input.include_domains,
            excludeDomains: input.exclude_domains,
            timeout: timeoutMs,
            ignoreInvalidURLs: true,
            ...(enrich
              ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true, parsers: [], proxy: "basic" } }
              : {}),
          }),
          signal: AbortSignal.any([options.signal, timeoutController.signal]),
        }),
        timeout,
      ])
      const raw = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(`Firecrawl search failed with HTTP ${response.status}`)
      }
      const parsed = Response.parse(raw)
      if (!parsed.success) throw new Error(parsed.error || "Firecrawl search did not complete")
      const results = project(
        input.source === "news" ? (parsed.data?.news ?? []) : (parsed.data?.web ?? []),
        enrich ? "top" : "snippets",
      )
      const warnings = [
        ...(input.published_after || input.published_before
          ? ["Firecrawl BYOK did not enforce publication-date filters; verify dates in the cited sources."]
          : []),
      ]
      return {
        status: "completed" as const,
        provider: "firecrawl_byok" as const,
        funding: "byok" as const,
        ...(parsed.creditsUsed !== undefined ? { provider_credits_used: parsed.creditsUsed } : {}),
        results,
        ...(warnings.length ? { warnings } : {}),
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
