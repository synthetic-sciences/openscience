import { createMemo, For, Show } from "solid-js"
import { BasicTool } from "./basic-tool"
import { Markdown } from "./markdown"
import { toolOutcome } from "./tool-display"
import type { ToolProps } from "./tool-registry"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function link(value: unknown) {
  const url = text(value)
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url
  } catch {
    return
  }
}

function warning(value: string) {
  const known: Record<string, string> = {
    search_publication_date_unknown_excluded:
      "Results without a known publication date were excluded by the date filter.",
    search_publication_dates_provider_reported_not_verified:
      "Publication dates are reported by the search provider and have not been independently verified.",
    search_enrichment_result_limit: "Page text was requested for only a limited number of results.",
    search_content_unavailable: "Page text could not be retrieved for some results.",
    managed_search_x_content_excluded: "Results from X were excluded by managed search.",
  }
  return known[value] ?? value.replaceAll("_", " ")
}

export function researchSearchResult(output: string | undefined, metadata: Record<string, unknown>) {
  const data = (() => {
    try {
      return record(JSON.parse(output ?? ""))
    } catch {
      return
    }
  })()
  const unavailable =
    metadata.stopReason === "search_unavailable" ||
    metadata.stopReason === "search_output_unavailable" ||
    data?.type === "search_unavailable" ||
    data?.type === "search_output_unavailable"
  const results = Array.isArray(data?.results)
    ? data.results.flatMap((item: unknown) => {
        const result = record(item)
        if (!result) return []
        const url = link(result.url)
        const title = text(result.title) ?? text(result.url) ?? "Untitled search result"
        return [
          {
            title,
            url,
            snippet: text(result.snippet) ?? text(result.description),
            content: text(result.markdown) ?? text(result.content),
          },
        ]
      })
    : undefined
  return {
    unavailable,
    message: text(data?.message),
    results,
    warnings: Array.isArray(data?.warnings) ? data.warnings.flatMap((value: unknown) => text(value) ?? []) : [],
  }
}

export function ResearchSearchTool(props: ToolProps) {
  const result = createMemo(() => researchSearchResult(props.output, props.metadata))
  const failed = () => props.status === "error" || result().unavailable
  const title = () => {
    if (toolOutcome(props.status, props.error) === "cancelled") return "Research search cancelled"
    if (failed()) return "Research search unavailable"
    if (props.status !== "completed") return "Searching sources"
    const count = result().results?.length
    if (count === undefined) return "Research search"
    return count === 0 ? "No results returned" : `Found ${count} ${count === 1 ? "source" : "sources"}`
  }
  return (
    <BasicTool
      {...props}
      icon="magnifying-glass-menu"
      status={failed() ? "error" : props.status}
      error={
        props.error ??
        (result().unavailable ? (result().message ?? "The search provider did not return usable results.") : undefined)
      }
      trigger={{ title: title(), subtitle: text(props.input.query) }}
    >
      <div data-component="research-search-results">
        <For each={result().results}>
          {(source) => (
            <div data-slot="search-result">
              <Show when={source.url} fallback={<span>{source.title}</span>}>
                {(url) => (
                  <a href={url()} target="_blank" rel="noopener noreferrer">
                    {source.title}
                  </a>
                )}
              </Show>
              <Show when={source.snippet}>
                {(snippet) => (
                  <Show when={snippet().length > 400} fallback={<Markdown text={snippet()} />}>
                    <details data-slot="search-excerpt">
                      <summary>Search excerpt</summary>
                      <Markdown text={snippet()} />
                    </details>
                  </Show>
                )}
              </Show>
              <Show when={source.content}>
                {(content) => (
                  <details>
                    <summary>Retrieved page text</summary>
                    <Markdown text={content()} />
                  </details>
                )}
              </Show>
            </div>
          )}
        </For>
        <Show when={result().warnings.length}>
          <div data-slot="search-warnings">
            <For each={result().warnings}>{(value) => <p>{warning(value)}</p>}</For>
          </div>
        </Show>
        <Show when={props.output}>
          <details data-slot="search-response-details">
            <summary>Search details</summary>
            <pre>{props.output}</pre>
          </details>
        </Show>
      </div>
    </BasicTool>
  )
}
