import z from "zod"
import type { ResearchSearchInput } from "@/openscience"

export namespace SearchFilters {
  export const Date = z
    .string()
    .date("Use a valid calendar date in YYYY-MM-DD format")
    .refine((value) => !value.startsWith("0000-"), "Use a year between 0001 and 9999")

  type Result = {
    url: string
    published_at?: string
  }

  // Only explicit absolute dates are evidence for a requested publication range.
  // Do not infer publication from URL paths, snippets, crawl dates, or relative ages.
  export function publicationDate(value: unknown): string | undefined {
    if (typeof value !== "string") return
    const date = value.trim()
    if (Date.safeParse(date).success) return date
    if (
      !/^\d{4}-\d{2}-\d{2}[Tt ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(
        date,
      )
    )
      return
    const day = date.slice(0, 10)
    if (Date.safeParse(day).success) return day
  }

  export function tbs(input: ResearchSearchInput) {
    const after = input.published_after && Date.parse(input.published_after)
    const before = input.published_before && Date.parse(input.published_before)
    if (after && before && after > before) throw new Error("published_after must not be later than published_before")
    if (!after && !before) return
    const format = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`
    return [
      "cdr:1",
      ...(after ? [`cd_min:${format(after)}`] : []),
      ...(before ? [`cd_max:${format(before)}`] : []),
    ].join(",")
  }

  function domain(value: string) {
    return new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, "")
  }

  export function apply<T extends Result>(results: T[], input: ResearchSearchInput) {
    const include = input.include_domains?.map(domain) ?? []
    const exclude = input.exclude_domains?.map(domain) ?? []
    const seen = new Set<string>()
    const removed = { domain: 0, undated: 0, date: 0, invalid: 0 }
    const filtered = results.filter((result) => {
      const url = URL.parse(result.url)
      if (
        result.url.length > 8192 ||
        !url ||
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        removed.invalid++
        return false
      }
      const host = url.hostname.toLowerCase().replace(/\.$/, "")
      const matches = (value: string) => host === value || host.endsWith(`.${value}`)
      if ((include.length && !include.some(matches)) || exclude.some(matches)) {
        removed.domain++
        return false
      }
      if (input.published_after || input.published_before) {
        const date = publicationDate(result.published_at)
        if (!date) {
          removed.undated++
          return false
        }
        if (
          (input.published_after && date < input.published_after) ||
          (input.published_before && date > input.published_before)
        ) {
          removed.date++
          return false
        }
      }
      url.hash = ""
      if (seen.has(url.href)) return false
      seen.add(url.href)
      return true
    })
    const warnings = [
      ...(removed.invalid
        ? [`Omitted ${removed.invalid} results with unsafe, invalid, or overlong HTTP(S) source URLs.`]
        : []),
      ...(removed.domain ? [`Omitted ${removed.domain} results outside the requested domain restrictions.`] : []),
      ...(removed.date ? [`Omitted ${removed.date} results outside the requested publication-date range.`] : []),
      ...(removed.undated
        ? [
            `Omitted ${removed.undated} results without an absolute provider-reported publication date; relative dates and undated pages cannot establish the requested range.`,
          ]
        : []),
      ...(input.published_after || input.published_before
        ? [
            "Date bounds are inclusive and checked against provider-reported publication dates, not independently verified publication history.",
          ]
        : []),
    ]
    return { results: filtered, warnings }
  }
}
