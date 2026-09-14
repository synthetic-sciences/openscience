/**
 * Slash tokens in the composer stay plain text (the prompt model and the
 * caret are untouched), and get their colour from the CSS Custom Highlight
 * API: `::highlight(name)` paints every range registered under `name`.
 * Browsers without the API simply show plain text.
 */

const TOKEN = /(^|[\s\u200B(])\/([a-z0-9][a-z0-9_-]*)/gi

/** Ranges covering every `/trigger` in the editor's text nodes whose trigger
 * is a known command or skill, so a path such as `/tmp/x` stays uncoloured. */
export function slashTokenRanges(root: Node, triggers: ReadonlySet<string>): Range[] {
  if (!triggers.size) return []
  const ranges: Range[] = []
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  if (!walker) return ranges
  const lower = new Set([...triggers].map((trigger) => trigger.toLowerCase()))
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ""
    TOKEN.lastIndex = 0
    for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
      if (!lower.has(match[2].toLowerCase())) continue
      const start = match.index + match[1].length
      const range = root.ownerDocument!.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + match[2].length + 1)
      ranges.push(range)
    }
  }
  return ranges
}

type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): boolean }
type HighlightConstructor = new (...ranges: AbstractRange[]) => unknown

function registry(): { highlights: HighlightRegistry; Highlight: HighlightConstructor } | undefined {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight
  if (!css?.highlights || !Highlight) return
  return { highlights: css.highlights, Highlight }
}

export function applyHighlight(name: string, ranges: Range[]) {
  const api = registry()
  if (!api) return false
  if (!ranges.length) {
    api.highlights.delete(name)
    return true
  }
  api.highlights.set(name, new api.Highlight(...ranges))
  return true
}

export function clearHighlight(name: string) {
  registry()?.highlights.delete(name)
}
