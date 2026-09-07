/**
 * DepMap (Cancer Dependency Map) connector.
 *
 * The supported public metadata endpoint returns CSV, including release names,
 * dates, file names and checksums. Portal-hosted download URLs may be omitted;
 * external public links remain when the catalogue supplies them. This connector
 * retrieves metadata, not the underlying datasets or verification-protected URLs.
 *
 * The portal periodically fronts its API with a bot-verification page that
 * returns HTML instead of metadata. Invalid catalogues are source failures, not
 * empty scientific results.
 *
 * search()  → filter /portal/api/no-captcha/download/files CSV
 * fetch(id) → catalogue file whose name/url matches {id}
 */
import type { Connector, ConnectorHit } from "../types"
import { getText, SourceResponseError } from "../http"

const PORTAL = "https://depmap.org/portal"
const FILES_API = `${PORTAL}/api/no-captcha/download/files`

interface DepmapFile {
  releaseName?: string
  releaseDate?: string
  fileName?: string
  fileDescription?: string
  fileType?: string
  downloadUrl?: string
  size?: string
  taigaUrl?: string
  md5Hash?: string
}

/** Strict CSV parsing: quoted release names can contain commas and newlines. */
function safeParse(body: string): DepmapFile[] | undefined {
  try {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ""
    let state: "field" | "quoted" | "closed" = "field"
    for (let index = 0; index < body.length; index++) {
      const char = body[index]
      if (index === 0 && char === "\uFEFF") continue
      if (state === "quoted") {
        if (char !== '"') cell += char
        else if (body[index + 1] === '"') {
          cell += '"'
          index++
        } else state = "closed"
        continue
      }
      if (char === "," || char === "\r" || char === "\n") {
        row.push(cell)
        cell = ""
        state = "field"
        if (char !== ",") {
          if (row.length !== 1 || row[0] !== "") rows.push(row)
          row = []
          if (char === "\r" && body[index + 1] === "\n") index++
        }
        continue
      }
      if (state === "closed") return undefined
      if (char === '"') {
        if (cell) return undefined
        state = "quoted"
      } else cell += char
    }
    if (state === "quoted") return undefined
    if (cell || row.length || state === "closed") rows.push([...row, cell])
    const header = rows.shift()
    if (!header || new Set(header).size !== header.length) return undefined
    if (!["release", "release_date", "filename"].every((name) => header.includes(name))) return undefined
    return rows.map((row) => {
      if (row.length !== header.length) throw new Error("Invalid CSV row")
      const value = (name: string) => row[header.indexOf(name)]?.trim() || undefined
      if (!value("release") || !value("filename")) throw new Error("Missing file metadata")
      return {
        releaseName: value("release"),
        releaseDate: value("release_date"),
        fileName: value("filename"),
        downloadUrl: value("url"),
        md5Hash: value("md5_hash"),
      }
    })
  } catch {
    return undefined
  }
}

function haystack(f: DepmapFile): string {
  return [f.fileName, f.fileDescription, f.releaseName, f.fileType].filter(Boolean).join(" ").toLowerCase()
}

function toHit(f: DepmapFile): ConnectorHit {
  const name = f.fileName ?? f.downloadUrl ?? "unknown"
  const summaryBits = [f.releaseName, f.fileType, f.fileDescription].filter((x): x is string => Boolean(x))
  return {
    id: name,
    title: f.fileName ? `${f.fileName}${f.releaseName ? ` (${f.releaseName})` : ""}` : name,
    summary: summaryBits.join(" · ").slice(0, 400) || undefined,
    url: f.downloadUrl ?? `${PORTAL}/download/all/`,
    extra: { ...f },
  }
}

async function catalogue(signal?: AbortSignal): Promise<DepmapFile[]> {
  const body = await getText(FILES_API, {
    signal,
    headers: { Accept: "text/csv" },
    looksValid: (value) => safeParse(value) !== undefined,
  })
  const parsed = safeParse(body)
  if (!parsed) throw new SourceResponseError("DepMap returned no valid catalogue; retry when the source is available")
  return parsed
}

export const depmap: Connector = {
  id: "depmap",
  name: "DepMap",
  domain: "genomics",
  description: "Cancer Dependency Map — released CRISPR/RNAi, omics, and drug-sensitivity dataset metadata.",
  homepage: "https://depmap.org",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const needle = query.trim().toLowerCase()
    const all = await catalogue(opts?.signal)
    const matched = needle ? all.filter((f) => haystack(f).includes(needle)) : all
    return matched.slice(0, limit).map(toHit)
  },

  async fetch(id, opts) {
    const trimmed = id.trim().toLowerCase()
    const all = await catalogue(opts?.signal)
    const match = all.find(
      (f) =>
        f.fileName?.toLowerCase() === trimmed ||
        f.downloadUrl?.toLowerCase() === trimmed ||
        f.fileName?.toLowerCase().includes(trimmed),
    )
    return match ?? { id, found: false }
  },
}
