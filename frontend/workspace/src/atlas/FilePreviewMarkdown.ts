/**
 * GitHub READMEs commonly wrap a hero in `<div align="center">`. CommonMark
 * parsers treat everything inside that HTML block as literal text, which leaves
 * badges and links unreadable in a preview. Extract only this finite, leading
 * alignment form; FilePreview sends both pieces through the same sanitized
 * Markdown renderer as every other document.
 */
export function splitAlignedMarkdown(text: string): {
  lead?: { alignment: "left" | "center" | "right"; text: string }
  rest: string
} {
  const match = /^\s*<div\s+align=["'](left|center|right)["']\s*>\s*([\s\S]*?)\s*<\/div>\s*/i.exec(text)
  if (!match) return { rest: text }
  const alignment = match[1]?.toLowerCase()
  if (alignment !== "left" && alignment !== "center" && alignment !== "right") return { rest: text }
  // The native desktop Markdown parser keeps one-line image links that follow
  // an HTML spacer as text. Strip that presentation-only spacer, and insert a
  // blank line between consecutive badge links so every parser sees complete
  // paragraphs. The original source remains untouched in Edit mode.
  const escapeAttribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;")
  const badgeLine = /^\s*\[!\[([^\]\r\n]*)\]\((\S+)\)\]\((\S+)\)\s*$/
  const lines = (match[2] ?? "").replace(/^\s*<br\s*\/?>\s*$/gim, "").split(/\r?\n/)
  const normalized: string[] = []
  let badges: string[] = []
  const flushBadges = () => {
    if (!badges.length) return
    // The desktop Markdown parser does not recognize linked-image Markdown.
    // Emit its finite badge form as HTML, then let the shared Markdown renderer
    // run DOMPurify and the existing image resolver over it as usual.
    normalized.push(`<p class="atlas-file-badges">${badges.join("\n")}</p>`)
    badges = []
  }
  for (const line of lines) {
    const badge = badgeLine.exec(line)
    if (badge) {
      const [, alt = "", src = "", href = ""] = badge
      badges.push(
        `<a href="${escapeAttribute(href)}"><img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"></a>`,
      )
      continue
    }
    flushBadges()
    normalized.push(line)
  }
  flushBadges()
  const lead = normalized.join("\n")
  return {
    lead: { alignment, text: lead.trim() },
    rest: text.slice(match[0].length),
  }
}
