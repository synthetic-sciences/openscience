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
      })
      .optional(),
    error: z.string().optional(),
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
    options: { key: string; signal: AbortSignal; fetch?: Fetch; baseURL?: string },
  ) {
    const request = options.fetch ?? globalThis.fetch
    const url = `${(options.baseURL ?? "https://api.firecrawl.dev").replace(/\/+$/, "")}/v2/search`
    const categories = input.source === "developer" ? [{ type: "github" }] : undefined
    const response = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        limit: input.limit,
        sources: ["web"],
        categories,
        includeDomains: input.include_domains,
        excludeDomains: input.exclude_domains,
        timeout: input.mode === "deep" ? 60_000 : 30_000,
        ignoreInvalidURLs: true,
        ...(input.content === "top" ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
      }),
      signal: options.signal,
    })
    const raw = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(`Firecrawl search failed with HTTP ${response.status}`)
    }
    const parsed = Response.parse(raw)
    if (!parsed.success) throw new Error(parsed.error || "Firecrawl search did not complete")
    const results = project(parsed.data?.web ?? [], input.content)
    const warnings = [
      ...(input.source === "web" || input.source === "developer"
        ? []
        : [`Firecrawl BYOK used general web results for the requested ${input.source} source.`]),
      ...(input.published_after || input.published_before
        ? ["Firecrawl BYOK did not enforce publication-date filters; verify dates in the cited sources."]
        : []),
    ]
    return {
      status: "completed" as const,
      provider: "firecrawl_byok" as const,
      funding: "byok" as const,
      results,
      ...(warnings.length ? { warnings } : {}),
    }
  }
}
