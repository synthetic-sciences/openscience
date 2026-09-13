import z from "zod"
import path from "path"
import crypto from "node:crypto"
import { Tool } from "./tool"
import { connectorRegistry } from "../science/connectors/plugin"
import type { ConnectorHit } from "../science/connectors"
import { SessionFilesystem } from "../session/filesystem"
import { SafeFileIO } from "../file/safe-io"
import { outcomeFor, formatBytes, classifyError, safeSegment } from "../science/connectors/fetch-outcome"
import { AuthoritySignal } from "../project/authority-signal"

async function existingFile(target: string, body: string, size: number) {
  const source = await SafeFileIO.open(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (!source) return { exists: false, matches: false }
  try {
    if (source.size !== size) return { exists: true, matches: false }
    const hash = crypto.createHash("sha256")
    const reader = source.stream().getReader()
    while (true) {
      const result = await reader.read()
      if (result.done) break
      hash.update(result.value)
    }
    const expected = crypto.createHash("sha256").update(body).digest("hex")
    return { exists: true, matches: hash.digest("hex") === expected }
  } finally {
    await source.close()
  }
}

/**
 * A source failure rendered for the model: what failed, the HTTP evidence
 * (status, endpoint, attempts, requested wait) and where the same record can
 * be obtained right now. arXiv gets concrete alternatives because every
 * arXiv record is also reachable through OpenAlex and its own abs/pdf pages.
 */
function degraded(input: {
  connector: { id: string; name: string; domain: string }
  registry: Awaited<ReturnType<typeof connectorRegistry>>
  attempted: string
  err: unknown
  id?: string
}) {
  const failure = classifyError(input.err)
  const kind = failure.retryable ? "rate_limited" : "source_error"
  const evidence = [
    failure.http_status !== undefined ? `HTTP ${failure.http_status}` : undefined,
    failure.endpoint ? `from ${failure.endpoint}` : undefined,
    failure.attempts ? `after ${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"}` : undefined,
    failure.retry_after_seconds ? `source asks for a ${failure.retry_after_seconds} s wait` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
  const arxivId =
    input.connector.id === "arxiv" && input.id ? input.id.replace(/^arxiv:/i, "").replace(/v\d+$/, "") : undefined
  const alternatives = arxivId
    ? [
        `science_fetch db "openalex" id "10.48550/arXiv.${arxivId}"`,
        `webfetch https://arxiv.org/abs/${arxivId} (metadata) or https://arxiv.org/pdf/${arxivId} (full text)`,
        `literature read "${arxivId}" (cached full text)`,
      ]
    : input.connector.id === "arxiv"
      ? [`science_search db "openalex"`, `literature search (routes across sources)`]
      : input.registry
          .byDomain(input.connector.domain as never)
          .filter((c) => c.id !== input.connector.id)
          .slice(0, 4)
          .map((c) => `science_search db "${c.id}"`)
  const lines = [
    `Could not ${input.attempted} from ${input.connector.name}.`,
    failure.retryable
      ? `Rate limited${evidence ? `: ${evidence}` : ""}. ${failure.message}`
      : `${input.connector.name} returned an error${evidence ? ` (${evidence})` : ""}: ${failure.message}`,
    alternatives.length ? `Alternatives now: ${alternatives.join(" · ")}.` : undefined,
    failure.retryable
      ? "Do not retry this exact call in a loop; use an alternative or wait out the cooldown."
      : undefined,
  ].filter((line): line is string => !!line)
  return {
    title: `${input.connector.name} temporarily unavailable — ${failure.retryable ? "rate limited" : "source error"}`,
    output: lines.join("\n"),
    metadata: {
      db: input.connector.id,
      count: 0,
      error: kind,
      message: failure.message,
      http_status: failure.http_status,
      endpoint: failure.endpoint,
      attempts: failure.attempts,
      retry_after_seconds: failure.retry_after_seconds,
      truncated: false,
    } as Record<string, unknown>,
  }
}

/**
 * Small, database-agnostic surface over the scientific connector registry.
 *
 * There are intentionally only TWO tools regardless of how many databases are
 * registered — the model picks a `db` id from `science_list_dbs` and searches
 * through `science_search`. This keeps the tool count flat as connectors grow.
 */

export const ScienceListDbsTool = Tool.define("science_list_dbs", {
  description: [
    "List the scientific databases available to `science_search` and `science_fetch`: id, name, domain, description.",
    "Well-known ids (arxiv, openalex, pubmed, uniprot, rcsb-pdb) can be used directly without listing.",
  ].join("\n"),
  parameters: z.object({
    domain: z
      .string()
      .optional()
      .describe("Optional domain filter (e.g. 'chemistry', 'biology', 'literature', 'structure')"),
  }),
  async execute(params, _ctx) {
    const registry = await connectorRegistry()
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
    "Search one scientific database by `db` id (see science_list_dbs) with a `query` in its native syntax.",
    "Returns normalized hits: id, title, summary, URL.",
  ].join("\n"),
  parameters: z.object({
    db: z.string().describe("Database id to search (from science_list_dbs, e.g. 'uniprot', 'arxiv')"),
    query: z.string().describe("Search query in the database's native syntax"),
    limit: z.number().default(10).describe("Max results (1-50)"),
    organism: z.string().optional().describe("Optional organism/taxon filter where supported"),
  }),
  async execute(params, ctx) {
    const registry = await connectorRegistry()
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
      return degraded({ connector, registry, attempted: `complete the search for "${params.query}"`, err })
    }

    ctx.abort.throwIfAborted()
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
    // A connector that answered through a fallback says so once, not per hit.
    const via = hits.map((h) => h.extra?.via).find((v): v is string => typeof v === "string")
    const note = via ? `_${connector.name}'s API was unavailable; results come from ${via}._` : undefined

    return {
      title: `${connector.name}: ${params.query}`,
      output: [`**${connector.name}** — ${hits.length} result(s):`, note, "", rows.join("\n\n---\n\n")]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      metadata: { db: connector.id, count: hits.length, via } as Record<string, unknown>,
    }
  },
})

export const ScienceFetchTool = Tool.define("science_fetch", {
  description: [
    "Retrieve one record from a scientific database by id.",
    "Pass a `db` id (from `science_list_dbs`) and the record `id` returned by `science_search`.",
    "Literature records hold metadata and abstracts, not the full paper; `literature` read gets the text.",
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
    const registry = await connectorRegistry()
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
      return degraded({ connector, registry, attempted: `retrieve "${params.id}"`, err, id: params.id })
    }

    ctx.abort.throwIfAborted()
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
    const authorized = await SessionFilesystem.authorize({ sessionID: ctx.sessionID, path: requested, access: "write" })
    const authorization = await SessionFilesystem.bindAuthorization({
      sessionID: ctx.sessionID,
      access: "write",
      authorized,
    })
    using binding = {
      [Symbol.dispose]() {
        SessionFilesystem.releaseAuthorization(authorization)
      },
    }
    await AuthoritySignal.exclusive(async () => {
      ctx.abort.throwIfAborted()
      const current = await SessionFilesystem.revalidateAuthorization(authorization, {
        path: authorized.path,
        access: "write",
      })
      if (current.path !== authorized.path) throw new Error("Scientific output destination changed before saving")
      const target = current.path
      const existing = await existingFile(target, outcome.body, outcome.bytes)
      ctx.abort.throwIfAborted()
      if (existing.exists && !existing.matches) {
        throw new Error(`Refusing to replace the existing session file ${relative}; read or rename it first`)
      }
      if (!existing.exists) await SafeFileIO.write(target, outcome.body)
    })
    ctx.abort.throwIfAborted()

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
