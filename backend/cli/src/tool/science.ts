import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { registry } from "../science/connectors"
import type { ConnectorHit } from "../science/connectors"
import { SessionFilesystem } from "../session/filesystem"
import { SafeFileIO } from "../file/safe-io"
import { outcomeFor, formatBytes, classifyError, safeSegment } from "../science/connectors/fetch-outcome"

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
      const rows = list.map((e) => {
        const formats = e.formats?.length ? ` · formats: ${e.formats.join(", ")}` : ""
        return `- **${e.id}** (${e.name}) — ${e.description}${formats}`
      })
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

export const ScienceFetchTool = Tool.define("science_fetch", {
  description: [
    "Retrieve one record from a scientific database by id.",
    "Pass a `db` id (from `science_list_dbs`) and the record `id` returned by `science_search`.",
    "Small records are returned inline; large ones are written to a file whose path is reported.",
    "Pass `format` to retrieve a file (e.g. 'cif', 'fasta', 'sdf') instead of a record —",
    "`science_list_dbs` reports which formats each database supports.",
  ].join("\n"),
  parameters: z.object({
    db: z.string().describe("Database id (from science_list_dbs, e.g. 'rcsb-pdb', 'uniprot')"),
    id: z.string().describe("Record id within that database (e.g. '6LU7', 'P04637')"),
    format: z
      .string()
      .optional()
      .describe("Optional file format, e.g. 'cif' | 'pdb' | 'fasta' | 'sdf'. Omit for a structured record."),
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
        metadata: { error: "unknown_db", truncated: false } as Record<string, unknown>,
      }
    }

    const format = params.format?.trim().toLowerCase()
    if (format && !connector.formats?.includes(format)) {
      const supported = connector.formats?.length
        ? `Supported formats: ${connector.formats.join(", ")}.`
        : `${connector.name} serves records only — omit \`format\`.`
      return {
        title: `${connector.name}: unsupported format`,
        output: [`${connector.name} cannot serve "${format}".`, supported].join("\n"),
        metadata: { db: connector.id, error: "unsupported_format", truncated: false } as Record<string, unknown>,
      }
    }

    let payload: unknown
    try {
      payload =
        format && connector.fetchFile
          ? (await connector.fetchFile(params.id, format, { signal: ctx.abort })).body
          : await connector.fetch(params.id, { signal: ctx.abort })
    } catch (err) {
      if (ctx.abort.aborted) throw err
      const { retryable: rateLimited, message } = classifyError(err)
      const guidance = rateLimited
        ? `${connector.name} is rate limiting requests. Wait a few seconds, then retry.`
        : `${connector.name} returned an error: ${message}`
      return {
        title: `${connector.name} temporarily unavailable — ${rateLimited ? "rate limited, retry shortly" : "source error"}`,
        output: [`Could not retrieve "${params.id}".`, guidance].join("\n"),
        metadata: {
          db: connector.id,
          count: 0,
          error: rateLimited ? "rate_limited" : "source_error",
          message,
          truncated: false,
        } as Record<string, unknown>,
      }
    }

    const outcome = outcomeFor({ db: connector.id, id: params.id, format, payload })

    if (outcome.kind === "miss")
      return {
        title: `${connector.name}: no record for ${params.id}`,
        output: `${connector.name} has no record "${params.id}" (${outcome.note}).`,
        metadata: { db: connector.id, count: 0, truncated: false } as Record<string, unknown>,
      }

    if (outcome.kind === "error")
      return {
        title: `${connector.name}: ${outcome.message}`,
        output: `${connector.name} could not serve "${params.id}": ${outcome.message}`,
        metadata: {
          db: connector.id,
          count: 0,
          error: "source_error",
          message: outcome.message,
          truncated: false,
        } as Record<string, unknown>,
      }

    if (outcome.disposition === "inline")
      return {
        title: `${connector.name}: ${params.id}`,
        output: outcome.body,
        metadata: {
          db: connector.id,
          count: 1,
          bytes: outcome.bytes,
          disposition: "inline",
          truncated: false,
        } as Record<string, unknown>,
      }

    const workspace = await SessionFilesystem.workspace(ctx.sessionID)
    const relative = `science-${safeSegment(connector.id)}-${path.basename(outcome.filename)}`
    const requested = path.join(workspace, relative)
    const target = (await SessionFilesystem.authorize({ sessionID: ctx.sessionID, path: requested, access: "write" }))
      .path
    const existing = await SafeFileIO.optional(target)
    const bytes = Buffer.from(outcome.body)
    if (existing && !existing.bytes.equals(bytes)) {
      throw new Error(`Refusing to replace the existing session file ${relative}; read or rename it first`)
    }
    if (!existing) await SafeFileIO.write(target, bytes)

    return {
      title: `${connector.name}: ${params.id} → ${outcome.filename}`,
      output: [
        `${connector.name} record "${params.id}" is ${formatBytes(outcome.bytes)} — written to disk rather than inlined.`,
        ``,
        `**path**: ${relative}`,
        `**summary**: ${outcome.summary}`,
        ``,
        `Read that path for the full content.`,
      ].join("\n"),
      metadata: {
        db: connector.id,
        count: 1,
        bytes: outcome.bytes,
        disposition: "spill",
        path: relative,
        truncated: false,
      } as Record<string, unknown>,
    }
  },
})

export const ScienceTools = [ScienceListDbsTool, ScienceSearchTool, ScienceFetchTool]

export const SCIENCE_TOOL_IDS = new Set(["science_list_dbs", "science_search", "science_fetch"])
