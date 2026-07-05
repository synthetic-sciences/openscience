/**
 * DepMap (Cancer Dependency Map) connector.
 *
 * DepMap's portal exposes a public, key-free download catalogue at
 * `/portal/api/download/files` describing every released dataset (CRISPR/RNAi
 * dependencies, expression, mutations, copy-number, drug sensitivity, models…).
 * This connector searches that catalogue and returns file/dataset records.
 *
 * The portal periodically fronts its API with a bot-verification page that
 * returns HTML instead of JSON. This connector parses defensively: a non-JSON
 * body yields an empty result set rather than throwing.
 *
 * search()  → filter /portal/api/download/files table
 * fetch(id) → catalogue file whose name/url matches {id}
 */
import type { Connector, ConnectorHit } from "../types"
import { getText } from "../http"

const PORTAL = "https://depmap.org/portal"
const FILES_API = `${PORTAL}/api/download/files`

interface DepmapFile {
  releaseName?: string
  fileName?: string
  fileDescription?: string
  fileType?: string
  downloadUrl?: string
  size?: string
  taigaUrl?: string
}

interface DepmapRelease {
  releaseName?: string
  releaseGroup?: string
  releaseDate?: string
  description?: string
  citation?: string
}

interface DepmapCatalogue {
  table?: DepmapFile[]
  data?: DepmapFile[]
  releaseData?: DepmapRelease[]
}

/** Parse JSON without throwing on the HTML verification page. */
function safeParse(body: string): DepmapCatalogue | undefined {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    if (Array.isArray(parsed)) return { table: parsed as DepmapFile[] }
    if (parsed && typeof parsed === "object") return parsed as DepmapCatalogue
    return undefined
  } catch {
    return undefined
  }
}

function files(cat: DepmapCatalogue | undefined): DepmapFile[] {
  return cat?.table ?? cat?.data ?? []
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

async function catalogue(signal?: AbortSignal): Promise<DepmapCatalogue | undefined> {
  const body = await getText(FILES_API, { signal }).catch(() => "")
  return safeParse(body)
}

export const depmap: Connector = {
  id: "depmap",
  name: "DepMap",
  domain: "genomics",
  description: "Cancer Dependency Map — CRISPR/RNAi dependencies, omics, and drug-sensitivity datasets.",
  homepage: "https://depmap.org",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const needle = query.trim().toLowerCase()
    const all = files(await catalogue(opts?.signal))
    const matched = needle ? all.filter((f) => haystack(f).includes(needle)) : all
    return matched.slice(0, limit).map(toHit)
  },

  async fetch(id, opts) {
    const trimmed = id.trim().toLowerCase()
    const cat = await catalogue(opts?.signal)
    const all = files(cat)
    const match = all.find(
      (f) =>
        f.fileName?.toLowerCase() === trimmed ||
        f.downloadUrl?.toLowerCase() === trimmed ||
        f.fileName?.toLowerCase().includes(trimmed),
    )
    return match ?? { id, found: false }
  },
}
