import z from "zod"
import { Tool } from "./tool"
import { registry } from "../science/connectors"
import type { ConnectorHit } from "../science/connectors"

/**
 * Small, database-agnostic surface over the scientific connector registry.
 *
 * There are intentionally only TWO tools regardless of how many databases are
 * registered — the model picks a `db` id from `science_list_dbs` and searches
 * through `science_search`. This keeps the tool count flat as connectors grow.
 */

export const ScienceListDbsTool = Tool.define("science_list_dbs", {
  description: [
    "List the scientific databases available to search via `science_search`.",
    "Returns each database's id, name, domain, and description.",
    "Call this first to discover which `db` id to pass to `science_search`.",
  ].join("\n"),
  parameters: z.object({
    domain: z
      .string()
      .optional()
      .describe("Optional domain filter (e.g. 'chemistry', 'biology', 'literature', 'structure')"),
  }),
  async execute(params, _ctx) {
    const entries = registry.catalog().filter((e) => !params.domain || e.domain === params.domain)
    if (!entries.length) {
      return {
        title: "Scientific databases",
        output: params.domain
          ? `No databases registered for domain "${params.domain}".`
          : "No scientific databases are registered yet.",
        metadata: { count: 0, domains: [] as string[] },
      }
    }

    const byDomain = new Map<string, typeof entries>()
    for (const e of entries) {
      const list = byDomain.get(e.domain) ?? []
      list.push(e)
      byDomain.set(e.domain, list)
    }

    const sections = [...byDomain.entries()].map(([domain, list]) => {
      const rows = list.map((e) => `- **${e.id}** (${e.name}) — ${e.description}`)
      return `### ${domain}\n${rows.join("\n")}`
    })

    return {
      title: `Scientific databases (${entries.length})`,
      output: sections.join("\n\n"),
      metadata: { count: entries.length, domains: [...byDomain.keys()] },
    }
  },
})

export const ScienceSearchTool = Tool.define("science_search", {
  description: [
    "Search a scientific database registered in the connector registry.",
    "Pass a `db` id (from `science_list_dbs`) and a `query`.",
    "Returns normalized hits: id, title, summary, and URL.",
  ].join("\n"),
  parameters: z.object({
    db: z.string().describe("Database id to search (from science_list_dbs, e.g. 'uniprot', 'arxiv')"),
    query: z.string().describe("Search query in the database's native syntax"),
    limit: z.number().default(10).describe("Max results (1-50)"),
    organism: z.string().optional().describe("Optional organism/taxon filter where supported"),
  }),
  async execute(params, ctx) {
    const connector = registry.get(params.db)
    if (!connector) {
      const available = registry
        .catalog()
        .map((e) => e.id)
        .join(", ")
      return {
        title: "Unknown database",
        output: `No database "${params.db}". Available: ${available || "(none registered)"}. Use science_list_dbs.`,
        metadata: { error: "unknown_db" } as Record<string, unknown>,
      }
    }

    const limit = Math.min(Math.max(params.limit, 1), 50)
    let hits: ConnectorHit[]
    try {
      hits = await connector.search(params.query, {
        limit,
        organism: params.organism,
        signal: ctx.abort,
      })
    } catch (err) {
      // A source error is NOT the same as "no results" — surface it as an
      // actionable, degraded result instead of throwing a raw `HTTP 429` string.
      if (ctx.abort.aborted) throw err
      const message = err instanceof Error ? err.message : String(err)
      const rateLimited = /\b(429|503|408)\b/.test(message) || /rate.?limit/i.test(message)
      const guidance = rateLimited
        ? `${connector.name} is rate limiting requests. Wait a few seconds, then retry${
            connector.id === "arxiv" ? " (arXiv allows ~1 request every 3s)" : ""
          }.`
        : `${connector.name} returned an error: ${message}`
      return {
        title: `${connector.name} temporarily unavailable — ${rateLimited ? "rate limited, retry shortly" : "source error"}`,
        output: [`Could not complete the search for "${params.query}".`, guidance].join("\n"),
        metadata: {
          db: connector.id,
          count: 0,
          error: rateLimited ? "rate_limited" : "source_error",
          message,
        } as Record<string, unknown>,
      }
    }

    if (!hits.length) {
      return {
        title: `${connector.name}: ${params.query}`,
        output: `No results for "${params.query}" in ${connector.name}.`,
        metadata: { db: connector.id, count: 0 } as Record<string, unknown>,
      }
    }

    const rows = hits.map((h) => {
      const lines = [`## ${h.title}`, `**id**: ${h.id}${h.score !== undefined ? ` · score: ${h.score}` : ""}`]
      if (h.url) lines.push(`**url**: ${h.url}`)
      // Surface a direct PDF link when a connector extracted one (e.g. arXiv
      // parses its self-closing `title="pdf"` link into extra.pdf) — otherwise
      // the agent sees the record but not the full-text URL already in hand.
      const pdf = typeof h.extra?.pdf === "string" ? h.extra.pdf : undefined
      if (pdf) lines.push(`**pdf**: ${pdf}`)
      if (h.summary) lines.push(h.summary)
      return lines.join("\n")
    })

    return {
      title: `${connector.name}: ${params.query}`,
      output: [`**${connector.name}** — ${hits.length} result(s):`, "", rows.join("\n\n---\n\n")].join("\n"),
      metadata: { db: connector.id, count: hits.length } as Record<string, unknown>,
    }
  },
})

export const ScienceTools = [ScienceListDbsTool, ScienceSearchTool]

export const SCIENCE_TOOL_IDS = new Set(["science_list_dbs", "science_search"])
