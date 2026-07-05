/**
 * Small, dependency-free helpers shared by the literature connectors.
 *
 * These cover the two recurring needs across scholarly APIs:
 *   - light XML/Atom extraction (arXiv, PubMed EFetch) without pulling in a parser
 *   - normalizing messy text (JATS/HTML abstracts, inverted indexes, snippets)
 *
 * Everything here is defensive: given odd or partial input it returns `undefined`
 * or an empty array rather than throwing.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
}

/** Decode the handful of XML/HTML entities that show up in scholarly metadata. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => ENTITIES[m] ?? m)
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ""
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

/** Strip XML/HTML tags (e.g. JATS `<jats:p>` abstracts) and collapse whitespace. */
export function stripTags(input?: string): string | undefined {
  if (!input) return undefined
  const text = decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
  return text.length ? text : undefined
}

/** Clamp a snippet to a readable length without cutting mid-word too hard. */
export function snippet(input?: string, max = 600): string | undefined {
  const text = stripTags(input)
  if (!text) return undefined
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…"
}

/** Pass a typed API record through as the connector's opaque `extra` payload. */
export function raw(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/** Reconstruct a plain abstract from OpenAlex's `abstract_inverted_index`. */
export function fromInverted(index?: Record<string, number[]> | null): string | undefined {
  if (!index) return undefined
  const words: string[] = []
  for (const word of Object.keys(index)) {
    for (const pos of index[word] ?? []) {
      if (Number.isInteger(pos) && pos >= 0) words[pos] = word
    }
  }
  const text = words
    .filter((w) => w !== undefined)
    .join(" ")
    .trim()
  return text.length ? text : undefined
}

/** Inner text of the first `<tag>…</tag>`, entity-decoded. */
export function xmlText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  if (!m) return undefined
  const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim()
  return text.length ? text : undefined
}

/** Inner text of every `<tag>…</tag>` block. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g")
  const out: string[] = []
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push(m[1])
  return out
}

/** Value of `attr` on the first `<tag …>` occurrence. */
export function xmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`).exec(xml)
  return m ? decodeEntities(m[1]) : undefined
}
